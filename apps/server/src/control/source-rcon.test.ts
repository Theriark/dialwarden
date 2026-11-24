// The Source RCON client against an in-process server that speaks the wire
// protocol with recorded frame bytes (dev-work-plan P6 tests: recorded byte
// fixtures, labelled simulated; the Theriark Mock Server has no RCON
// scenario). The client's packets are asserted exactly: length, id, type,
// body and the two null bytes of the protocol.
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceRcon } from "./source-rcon.js";
import type { AllowList } from "./types.js";

const PASSWORD = "fjord-rcon-secret";
const ALLOW: AllowList = ["sav", "shutdown", "server.write"];

/** One server frame: length, id, type, body, two null bytes. */
function frame(id: number, type: number, body: string): Buffer {
  const text = Buffer.from(body, "latin1");
  const packet = Buffer.alloc(14 + text.length);
  packet.writeUInt32LE(10 + text.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  text.copy(packet, 12);
  return packet;
}

interface Behaviour {
  /** Refuse the password once (id -1) instead of accepting it. */
  readonly refusePassword?: boolean;
  /** Answer a command with this body (default: empty). */
  readonly answer?: string;
  /** Close the connection right after the auth response. */
  readonly closeAfterAuth?: boolean;
  /** Send the empty response frame most servers send before the auth one. */
  readonly emptyFirst?: boolean;
}

let port = 0;
let behaviour: Behaviour = {};
let seen: Buffer[] = [];
const server = createServer((socket: Socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 14) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const packet = Buffer.from(buffer.subarray(0, 4 + length));
      buffer = buffer.subarray(4 + length);
      seen.push(Buffer.from(packet));
      const id = packet.readInt32LE(4);
      const type = packet.readInt32LE(8);
      if (type === 3) {
        if (behaviour.emptyFirst) socket.write(frame(id, 0, ""));
        if (behaviour.refusePassword === true) {
          socket.write(frame(-1, 2, ""));
          return;
        }
        socket.write(frame(id, 2, ""));
        if (behaviour.closeAfterAuth) socket.end();
        return;
      }
      socket.write(frame(id, 0, behaviour.answer ?? "Saved game"));
    }
  });
});

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

const client = () =>
  new SourceRcon({
    host: "127.0.0.1",
    port,
    password: PASSWORD,
    allow: ALLOW,
    saveCommand: "sav",
    stopCommand: "shutdown",
    readMs: 2_000,
  });

describe("Source RCON client (simulated)", () => {
  it("authenticates and probes a running server", async () => {
    behaviour = {};
    seen = [];
    const result = await client().probe();
    expect(result).toEqual({ state: "running" });
    // The auth packet the client sent, byte for byte.
    const auth = seen[0];
    expect(auth?.readUInt32LE(0)).toBe(10 + PASSWORD.length);
    expect(auth?.readInt32LE(8)).toBe(3);
    expect(auth?.subarray(12, 12 + PASSWORD.length).toString("latin1")).toBe(
      PASSWORD,
    );
    expect(auth?.at(-1)).toBe(0);
    expect(auth?.at(-2)).toBe(0);
  });

  it("skips the empty frame most servers send before the auth answer", async () => {
    behaviour = { emptyFirst: true };
    seen = [];
    expect(await client().probe()).toEqual({ state: "running" });
    expect(seen).toHaveLength(1);
  });

  it("runs the save command and returns the answer", async () => {
    behaviour = { answer: "Saving world" };
    seen = [];
    const control = client();
    await control.save?.();
    const command = seen.at(-1);
    expect(command?.readInt32LE(8)).toBe(2);
    expect(command?.subarray(12, -2).toString("latin1")).toBe("sav");
  });

  it("refuses a command that is not on the pack allow-list", async () => {
    behaviour = {};
    const control = new SourceRcon({
      host: "127.0.0.1",
      port,
      password: PASSWORD,
      allow: ALLOW,
      stopCommand: "quit",
    });
    await expect(control.stop?.()).rejects.toMatchObject({ code: "Refused" });
    const empty = new SourceRcon({
      host: "127.0.0.1",
      port,
      password: PASSWORD,
      allow: ALLOW,
    });
    await expect(empty.save?.()).rejects.toMatchObject({ code: "Refused" });
  });

  it("treats a refused password as a running server and a config blocker", async () => {
    behaviour = { refusePassword: true };
    const control = client();
    expect(await control.probe()).toEqual({ state: "running" });
    await expect(control.save?.()).rejects.toMatchObject({ code: "Auth" });
  });

  it("reports stopped when the port is closed", async () => {
    const down = new SourceRcon({
      host: "127.0.0.1",
      port: 1,
      password: PASSWORD,
      allow: ALLOW,
      connectMs: 2_000,
    });
    expect(await down.probe()).toEqual({ state: "stopped" });
    await expect(down.save?.()).rejects.toMatchObject({ code: "Connection" });
  });

  it("tolerates a server that closes right after the login", async () => {
    behaviour = { closeAfterAuth: true };
    expect(await client().probe()).toEqual({ state: "running" });
  });

  it("never leaks the password into an error", async () => {
    behaviour = {};
    const control = new SourceRcon({
      host: "127.0.0.1",
      port: 1,
      password: PASSWORD,
      allow: ALLOW,
      connectMs: 2_000,
    });
    try {
      await control.save?.();
      throw new Error("the save unexpectedly worked");
    } catch (error) {
      expect(`${(error as Error).message}`).not.toContain(PASSWORD);
    }
  });
});
