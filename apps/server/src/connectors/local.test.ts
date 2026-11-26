// The Local connector (contract C4, dev-work-plan P4-A step 1 and the P4
// tests): confinement under the root (.. paths, absolute paths, symbolic
// links out of the root), atomic writes that keep mode and owner, the hash
// check and the typed errors. T1 to T4 are the threat tests of the security
// review (THE-2398): a FIFO, the descriptor check after open, denied folders
// reached through links, and a dangling link out of the root.
// eslint-disable-next-line security/detect-child-process -- mkfifo, a fixed program, for the FIFO threat test
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertOpenedInside, LocalConnector } from "./local.js";
import { ConnectorError, LIMITS, type Connector } from "./types.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

let base: string;
let root: string;
let outside: string;
let local: LocalConnector;

const text = (value: string) => new TextEncoder().encode(value);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "dialwarden-local-"));
  root = join(base, "server");
  outside = join(base, "outside");
  await mkdir(join(root, "Config"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside the root");
  await writeFile(join(root, "Config", "game.ini"), "[Game]\nName=One\n");
  local = new LocalConnector({ root, deny: [join(base, "data")] });
});

afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ConnectorError ? error.code : String(error);
  }
}

/** The promise, or a rejection once ms passed (a call that never settles). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every call of the connector that takes a path, with that path. */
function everyCall(
  connector: Connector,
  rel: string,
): (() => Promise<unknown>)[] {
  return [
    () => connector.realpath(rel),
    () => connector.stat(rel),
    () => connector.read(rel),
    () => connector.list(rel),
    () => connector.writeAtomic(rel, text("x")),
  ];
}

describe("Local connector: confinement", () => {
  it.each([
    "../outside/secret.txt",
    "Config/../../outside/secret.txt",
    "/etc/passwd",
    "..",
    "Config\\..\\..\\outside",
  ])("refuses %j on every call with PathEscape", async (rel) => {
    for (const call of everyCall(local, rel)) {
      expect(await codeOf(call())).toBe("PathEscape");
    }
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
      "outside the root",
    );
  });

  it("refuses a symbolic link to a file outside the root", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    for (const call of everyCall(local, "link.txt")) {
      expect(await codeOf(call())).toBe("PathEscape");
    }
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
      "outside the root",
    );
  });

  it("refuses a linked folder that leads out of the root", async () => {
    await symlink(outside, join(root, "linked"));
    expect(await codeOf(local.read("linked/secret.txt"))).toBe("PathEscape");
    expect(await codeOf(local.list("linked"))).toBe("PathEscape");
    expect(await codeOf(local.writeAtomic("linked/new.txt", text("x")))).toBe(
      "PathEscape",
    );
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  it("refuses a relative link that climbs out of the root", async () => {
    await symlink("../outside/secret.txt", join(root, "up.txt"));
    expect(await codeOf(local.read("up.txt"))).toBe("PathEscape");
  });

  it("follows a link that stays inside the root", async () => {
    await symlink(join(root, "Config"), join(root, "alias"));
    const read = await local.read("alias/game.ini");
    expect(read.sha256).toBe(sha("[Game]\nName=One\n"));
    expect(await local.realpath("alias/game.ini")).toBe(
      join(await realRoot(), "Config", "game.ini"),
    );
  });

  it("refuses a root that is, holds or sits inside the data folder", async () => {
    const data = join(base, "data");
    await mkdir(join(data, "inner"), { recursive: true });
    for (const candidate of [data, base, join(data, "inner")]) {
      const connector = new LocalConnector({ root: candidate, deny: [data] });
      const result = await connector.test();
      expect(result, candidate).toMatchObject({
        ok: false,
        error: "PathEscape",
      });
      expect(await codeOf(connector.read("x"))).toBe("PathEscape");
    }
  });

  it("refuses / and a relative root", async () => {
    for (const candidate of ["/", "server", "./server"]) {
      const result = await new LocalConnector({ root: candidate }).test();
      expect(result, candidate).toMatchObject({
        ok: false,
        error: "PathEscape",
      });
    }
  });

  it("answers NotFound for a root that does not exist", async () => {
    const missing = new LocalConnector({ root: join(base, "missing") });
    expect(await missing.test()).toMatchObject({
      ok: false,
      error: "NotFound",
    });
  });

  it("refuses a denied folder reached through links (T3)", async () => {
    const data = join(base, "data");
    await mkdir(join(data, "inner"), { recursive: true });
    await symlink(data, join(base, "alias"));
    await symlink("/", join(base, "up"));
    await symlink(data, join(base, "datalink"));
    const cases = [
      { root: join(base, "alias"), deny: [data] },
      { root: join(base, "up"), deny: [data] },
      { root: join(data, "inner"), deny: [join(base, "datalink")] },
      { root: `${data}/../data/inner`, deny: [data] },
    ];
    for (const { root: candidate, deny } of cases) {
      const connector = new LocalConnector({ root: candidate, deny });
      expect(await connector.test(), candidate).toMatchObject({
        ok: false,
        error: "PathEscape",
      });
      expect(await codeOf(connector.read("x")), candidate).toBe("PathEscape");
    }
  });

  it("tests a good root and names its real path", async () => {
    expect(await local.test()).toEqual({ ok: true, root: await realRoot() });
  });

  it("refuses a descriptor that reached a file outside the root (T2)", async () => {
    const real = await realRoot();
    const inside = await open(join(root, "Config", "game.ini"), "r");
    const escaped = await open(join(outside, "secret.txt"), "r");
    try {
      const checked = join(real, "Config", "game.ini");
      await expect(
        assertOpenedInside(inside, real, checked, "Config/game.ini"),
      ).resolves.toBeUndefined();
      await expect(
        assertOpenedInside(escaped, real, checked, "Config/game.ini"),
      ).rejects.toMatchObject({ code: "PathEscape" });
    } finally {
      await inside.close();
      await escaped.close();
    }
  });

  it("refuses a write whose folder is swapped for a link after the check (T2)", async () => {
    const swapped = new LocalConnector({
      root,
      beforeTempOpen: async () => {
        await rename(join(root, "Config"), join(root, "Config.real"));
        await symlink(outside, join(root, "Config"));
      },
    });
    const write = swapped.writeAtomic("Config/game.ini", text("x"));
    expect(await codeOf(write)).toBe("PathEscape");
    expect(await readdir(outside)).toEqual(["secret.txt"]);
    expect(await readdir(join(root, "Config.real"))).toEqual(["game.ini"]);
    expect(await readFile(join(root, "Config.real", "game.ini"), "utf8")).toBe(
      "[Game]\nName=One\n",
    );
  });

  it("removes nothing outside when the folder is swapped after the rename (N1)", async () => {
    await writeFile(join(outside, "game.ini"), "[Game]\nName=Other\n");
    const swapped = new LocalConnector({
      root,
      afterRename: async () => {
        await rename(join(root, "Config"), join(root, "Config.real"));
        await symlink(outside, join(root, "Config"));
      },
    });
    const write = swapped.writeAtomic("Config/game.ini", text("new"));
    expect(await codeOf(write)).toBe("PathEscape");
    expect(await readFile(join(outside, "game.ini"), "utf8")).toBe(
      "[Game]\nName=Other\n",
    );
    expect((await readdir(outside)).sort()).toEqual(["game.ini", "secret.txt"]);
    expect(await readFile(join(root, "Config.real", "game.ini"), "utf8")).toBe(
      "new",
    );
  });
});

async function realRoot(): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(root);
}

describe("Local connector: reading", () => {
  it("reads bytes with their SHA-256", async () => {
    const read = await local.read("Config/game.ini");
    expect(new TextDecoder().decode(read.bytes)).toBe("[Game]\nName=One\n");
    expect(read.sha256).toBe(sha("[Game]\nName=One\n"));
  });

  it("states size, mode, owner, group and time", async () => {
    await chmod(join(root, "Config", "game.ini"), 0o640);
    const found = await local.stat("Config/game.ini");
    const real = await stat(join(root, "Config", "game.ini"));
    expect(found).toEqual({
      size: 16,
      mode: 0o640,
      uid: real.uid,
      gid: real.gid,
      mtime: real.mtime,
      type: "file",
    });
    expect((await local.stat("Config")).type).toBe("directory");
  });

  it("answers NotFound for a missing file or folder", async () => {
    expect(await codeOf(local.read("Config/missing.ini"))).toBe("NotFound");
    expect(await codeOf(local.stat("Nope/game.ini"))).toBe("NotFound");
    expect(await codeOf(local.list("Nope"))).toBe("NotFound");
    expect(await codeOf(local.read("Config"))).toBe("NotFound");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO at once instead of waiting for a writer (T1)",
    async () => {
      const fifo = join(root, "Config", "pipe.ini");
      // eslint-disable-next-line security/detect-child-process -- mkfifo with a temporary test path
      execFileSync("mkfifo", [fifo]);
      expect(await within(codeOf(local.read("Config/pipe.ini")), 2000)).toBe(
        "NotFound",
      );
      expect((await local.stat("Config/pipe.ini")).type).toBe("other");
      const write = local.writeAtomic("Config/pipe.ini", text("x"), {
        expectedSha256: sha("x"),
      });
      expect(await within(codeOf(write), 2000)).toBe("HashMismatch");
    },
  );

  it("lists a folder by name with entry types", async () => {
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "A.txt"), "a");
    expect(await local.list("")).toEqual([
      { name: "A.txt", type: "file" },
      { name: "Config", type: "directory" },
      { name: "b.txt", type: "file" },
    ]);
  });
});

describe("Local connector: atomic writes", () => {
  const FILE = "Config/game.ini";

  it("replaces the file, keeps its mode and returns the new SHA-256", async () => {
    const path = join(root, "Config", "game.ini");
    await chmod(path, 0o640);
    const before = await stat(path);
    const hash = await local.writeAtomic(FILE, text("[Game]\nName=Two\n"), {
      expectedSha256: sha("[Game]\nName=One\n"),
    });
    expect(hash).toBe(sha("[Game]\nName=Two\n"));
    expect(await readFile(path, "utf8")).toBe("[Game]\nName=Two\n");
    const after = await stat(path);
    expect(after.mode & 0o7777).toBe(0o640);
    expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
    // The rename replaced the file (a new inode); no temp file is left.
    expect(after.ino).not.toBe(before.ino);
    expect(await readdir(join(root, "Config"))).toEqual(["game.ini"]);
  });

  it("refuses with HashMismatch when the file changed, and leaves it alone", async () => {
    const code = await codeOf(
      local.writeAtomic(FILE, text("new"), { expectedSha256: sha("old") }),
    );
    expect(code).toBe("HashMismatch");
    expect(await readFile(join(root, FILE), "utf8")).toBe("[Game]\nName=One\n");
    expect(await readdir(join(root, "Config"))).toEqual(["game.ini"]);
  });

  it("creates a new file with mode 0644 only when it must not exist yet", async () => {
    await local.writeAtomic("Config/new.ini", text("a=1\n"), {
      expectedSha256: null,
    });
    expect((await stat(join(root, "Config", "new.ini"))).mode & 0o7777).toBe(
      0o644,
    );
    const again = local.writeAtomic("Config/new.ini", text("a=2\n"), {
      expectedSha256: null,
    });
    expect(await codeOf(again)).toBe("HashMismatch");
    expect(await readFile(join(root, "Config", "new.ini"), "utf8")).toBe(
      "a=1\n",
    );
  });

  it("sets a requested mode, without set-id bits", async () => {
    await local.writeAtomic(FILE, text("x"), { mode: 0o4755 });
    expect((await stat(join(root, FILE))).mode & 0o7777).toBe(0o755);
  });

  it("refuses to write the root, a folder or a file in a missing folder", async () => {
    expect(await codeOf(local.writeAtomic("", text("x")))).toBe("PathEscape");
    expect(await codeOf(local.writeAtomic("Config", text("x")))).toBe(
      "NotFound",
    );
    expect(await codeOf(local.writeAtomic("Nope/a.ini", text("x")))).toBe(
      "NotFound",
    );
  });

  it("never writes through a dangling link out of the root (T4)", async () => {
    await symlink(
      join(outside, "new.txt"),
      join(root, "Config", "dangling.ini"),
    );
    const code = await codeOf(
      local.writeAtomic("Config/dangling.ini", text("x")),
    );
    // Either refused, or the link itself replaced inside the root.
    expect([null, "PathEscape"]).toContain(code);
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  it("refuses content over the size bound", async () => {
    const big = new Uint8Array(LIMITS.maxFileBytes + 1);
    expect(await codeOf(local.writeAtomic(FILE, big))).toBe("Connection");
    expect(await readFile(join(root, FILE), "utf8")).toBe("[Game]\nName=One\n");
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses an owner it cannot give the file, and leaves the file and no temp file",
    async () => {
      const code = await codeOf(local.writeAtomic(FILE, text("x"), { uid: 0 }));
      expect(code).toBe("Connection");
      expect(await readFile(join(root, FILE), "utf8")).toBe(
        "[Game]\nName=One\n",
      );
      expect(await readdir(join(root, "Config"))).toEqual(["game.ini"]);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "leaves no temp file when the folder is read-only",
    async () => {
      await chmod(join(root, "Config"), 0o555);
      try {
        expect(await codeOf(local.writeAtomic(FILE, text("x")))).toBe(
          "Connection",
        );
        expect(await readdir(join(root, "Config"))).toEqual(["game.ini"]);
        // P9 L1: the refused write says so, not that the file is missing.
        const refused = await local.writeAtomic(FILE, text("x")).then(
          () => null,
          (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(ConnectorError);
        expect((refused as Error).message).toContain("cannot be written");
      } finally {
        await chmod(join(root, "Config"), 0o755);
      }
    },
  );

  // P10-A G1.1: a percent-encoded .. is a file name, never a step up.
  it("G1.1 reads %2e%2e/secret as a missing file inside the root", async () => {
    expect(await codeOf(local.read("%2e%2e/secret.txt"))).toBe("NotFound");
    expect(await codeOf(local.read("%2e%2e/outside/secret.txt"))).toBe(
      "NotFound",
    );
  });

  // P9 L1: a file system that refuses new files (/proc answers ENOENT for a
  // file it does not know) is a refused write, not a missing file.
  it.skipIf(process.platform !== "linux")(
    "reports a write the file system refuses as a refused write",
    async () => {
      const proc = new LocalConnector({ root: "/proc", deny: [] });
      const refused = await proc
        .writeAtomic("dialwarden-args.txt", text("x"))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(ConnectorError);
      expect((refused as ConnectorError).code).toBe("Connection");
      expect((refused as Error).message).toContain("cannot be written");
      expect((refused as Error).message).not.toContain("does not exist");
      // A folder that is really missing stays NotFound.
      const missing = local.writeAtomic("No/Such/Folder/x.ini", text("x"));
      expect(await codeOf(missing)).toBe("NotFound");
    },
  );
});
