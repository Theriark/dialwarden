// Threat test T9 of the security review (THE-2398): an SFTP server that lies
// cannot steer the connector out of the server root. The server runs in the
// test process and answers REALPATH, LSTAT, OPEN and READDIR from a table;
// every path the connector sends is logged.
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacks } from "@dialwarden/packs-schema/node";
import type { Attributes, SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostKeyPair,
  startSshServer,
  type SshServer,
} from "../../test/ssh-server.js";
import { detectServer } from "./detect.js";
import { SftpConnector } from "./sftp.js";
import { ConnectorError } from "./types.js";

const PACKS = fileURLToPath(new URL("../../../../packs/", import.meta.url));
const packs = loadPacks(PACKS).packs;
const ROOT = "/srv/game";
const PASSWORD = "synthetic-pw-9";
const SAVES = `${ROOT}/Pal/Saved/SaveGames/0`;
const MANIFEST =
  '"AppState"\n{\n\t"appid"\t\t"2394010"\n\t"buildid"\t\t"16521234"\n}\n';
/** Entry names a lying server adds to every folder it lists. */
const LYING_NAMES = ["../../etc", "a/../../x"];

// SFTP status codes and file types (draft-ietf-secsh-filexfer-02).
const OK = 0;
const EOF = 1;
const NO_SUCH_FILE = 2;
const FAILURE = 4;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

type Entry =
  | { readonly type: "file"; readonly content: string }
  | { readonly type: "directory" | "link" };

interface Table {
  readonly files: ReadonlyMap<string, Entry>;
  /** REALPATH answers that differ from the normalised path. */
  readonly realpaths?: ReadonlyMap<string, string>;
}

function attrsOf(entry: Entry): Attributes {
  const kind =
    entry.type === "file"
      ? S_IFREG
      : entry.type === "directory"
        ? S_IFDIR
        : S_IFLNK;
  return {
    mode: kind | 0o644,
    uid: 1000,
    gid: 1000,
    size: entry.type === "file" ? Buffer.byteLength(entry.content) : 0,
    atime: 0,
    mtime: 0,
  };
}

/** A server folder: the folders, files and links of a table, by path. */
function serverOf(
  files: Record<string, string | "directory" | "link">,
): Map<string, Entry> {
  const table = new Map<string, Entry>([[ROOT, { type: "directory" }]]);
  for (const [rel, value] of Object.entries(files)) {
    const path = posix.join(ROOT, rel);
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      table.set(posix.join(ROOT, ...parts.slice(0, i)), { type: "directory" });
    }
    table.set(
      path,
      value === "directory" || value === "link"
        ? { type: value }
        : { type: "file", content: value },
    );
  }
  return table;
}

interface Logged {
  readonly kind: string;
  readonly path: string;
}

/** The SFTP side of the lying server; every path it receives is logged. */
function lyingSftp(table: Table, log: Logged[]) {
  return (sftp: SFTPWrapper) => {
    const handles = new Map<string, { path: string; listed: boolean }>();
    let next = 0;
    const handleFor = (path: string): Buffer => {
      const handle = Buffer.from(`h${next}`);
      next += 1;
      handles.set(handle.toString(), { path, listed: false });
      return handle;
    };
    const entryOf = (handle: Buffer) => {
      const open = handles.get(handle.toString());
      return open === undefined ? undefined : table.files.get(open.path);
    };
    const stat = (kind: string) => (reqId: number, path: string) => {
      log.push({ kind, path });
      const entry = table.files.get(path);
      if (entry === undefined) sftp.status(reqId, NO_SUCH_FILE);
      else sftp.attrs(reqId, attrsOf(entry));
    };
    sftp.on("REALPATH", (reqId, path) => {
      log.push({ kind: "REALPATH", path });
      const normal = path === "." ? ROOT : posix.normalize(path);
      const answer = table.realpaths?.get(normal) ?? normal;
      if (!table.files.has(answer) && !table.realpaths?.has(normal)) {
        sftp.status(reqId, NO_SUCH_FILE);
        return;
      }
      const attrs = attrsOf({ type: "directory" });
      sftp.name(reqId, [{ filename: answer, longname: answer, attrs }]);
    });
    sftp.on("LSTAT", stat("LSTAT"));
    sftp.on("STAT", stat("STAT"));
    sftp.on("OPEN", (reqId, path) => {
      log.push({ kind: "OPEN", path });
      if (table.files.get(path)?.type === "file") {
        sftp.handle(reqId, handleFor(path));
      } else {
        sftp.status(reqId, NO_SUCH_FILE);
      }
    });
    sftp.on("FSTAT", (reqId, handle) => {
      const entry = entryOf(handle);
      if (entry === undefined) sftp.status(reqId, FAILURE);
      else sftp.attrs(reqId, attrsOf(entry));
    });
    sftp.on("READ", (reqId, handle, offset, length) => {
      const entry = entryOf(handle);
      if (entry?.type !== "file") {
        sftp.status(reqId, FAILURE);
        return;
      }
      const bytes = Buffer.from(entry.content);
      if (offset >= bytes.length) sftp.status(reqId, EOF);
      else sftp.data(reqId, bytes.subarray(offset, offset + length));
    });
    sftp.on("OPENDIR", (reqId, path) => {
      log.push({ kind: "OPENDIR", path });
      if (table.files.get(path)?.type === "directory") {
        sftp.handle(reqId, handleFor(path));
      } else {
        sftp.status(reqId, NO_SUCH_FILE);
      }
    });
    sftp.on("READDIR", (reqId, handle) => {
      const open = handles.get(handle.toString());
      if (open === undefined || open.listed) {
        sftp.status(reqId, EOF);
        return;
      }
      open.listed = true;
      const prefix = `${open.path}/`;
      const children = [...table.files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
        .filter((name) => !name.includes("/"));
      const names = [...LYING_NAMES, ...children].map((name) => ({
        filename: name,
        longname: name,
        attrs: attrsOf(
          table.files.get(`${prefix}${name}`) ?? { type: "directory" },
        ),
      }));
      sftp.name(reqId, names);
    });
    sftp.on("CLOSE", (reqId, handle) => {
      handles.delete(handle.toString());
      sftp.status(reqId, OK);
    });
  };
}

let server: SshServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function lyingServer(table: Table) {
  const hostKey = hostKeyPair();
  const log: Logged[] = [];
  server = await startSshServer({
    hostKey,
    password: PASSWORD,
    sftp: lyingSftp(table, log),
  });
  const sftp = new SftpConnector({
    host: "127.0.0.1",
    port: server.port,
    username: "game",
    root: ROOT,
    auth: { method: "password", password: PASSWORD },
    pinnedFingerprint: hostKey.fingerprint,
    readyTimeoutMs: 5000,
    operationTimeoutMs: 5000,
  });
  return { sftp, log };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ConnectorError ? error.code : String(error);
  }
}

describe("a lying SFTP server (T9)", () => {
  it("cannot move a read out of the root with its realpath answer", async () => {
    const { sftp, log } = await lyingServer({
      files: serverOf({ "a.ini": "a=1\n" }),
      realpaths: new Map([[`${ROOT}/a.ini`, "/etc/passwd"]]),
    });
    try {
      expect(await codeOf(sftp.read("a.ini"))).toBe("PathEscape");
    } finally {
      await sftp.close();
    }
    expect(log.filter((entry) => entry.kind === "OPEN")).toEqual([]);
  });

  it("refuses a link the server left unresolved, for reads and writes", async () => {
    const { sftp, log } = await lyingServer({
      files: serverOf({ "link.ini": "link" }),
    });
    try {
      expect(await codeOf(sftp.read("link.ini"))).toBe("PathEscape");
      const write = sftp.writeAtomic("link.ini", new TextEncoder().encode("x"));
      expect(await codeOf(write)).toBe("PathEscape");
    } finally {
      await sftp.close();
    }
    expect(log.filter((entry) => entry.kind === "OPEN")).toEqual([]);
  });

  it("never follows listed names that climb out of a folder", async () => {
    const { sftp, log } = await lyingServer({
      files: serverOf({
        "PalServer.sh": "#!/bin/sh\n",
        "steamapps/appmanifest_2394010.acf": MANIFEST,
        "Pal/Saved/SaveGames/0/WORLD1/WorldOption.sav": "synthetic",
      }),
    });
    try {
      expect(await sftp.list("")).toEqual([
        { name: "Pal", type: "directory" },
        { name: "PalServer.sh", type: "file" },
        { name: "steamapps", type: "directory" },
      ]);
      const found = await detectServer(packs.values(), sftp);
      expect(found).toEqual([
        expect.objectContaining({ packId: "palworld", by: "appmanifest" }),
      ]);
      expect(found[0]?.warnings[0]).toContain("WorldOption.sav");
    } finally {
      await sftp.close();
    }
    const opened = log.filter((entry) => entry.kind === "OPEN");
    expect(opened.map((entry) => entry.path)).toContain(
      `${ROOT}/steamapps/appmanifest_2394010.acf`,
    );
    for (const entry of opened) {
      expect(entry.path.startsWith(`${ROOT}/`), entry.path).toBe(true);
    }
    expect(log.filter((entry) => entry.path.includes(".."))).toEqual([]);
    expect(log).toContainEqual({ kind: "OPENDIR", path: SAVES });
  });
});
