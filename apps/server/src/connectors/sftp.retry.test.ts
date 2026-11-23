// The single retry of contract C4 (code review THE-2395): a read is tried
// again once after the connection drops, a write never. ssh2-sftp-client is
// replaced by a fake whose SFTP session drops in each of the ways ssh2 does:
// the request fails before the client reports the loss, the client reports
// the loss first, or the request never answers (the operation timeout).
import type { SFTPWrapper } from "ssh2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SftpConnector } from "./sftp.js";
import { ConnectorError } from "./types.js";

/** How the open of one session answers. */
type Plan = "answers" | "fails-first" | "lost-first" | "silent" | "denied";

const fake = vi.hoisted(() => ({
  /** One plan per session, in connect order; then "answers". */
  plans: [] as string[],
  connects: 0,
  session: null as null | ((plan: string, lost: () => void) => unknown),
}));

vi.mock("ssh2-sftp-client", () => ({
  default: class {
    readonly #handlers: Record<string, (() => void) | undefined>;

    constructor(_name: string, handlers: Record<string, () => void>) {
      this.#handlers = handlers;
    }

    connect(): Promise<unknown> {
      fake.connects += 1;
      const plan = fake.plans.shift() ?? "answers";
      const lost = () => this.#handlers["close"]?.();
      return Promise.resolve(fake.session?.(plan, lost));
    }

    end(): Promise<boolean> {
      return Promise.resolve(true);
    }
  },
}));

const ROOT = "/srv";
const FILE = "/srv/a.ini";
const CONTENT = Buffer.from("a=1\n");

type Callback = (error?: unknown, value?: unknown) => void;

const status = (code: number) =>
  Object.assign(new Error(`status ${code}`), { code });

function attrs(mode: number, size: number) {
  return { mode, size, uid: 1000, gid: 1000, atime: 0, mtime: 0 };
}

/** A fake SFTP session whose opens answer as the plan says. */
function session(plan: string, lost: () => void): SFTPWrapper {
  const drop = (done: Callback) => {
    if (plan === "silent") return;
    if (plan === "denied") {
      done(status(3));
      return;
    }
    if (plan === "lost-first") lost();
    done(new Error("No response from server"));
    if (plan === "fails-first") lost();
  };
  const wrapper = {
    realpath: (path: string, done: Callback) => done(undefined, path),
    lstat: (path: string, done: Callback) => {
      if (path === ROOT) done(undefined, attrs(0o040755, 0));
      else if (path === FILE) done(undefined, attrs(0o100644, CONTENT.length));
      else done(status(2));
    },
    open: (_path: string, _flags: string, ...rest: unknown[]) => {
      const done = rest.at(-1) as Callback;
      if (plan === "answers") done(undefined, Buffer.from("h"));
      else drop(done);
    },
    fstat: (_handle: Buffer, done: Callback) =>
      done(undefined, attrs(0o100644, CONTENT.length)),
    read: (
      _handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      done: Callback,
    ) => {
      const part = CONTENT.subarray(position, position + length);
      if (part.length === 0) {
        done(status(1));
        return;
      }
      part.copy(buffer, offset);
      done(undefined, part.length);
    },
    close: (_handle: Buffer, done: Callback) => done(undefined),
  };
  return wrapper as unknown as SFTPWrapper;
}

function connector(): SftpConnector {
  return new SftpConnector({
    host: "127.0.0.1",
    port: 22,
    username: "game",
    root: ROOT,
    auth: { method: "password", password: "synthetic" },
    pinnedFingerprint: null,
    operationTimeoutMs: 100,
  });
}

function plan(...plans: Plan[]): void {
  fake.plans = [...plans];
}

beforeEach(() => {
  fake.plans = [];
  fake.connects = 0;
  fake.session = session;
});

describe("SFTP retry after a dropped connection", () => {
  it.each<Plan>(["fails-first", "lost-first", "silent"])(
    "reads again once after a drop (%s)",
    async (drop) => {
      plan(drop, "answers");
      const read = await connector().read("a.ini");
      expect(Buffer.from(read.bytes).toString()).toBe("a=1\n");
      expect(fake.connects).toBe(2);
    },
  );

  it("fails a read that drops twice, after one retry", async () => {
    plan("fails-first", "fails-first", "answers");
    await expect(connector().read("a.ini")).rejects.toMatchObject({
      code: "Connection",
    });
    expect(fake.connects).toBe(2);
  });

  it("never retries a write", async () => {
    plan("fails-first", "answers");
    const write = connector().writeAtomic("b.ini", Buffer.from("x"));
    await expect(write).rejects.toBeInstanceOf(ConnectorError);
    await expect(write).rejects.toMatchObject({ code: "Connection" });
    expect(fake.connects).toBe(1);
  });

  it("does not retry a status answer: the server is still there", async () => {
    plan("denied", "answers");
    await expect(connector().read("a.ini")).rejects.toMatchObject({
      code: "Connection",
      message: "a.ini: permission denied",
    });
    expect(fake.connects).toBe(1);
  });
});
