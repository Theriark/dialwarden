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
//
// P10 (R&D decision THE-2855) adds two more Valheim servers, demo-valheim-2
// and demo-valheim-3, so the bulk apply of a preset and the comparison
// matrix have three servers of one game. They are seeded after the per-pack
// servers, only when the Valheim pack is loaded, each checked on its own
// like the others. Their launch values are written into the fixture before
// the import, so they get the import entry only: no change by the app, no
// outside edit, and lastEditedAt stays null.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { ACTIVITY_TYPES } from "../activity/service.js";
import type { ChangeSetService } from "../changes/service.js";
import type { ConnectorService } from "../connectors/service.js";
import { insideRoot } from "../connectors/paths.js";
import { ConnectorError, type Connector } from "../connectors/types.js";
import type { Settings } from "../db/settings.js";
import type { ChannelService } from "../notifications/channels.js";
import type { ServerRecord, ServerService } from "./service.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the configured demo and packs folders, and pack file paths checked by the connector */

/** The author of the demo change. */
export const DEMO_AUTHOR = "Dialwarden demo";

export interface DemoSeedOptions {
  readonly demoSeed: boolean;
  /** DEMO_SERVERS_DIR: where the demo folders go (default /demo-servers). */
  readonly demoServersDir: string;
  /** DATA_DIR: the demo folders never go inside it, nor around it. */
  readonly dataDir?: string;
  /** The packs folder, which holds each pack's fixtures. */
  readonly packsDir: string;
  readonly packs: ReadonlyMap<string, Pack>;
  readonly servers: ServerService;
  readonly changes: ChangeSetService;
  readonly connectors: ConnectorService;
}

/** One more demo server of a game, with the values that set it apart. */
export interface ExtraDemoServer {
  readonly id: string;
  readonly name: string;
  /** The folder under DEMO_SERVERS_DIR. */
  readonly folder: string;
  readonly packId: string;
  /** Setting values written into the fixture before the import. */
  readonly values: Readonly<Record<string, JsonValue>>;
}

/** The extra demo servers of THE-2855, seeded after the per-pack ones. */
export const EXTRA_DEMO_SERVERS: readonly ExtraDemoServer[] = [
  {
    id: "demo-valheim-2",
    name: "Demo Valheim 2",
    folder: "valheim-2",
    packId: "valheim",
    values: {
      name: "Quarry Lane North",
      port: 2466,
      world: "Northhold",
      instanceid: 2,
      saveinterval: 900,
      preset: "hard",
      combat: "hard",
      raids: "more",
    },
  },
  {
    id: "demo-valheim-3",
    name: "Demo Valheim 3",
    folder: "valheim-3",
    packId: "valheim",
    values: {
      name: "Quarry Lane South",
      port: 2476,
      world: "Southmark",
      instanceid: 3,
      public: 0,
      saveinterval: 1200,
      backups: 6,
      preset: "normal",
      resources: "muchmore",
      raids: "less",
    },
  },
];

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

/** The settings key that records the demo in-app channel was seeded. */
export const DEMO_CHANNEL_KEY = "demo.inAppChannel";

export interface DemoChannelOptions {
  readonly demoSeed: boolean;
  readonly channels: ChannelService;
  readonly settings: Settings;
}

/**
 * Seeds one in-app notification channel when DEMO_SEED is true, so the bell
 * of a demo instance is not empty (phase-report-09 G3, live check L9). It
 * receives every activity type and needs no secret. It is made once: a
 * channel the owner deletes later is not made again, and an instance that
 * has an in-app channel already gets none. True when it made one.
 */
export function seedDemoChannel(options: DemoChannelOptions): boolean {
  if (!options.demoSeed) return false;
  if (options.settings.get(DEMO_CHANNEL_KEY) !== undefined) return false;
  const present = options.channels
    .list()
    .some((channel) => channel.kind === "in_app");
  if (!present) {
    const input = {
      name: "In-app (demo)",
      enabled: true,
      types: [...ACTIVITY_TYPES],
      settings: { kind: "in_app" as const },
    };
    options.channels.create(input, "system");
  }
  options.settings.set(DEMO_CHANNEL_KEY, true);
  return !present;
}

/**
 * Seeds one extra demo server: the pack's fixtures with its values written
 * in, then the import. Returns its id.
 */
async function seedExtra(
  extra: ExtraDemoServer,
  pack: Pack,
  options: DemoSeedOptions,
): Promise<string> {
  const { servers, changes, connectors } = options;
  const os = demoOs(pack);
  const root = join(options.demoServersDir, extra.folder);
  await mkdir(root, { recursive: true });
  const spec = { kind: "local" as const, root };
  const connector = connectors.open(spec);
  try {
    await fillFolder(pack, os, root, options.packsDir, connector);
    const edits = Object.entries(extra.values).map(([key, value]) => ({
      key,
      value,
    }));
    for (const file of pack.files) {
      const path = firstPath(file, os);
      const mine = edits.filter((edit) =>
        pack.settings.some((s) => s.key === edit.key && s.file === file.id),
      );
      if (path === undefined || mine.length === 0) continue;
      const current = await connector.read(path);
      const bytes = writeFileValues(pack, file.id, current.bytes, mine);
      await connector.writeAtomic(path, bytes, {
        expectedSha256: current.sha256,
      });
    }
  } finally {
    await connector.close();
  }
  const server = servers.insert({
    id: extra.id,
    name: extra.name,
    packId: pack.id,
    os,
    spec,
    demo: true,
  });
  await changes.importServer(server, DEMO_AUTHOR);
  return extra.id;
}

/**
 * Seeds the demo servers when DEMO_SEED is true: every pack whose demo-GAME
 * server is still missing gets one, then every extra demo server whose pack
 * is loaded and that is still missing. Returns the ids it created (none when
 * it did nothing).
 */
export async function seedDemoServers(
  options: DemoSeedOptions,
): Promise<string[]> {
  if (!options.demoSeed) return [];
  if (options.dataDir !== undefined) {
    // P10-A G1.6: refused before any folder is made, so a demo folder set
    // inside the data folder (or around it) writes nothing there.
    const data = resolve(options.dataDir);
    const demo = resolve(options.demoServersDir);
    if (insideRoot(data, demo) || insideRoot(demo, data)) {
      throw new ConnectorError(
        "PathEscape",
        "DEMO_SERVERS_DIR must be outside DATA_DIR",
      );
    }
  }
  const created: string[] = [];
  for (const pack of options.packs.values()) {
    if (options.servers.get(`demo-${pack.id}`) !== null) continue;
    created.push(await seedPack(pack, options));
  }
  for (const extra of EXTRA_DEMO_SERVERS) {
    const pack = options.packs.get(extra.packId);
    if (pack === undefined || options.servers.get(extra.id) !== null) continue;
    created.push(await seedExtra(extra, pack, options));
  }
  return created;
}
