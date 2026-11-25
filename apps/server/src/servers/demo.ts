// The demo seed (dev-work-plan P4-B step 5, the P7 rule). When DEMO_SEED is
// true, every start adds any demo-GAME server that is still missing: a pack
// present gets a folder DEMO_SERVERS_DIR/GAME made from its synthetic
// fixtures, registered as a Local server with the slug demo-GAME. Each new
// demo server gets 3 history entries: the import of its files, one change
// made by the app, and one edit made outside the app, found by the same
// outside-edit detection a real server gets, so it can be seen on Development
// and Stage. A server that already exists is left untouched, so an upgrade
// that ships new packs adds their demo servers without a reset. On Free only
// the first three servers can be changed (contract C1), so a demo server past
// them gets the import and the outside edit but not the app's change.
//
// The fixtures are written through the Local connector (contract C4); only
// the folders are made here, because a connector writes into folders that
// exist. Demo data is synthetic, never customer data.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkValue,
  readFileValues,
  writeFileValues,
  type JsonValue,
  type Os,
  type Pack,
  type PackFile,
  type Setting,
} from "@dialwarden/packs-schema";
import { fixtureName } from "@dialwarden/packs-schema/node";
import type { ChangeSetService } from "../changes/service.js";
import type { ConnectorService } from "../connectors/service.js";
import type { Connector } from "../connectors/types.js";
import type { ServerRecord, ServerService } from "./service.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the configured demo and packs folders, and pack file paths checked by the connector */

/** The author of the demo change. */
export const DEMO_AUTHOR = "Dialwarden demo";

export interface DemoSeedOptions {
  readonly demoSeed: boolean;
  /** DEMO_SERVERS_DIR: where the demo folders go (default /demo-servers). */
  readonly demoServersDir: string;
  /** The packs folder, which holds each pack's fixtures. */
  readonly packsDir: string;
  readonly packs: ReadonlyMap<string, Pack>;
  readonly servers: ServerService;
  readonly changes: ChangeSetService;
  readonly connectors: ConnectorService;
}

/** The operating system a demo server uses: Linux when the pack has it. */
function demoOs(pack: Pack): Os {
  if (pack.os.includes("linux")) return "linux";
  return pack.os.at(0) ?? "linux";
}

function firstPath(file: PackFile, os: Os): string | undefined {
  return (os === "linux" ? file.paths.linux : file.paths.windows)?.at(0);
}

/** Writes each pack file's fixture, and the marker files, into the folder. */
async function fillFolder(
  pack: Pack,
  os: Os,
  root: string,
  packsDir: string,
  connector: Connector,
): Promise<void> {
  for (const file of pack.files) {
    const path = firstPath(file, os);
    if (path === undefined) continue;
    const fixture = join(packsDir, pack.id, "fixtures", fixtureName(file));
    const bytes = new Uint8Array(await readFile(fixture));
    await mkdir(dirname(join(root, path)), { recursive: true });
    await connector.writeAtomic(path, bytes);
  }
  for (const marker of pack.detection.markers) {
    if (marker.os !== undefined && !marker.os.includes(os)) continue;
    await mkdir(dirname(join(root, marker.path)), { recursive: true });
    await connector.writeAtomic(marker.path, new Uint8Array(0));
  }
}

/** A valid other value for a plain number setting, or undefined. */
function nextNumber(setting: Setting, value: JsonValue | undefined) {
  if (typeof value !== "number") return undefined;
  const step = setting.step ?? 1;
  for (const candidate of [value + step, value - step]) {
    if (checkValue(setting, candidate) === undefined) return candidate;
  }
  return undefined;
}

/**
 * Two number settings with a valid other value (the first for the app's
 * change, the second for the outside edit), from the demo server's files.
 */
async function demoEdits(
  pack: Pack,
  server: ServerRecord,
  changes: ChangeSetService,
) {
  const states = await changes.read(server);
  const values = new Map<string, JsonValue>();
  for (const state of states.values()) {
    if (state.bytes === null) continue;
    const read = readFileValues(pack, state.fileId, state.bytes);
    for (const [key, value] of read.values) values.set(key, value);
  }
  const found: { setting: Setting; value: number }[] = [];
  for (const setting of pack.settings) {
    const usable = setting.type === "int" || setting.type === "float";
    if (!usable || setting.secret === true) continue;
    const value = nextNumber(setting, values.get(setting.key));
    if (value !== undefined) found.push({ setting, value });
    if (found.length === 2) break;
  }
  return found;
}

/** Seeds one pack's demo server and returns its id. */
async function seedPack(pack: Pack, options: DemoSeedOptions) {
  const { servers, changes, connectors } = options;
  const os = demoOs(pack);
  const root = join(options.demoServersDir, pack.id);
  await mkdir(root, { recursive: true });
  const spec = { kind: "local" as const, root };
  const connector = connectors.open(spec);
  try {
    await fillFolder(pack, os, root, options.packsDir, connector);
  } finally {
    await connector.close();
  }
  const id = `demo-${pack.id}`;
  const name = `Demo ${pack.displayName}`;
  const packId = pack.id;
  const server = servers.insert({ id, name, packId, os, spec, demo: true });
  await changes.importServer(server, DEMO_AUTHOR);
  const [first, second] = await demoEdits(pack, server, changes);
  // A change set on a server past the editable three is refused with 402;
  // without this check the seed stopped at the fourth pack.
  if (first !== undefined && servers.isEditable(id)) {
    const edits = [{ key: first.setting.key, value: first.value }];
    const draft = await changes.create(server, { edits }, DEMO_AUTHOR);
    await changes.apply(draft.id, DEMO_AUTHOR);
  }
  if (second !== undefined) {
    // An edit made outside the app, the way a game panel or a text editor
    // would make it: straight to the file, without a change set.
    const states = await changes.read(server);
    const file = states.get(second.setting.file);
    if (file?.bytes) {
      const edits = [{ key: second.setting.key, value: second.value }];
      const bytes = writeFileValues(pack, file.fileId, file.bytes, edits);
      await servers.use(server, (opened) =>
        opened.writeAtomic(file.path, bytes),
      );
      await changes.read(server);
    }
  }
  return id;
}

/**
 * Seeds the demo servers when DEMO_SEED is true: every pack whose demo-GAME
 * server is still missing gets one. Returns the ids it created (none when it
 * did nothing).
 */
export async function seedDemoServers(
  options: DemoSeedOptions,
): Promise<string[]> {
  if (!options.demoSeed) return [];
  const created: string[] = [];
  for (const pack of options.packs.values()) {
    if (options.servers.get(`demo-${pack.id}`) !== null) continue;
    created.push(await seedPack(pack, options));
  }
  return created;
}
