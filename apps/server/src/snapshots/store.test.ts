// The snapshot store (dev-work-plan P4-B step 3): content-addressed gzip
// blobs under DATA_DIR/snapshots/AB/SHA256.gz, written once, checked on
// read, recorded per server file, and measured against the 1 GB cap.
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { servers } from "../db/schema.js";
import { Store } from "../db/store.js";
import {
  SNAPSHOT_CAP_BYTES,
  SnapshotBlobError,
  SnapshotStore,
} from "./store.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

let dataDir: string;
let store: Store;

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(async () => {
  dataDir = await tempDir("dialwarden-snapshots-");
  store = new Store(dataDir);
  await store.open();
  const at = new Date().toISOString();
  store.db
    .insert(servers)
    .values({
      id: "alpha",
      name: "Alpha",
      packId: "palworld",
      os: "linux",
      connector: JSON.stringify({ kind: "local", root: "/srv/alpha" }),
      passwordEnc: null,
      demo: 0,
      createdAt: at,
      updatedAt: at,
      lastEditedAt: null,
    })
    .run();
});

afterEach(async () => {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("snapshot blobs", () => {
  it("stores bytes once under snapshots/AB/SHA256.gz", async () => {
    const snapshots = new SnapshotStore(store, dataDir);
    const text = "[Game]\nName=One\n";
    const name = await snapshots.put(bytes(text));
    expect(name).toBe(sha(text));
    expect(await snapshots.put(bytes(text))).toBe(name);
    const folder = join(dataDir, "snapshots", name.slice(0, 2));
    expect(await readdir(folder)).toEqual([`${name}.gz`]);
    const packed = await readFile(snapshots.pathOf(name));
    expect(gunzipSync(packed).toString("utf8")).toBe(text);
    expect(new TextDecoder().decode(await snapshots.get(name))).toBe(text);
  });

  it("refuses a blob that does not match its name, or is missing", async () => {
    const snapshots = new SnapshotStore(store, dataDir);
    const name = await snapshots.put(bytes("original"));
    await writeFile(snapshots.pathOf(name), Buffer.from("not gzip"));
    const read = snapshots.get(name);
    await expect(read).rejects.toBeInstanceOf(SnapshotBlobError);
    const missing = snapshots.get(sha("never stored"));
    await expect(missing).rejects.toBeInstanceOf(SnapshotBlobError);
    const escape = () => snapshots.pathOf("../../etc/passwd");
    expect(escape).toThrow(SnapshotBlobError);
  });

  it("meters the blobs on disk against the cap", async () => {
    const small = new SnapshotStore(store, dataDir, () => new Date(), 10);
    expect(small.meter()).toEqual({
      usedBytes: 0,
      capBytes: 10,
      blobs: 0,
      overCap: false,
    });
    await small.put(bytes("first version"));
    await small.put(bytes("second version"));
    await small.put(bytes("first version"));
    const meter = small.meter();
    expect(meter.blobs).toBe(2);
    expect(meter.usedBytes).toBeGreaterThan(10);
    expect(meter.overCap).toBe(true);
    const fresh = new SnapshotStore(store, dataDir);
    expect(fresh.meter().capBytes).toBe(SNAPSHOT_CAP_BYTES);
  });
});

describe("snapshot records", () => {
  it("records a server file version and finds it again", async () => {
    const snapshots = new SnapshotStore(store, dataDir);
    const record = await snapshots.record({
      serverId: "alpha",
      changeSetId: null,
      fileId: "settings",
      path: "Config/game.ini",
      kind: "import",
      bytes: bytes("A=1\n"),
    });
    expect(record).toMatchObject({
      serverId: "alpha",
      fileId: "settings",
      kind: "import",
      sha256: sha("A=1\n"),
      size: 4,
    });
    expect(snapshots.find(record.id)).toEqual(record);
    expect(snapshots.find("missing")).toBeNull();
    expect(snapshots.ofChangeSets([])).toEqual([]);
  });
});
