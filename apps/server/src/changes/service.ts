// Change sets, the safe write path and history (dev-work-plan P4-B step 2,
// contract C5, rnd-report-1 2.7). Every read of a server's files goes through
// here: the files are read through the server's connector (contract C4, the
// only way to its files) and compared with the SHA-256 the app last saw, and
// an outside edit becomes its own history entry with cause external.
//
// A change set holds setting edits or raw file patches, and its base: the
// SHA-256 of every file it was made on. Applying it follows the write path:
// 1. re-read every file and check its hash against the base. A file changed
//    outside the app is merged when the outside edit touched other settings
//    (or other lines of a patch); otherwise the change set is a conflict;
// 2. validate: no syntax error in a file it writes and no error on a setting
//    it changes, rules marked serverEvaluated included;
// 3. snapshot each file before the write;
// 4. write through the connector: temp file, fsync, atomic rename, with the
//    hash the file must still have;
// 5. re-read and verify the hash, snapshot after, and close the entry.
// A file that changes during the write is read and merged again (up to three
// times), so an outside edit is never lost. One task per server runs at once.
//
// P6-B adds the hook policy of contract C5: a change to a stopped-only file
// on a running server becomes pending, is written after the stop hook or when
// the server is seen stopped, and the start hook runs after the write; the
// pack live-reload action can replace a restart; the runHooks mode a pending
// change asked for is kept on its row.
import { randomUUID } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import {
  checkValue,
  FormatError,
  SECRET_MASK,
  readFileValues,
  writeFileValues,
  type JsonValue,
  type Os,
  type Pack,
  type PackFile,
  type Setting,
  type SettingEdit,
} from "@dialwarden/packs-schema";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { ActivityService } from "../activity/service.js";
import {
  importFiles,
  type ImportedFile,
  type ImportResult,
} from "../connectors/detect.js";
import {
  ConnectorError,
  isConnectorError,
  LIMITS,
  type Connector,
} from "../connectors/types.js";
import type { Aead } from "../crypto/aead.js";
import type { HookService, HookSources } from "../control/hooks.js";
import type { SettingValue } from "../control/types.js";
import { changeSets, serverFiles } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError, limitReached } from "../http/errors.js";
import type { ServerRecord, ServerService } from "../servers/service.js";
import {
  SnapshotBlobError,
  type SnapshotKind,
  type SnapshotRecord,
  type SnapshotStore,
} from "../snapshots/store.js";
import {
  allValues,
  blockingIssues,
  decodeText,
  editConflicts,
  lineChip,
  lintEntries,
  maskedDiff,
  semanticChips,
  shown,
} from "./plan.js";
import { merge3 } from "./textdiff.js";
import {
  canMove,
  isApplicable,
  type Cause,
  type ChangeSetError,
  type ChangeSetStatus,
  type ChangeSetView,
  type Chip,
  type ConflictFile,
  type Diff,
  type History,
  type LintEntry,
  type RunHooks,
  type TextDiff,
} from "./types.js";

/** The AEAD context of a change set's payload (its ENCRYPTED_COLUMNS entry). */
export const PAYLOAD_CONTEXT = "change_sets.payload";

/** The author of an outside edit. */
export const OUTSIDE_AUTHOR = "outside the app";

/** How often a write is planned again when the file changed meanwhile. */
const WRITE_ATTEMPTS = 3;

const EMPTY = new Uint8Array(0);

const BUSY: ChangeSetError = {
  code: "busy",
  message: "The file kept changing while it was written. Try again.",
};

export interface PatchInput {
  readonly fileId: string;
  /** The whole new text of the file. */
  readonly text: string;
}

export interface ChangeInput {
  readonly edits?: readonly SettingEdit[];
  readonly patches?: readonly PatchInput[];
}

interface Patch {
  readonly fileId: string;
  readonly bytes: Uint8Array;
}

interface Payload {
  readonly edits: readonly SettingEdit[];
  readonly patches: readonly Patch[];
}

/** A pack file of a server as it was just read; null bytes: no such file. */
export interface FileState {
  readonly fileId: string;
  readonly path: string;
  readonly bytes: Uint8Array | null;
  readonly sha256: string | null;
}

/** What a change set was made on, per file. */
interface BaseFile {
  readonly path: string;
  readonly sha256: string | null;
}

/** One file of a write: as it is now and as it will be. */
interface FilePlan {
  readonly state: FileState;
  readonly after: Uint8Array;
}

interface Described {
  readonly diff: Diff;
  readonly lint: LintEntry[];
  readonly changedKeys: Set<string>;
  readonly written: Set<string>;
}

type ChangeSetRow = typeof changeSets.$inferSelect;

/** A change set being applied, with what it needs. */
interface Job {
  readonly row: ChangeSetRow;
  readonly server: ServerRecord;
  readonly pack: Pack;
  readonly payload: Payload;
  readonly base: ReadonlyMap<string, BaseFile>;
  readonly actor: string;
}

export interface ServerSettings {
  readonly packId: string;
  readonly packVersion: string;
  readonly files: {
    readonly fileId: string;
    readonly path: string;
    readonly exists: boolean;
    readonly sha256: string | null;
  }[];
  /** Typed values by setting key, secrets masked. */
  readonly values: Record<string, JsonValue>;
  readonly lint: LintEntry[];
}

export interface RawFile {
  readonly fileId: string;
  readonly path: string;
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly text: string;
  readonly lint: LintEntry[];
}

export interface ChangeSetServiceOptions {
  readonly store: Store;
  readonly aead: Aead;
  readonly servers: ServerService;
  readonly snapshots: SnapshotStore;
  readonly activity: ActivityService;
  readonly entitlement: EntitlementGate;
  /** The hooks of P6-B; without it the apply step writes as P4 did. */
  readonly hooks?: HookService;
  readonly now?: () => Date;
}

/** The paths of a pack file on an operating system. */
function pathsOf(file: PackFile, os: Os): readonly string[] {
  return (os === "linux" ? file.paths.linux : file.paths.windows) ?? [];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

function parsed<T>(text: string | null): T | null {
  if (text === null) return null;
  return JSON.parse(text) as T;
}

function viewOf(row: ChangeSetRow): ChangeSetView {
  return {
    id: row.id,
    serverId: row.serverId,
    status: row.status as ChangeSetStatus,
    cause: row.cause as Cause,
    author: row.author,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    appliedAt: row.appliedAt,
    restoreOf: row.restoreOf,
    diff: JSON.parse(row.diff) as Diff,
    lint: JSON.parse(row.lint) as LintEntry[],
    conflict: parsed<{ files: ConflictFile[] }>(row.conflict),
    error: parsed<ChangeSetError>(row.error),
  };
}

function baseOf(row: ChangeSetRow): Map<string, BaseFile> {
  const data = JSON.parse(row.base) as Record<string, BaseFile>;
  return new Map(Object.entries(data));
}

/** The pack file a setting lives in, or null. */
function fileOf(pack: Pack, key: string): string | null {
  return pack.settings.find((setting) => setting.key === key)?.file ?? null;
}

function editsOf(pack: Pack, payload: Payload, fileId: string) {
  return payload.edits.filter((edit) => fileOf(pack, edit.key) === fileId);
}

/** The files a payload changes, in pack order. */
function touchedFiles(pack: Pack, payload: Payload): string[] {
  const touched = new Set<string>();
  for (const edit of payload.edits) touched.add(fileOf(pack, edit.key) ?? "");
  for (const patch of payload.patches) touched.add(patch.fileId);
  return pack.files.map((file) => file.id).filter((id) => touched.has(id));
}

/** The bytes of a file after the payload, made on its current bytes. */
function afterBytes(
  pack: Pack,
  payload: Payload,
  fileId: string,
  current: Uint8Array,
): Uint8Array {
  const patch = payload.patches.find((item) => item.fileId === fileId);
  if (patch !== undefined) return patch.bytes;
  const edits = editsOf(pack, payload, fileId);
  return writeFileValues(pack, fileId, current, edits);
}

const BOUNDS = new Set(["min", "max", "step"]);

/** A setting without its range and step, so checkValue tests only the kind. */
function shapeOf(setting: Setting): Setting {
  const entries = Object.entries(setting).filter(([name]) => !BOUNDS.has(name));
  return Object.fromEntries(entries) as unknown as Setting;
}

/**
 * Checks the request body against the pack: known settings and files, one
 * edit per setting, edits or patches but not both. A secret that comes back
 * as the mask was not changed in the editor, so it is not an edit.
 */
function payloadOf(pack: Pack, input: ChangeInput): Payload {
  const edits = input.edits ?? [];
  const patches = input.patches ?? [];
  if (edits.length > 0 && patches.length > 0) {
    throw new ApiError(422, "edits_or_patches");
  }
  const settings = new Map(pack.settings.map((s) => [s.key, s]));
  const unknown = edits.filter((edit) => !settings.has(edit.key));
  if (unknown.length > 0) {
    const names = unknown.map((edit) => edit.key);
    throw new ApiError(422, "unknown_setting", { keys: names });
  }
  const keys = new Set(edits.map((edit) => edit.key));
  if (keys.size !== edits.length) throw new ApiError(422, "duplicate_setting");
  const kept = edits.filter((edit) => {
    const secret = settings.get(edit.key)?.secret === true;
    return !(secret && edit.value === SECRET_MASK);
  });
  // A value the setting cannot hold is refused here (F2, THE-2585): an edit
  // that does not coerce to an enum option used to be dropped silently, with
  // no 422, no chip and no write. checkValue is the same test the editor and
  // validate() apply, so every caller is refused the same way; false stays a
  // value of a bool setting and null still means removal. Range, step and
  // length stay with validate(), which reports them as lint on the draft.
  let invalid: { key: string; message: string } | undefined;
  for (const edit of kept) {
    const setting = settings.get(edit.key);
    if (setting === undefined) continue;
    const problem = checkValue(shapeOf(setting), edit.value);
    if (problem !== undefined) {
      invalid = { key: edit.key, message: problem };
      break;
    }
  }
  if (invalid !== undefined) {
    throw new ApiError(422, "invalid_value", invalid);
  }
  const files = new Set(pack.files.map((file) => file.id));
  const seen = new Set<string>();
  const encoded: Patch[] = [];
  for (const patch of patches) {
    const fileId = patch.fileId;
    if (!files.has(fileId)) throw new ApiError(422, "unknown_file", { fileId });
    if (seen.has(fileId)) throw new ApiError(422, "duplicate_file", { fileId });
    seen.add(fileId);
    const bytes = new TextEncoder().encode(patch.text);
    if (bytes.length > LIMITS.maxFileBytes) {
      throw new ApiError(422, "file_too_large", { fileId });
    }
    encoded.push({ fileId, bytes });
  }
  if (kept.length === 0 && encoded.length === 0) {
    throw new ApiError(422, "no_change");
  }
  return { edits: kept, patches: encoded };
}

function encodePayload(payload: Payload): string {
  const patches = payload.patches.map((patch) => ({
    fileId: patch.fileId,
    data: Buffer.from(patch.bytes).toString("base64"),
  }));
  return JSON.stringify({ edits: payload.edits, patches });
}

interface StoredPayload {
  readonly edits: SettingEdit[];
  readonly patches: { readonly fileId: string; readonly data: string }[];
}

function decodePayload(text: string): Payload {
  const data = JSON.parse(text) as StoredPayload;
  const patches = data.patches.map((patch) => ({
    fileId: patch.fileId,
    bytes: new Uint8Array(Buffer.from(patch.data, "base64")),
  }));
  return { edits: data.edits, patches };
}

/** The diff and lint of a set of file plans, against the files now. */
function describe(
  pack: Pack,
  states: ReadonlyMap<string, FileState>,
  plans: readonly FilePlan[],
): Described {
  const semantic: Chip[] = [];
  const text: TextDiff[] = [];
  const after = new Map<string, Uint8Array | null>();
  for (const state of states.values()) after.set(state.fileId, state.bytes);
  const written = new Set<string>();
  for (const { state, after: bytes } of plans) {
    after.set(state.fileId, bytes);
    if (state.bytes !== null && sameBytes(state.bytes, bytes)) continue;
    written.add(state.fileId);
    const chips = semanticChips(pack, state.fileId, state.bytes, bytes);
    if (chips.length === 0) {
      const before = decodeText(state.bytes);
      chips.push(lineChip("lines", state.fileId, before, decodeText(bytes)));
    }
    semantic.push(...chips);
    const unifiedDiff = maskedDiff(pack, state.fileId, state.bytes, bytes);
    text.push({ fileId: state.fileId, unifiedDiff });
  }
  const lint = lintEntries(pack, after, written);
  const changedKeys = new Set<string>();
  for (const chip of semantic) {
    if (chip.settingKey !== null) changedKeys.add(chip.settingKey);
  }
  return { diff: { semantic, text }, lint, changedKeys, written };
}

async function readState(
  connector: Connector,
  fileId: string,
  path: string,
): Promise<FileState> {
  try {
    const read = await connector.read(path);
    return { fileId, path, bytes: read.bytes, sha256: read.sha256 };
  } catch (error) {
    if (!isConnectorError(error, "NotFound")) throw error;
    return { fileId, path, bytes: null, sha256: null };
  }
}

function connectorFailure(error: ConnectorError): ChangeSetError {
  return { code: error.code, message: error.message };
}

interface Finish {
  readonly diff?: Diff;
  readonly lint?: readonly LintEntry[];
  readonly conflict?: { readonly files: readonly ConflictFile[] };
  readonly error?: ChangeSetError;
  readonly appliedAt?: string;
  /** The hook mode a change parked as pending asked for (P6-B). */
  readonly runHooks?: RunHooks;
}

interface NewChangeSet {
  readonly serverId: string;
  readonly status: ChangeSetStatus;
  readonly cause: Cause;
  readonly author: string;
  readonly payload: Payload | null;
  readonly base: ReadonlyMap<string, BaseFile>;
  readonly diff: Diff;
  readonly lint: readonly LintEntry[];
  readonly restoreOf: string | null;
}

type WriteHook = (serverId: string, fileId: string) => Promise<void>;

export class ChangeSetService {
  /**
   * Tests only: runs after a write was planned and validated, right before
   * the connector writes a file (the outside-edit race of the P4 tests).
   */
  beforeWrite: WriteHook | null = null;

  readonly #store: Store;
  readonly #aead: Aead;
  readonly #servers: ServerService;
  readonly #snapshots: SnapshotStore;
  readonly #activity: ActivityService;
  readonly #entitlement: EntitlementGate;
  readonly #hooks: HookService | null;
  readonly #now: () => Date;
  readonly #locks = new Map<string, Promise<void>>();
  #lastStamp = 0;

  constructor(options: ChangeSetServiceOptions) {
    this.#store = options.store;
    this.#aead = options.aead;
    this.#servers = options.servers;
    this.#snapshots = options.snapshots;
    this.#activity = options.activity;
    this.#entitlement = options.entitlement;
    this.#hooks = options.hooks ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  /** A time stamp later than every one before it, so history keeps order. */
  #stamp(): string {
    let time = this.#now().getTime();
    if (time <= this.#lastStamp) time = this.#lastStamp + 1;
    this.#lastStamp = time;
    return new Date(time).toISOString();
  }

  /** Runs task alone for its server: one read or write at a time. */
  async #exclusive<T>(serverId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(serverId) ?? Promise.resolve();
    const run = previous.then(task);
    const settle = () => undefined;
    const done = run.then(settle, settle);
    this.#locks.set(serverId, done);
    try {
      return await run;
    } finally {
      if (this.#locks.get(serverId) === done) this.#locks.delete(serverId);
    }
  }

  #known(serverId: string) {
    const rows = this.#store.db
      .select()
      .from(serverFiles)
      .where(eq(serverFiles.serverId, serverId))
      .all();
    return new Map(rows.map((row) => [row.fileId, row]));
  }

  #setKnown(
    serverId: string,
    fileId: string,
    path: string,
    sha256: string | null,
  ): void {
    const checkedAt = this.#now().toISOString();
    this.#store.db
      .insert(serverFiles)
      .values({ serverId, fileId, path, sha256, checkedAt })
      .onConflictDoUpdate({
        target: [serverFiles.serverId, serverFiles.fileId],
        set: { path, sha256, checkedAt },
      })
      .run();
  }

  /** The bytes of a blob the app saw, or null when it has none. */
  async #blob(sha256: string | null): Promise<Uint8Array | null> {
    if (sha256 === null) return null;
    try {
      return await this.#snapshots.get(sha256);
    } catch (error) {
      if (error instanceof SnapshotBlobError) return null;
      throw error;
    }
  }

  #row(id: string): ChangeSetRow | null {
    const row = this.#store.db
      .select()
      .from(changeSets)
      .where(eq(changeSets.id, id))
      .get();
    return row ?? null;
  }

  #require(id: string): ChangeSetRow {
    const row = this.#row(id);
    if (row === null) throw new ApiError(404, "change_set_not_found");
    return row;
  }

  #insert(input: NewChangeSet): ChangeSetRow {
    const at = this.#stamp();
    const applied = input.status === "applied";
    let payload: string | null = null;
    if (input.payload !== null) {
      const text = encodePayload(input.payload);
      payload = this.#aead.encrypt(text, PAYLOAD_CONTEXT);
    }
    const row: ChangeSetRow = {
      id: randomUUID(),
      serverId: input.serverId,
      status: input.status,
      cause: input.cause,
      author: input.author,
      payloadEnc: payload,
      base: JSON.stringify(Object.fromEntries(input.base)),
      diff: JSON.stringify(input.diff),
      lint: JSON.stringify(input.lint),
      conflict: null,
      error: null,
      runHooks: null,
      restoreOf: input.restoreOf,
      createdAt: at,
      updatedAt: at,
      appliedAt: applied ? at : null,
    };
    this.#store.db.insert(changeSets).values(row).run();
    return row;
  }

  #finish(row: ChangeSetRow, status: ChangeSetStatus, fields: Finish): void {
    const from = row.status as ChangeSetStatus;
    if (!canMove(from, status)) {
      throw new Error(`a change set cannot go from ${from} to ${status}`);
    }
    const values: Partial<ChangeSetRow> = {
      status,
      updatedAt: this.#stamp(),
      conflict: fields.conflict ? JSON.stringify(fields.conflict) : null,
      error: fields.error ? JSON.stringify(fields.error) : null,
    };
    if (fields.diff) values.diff = JSON.stringify(fields.diff);
    if (fields.lint) values.lint = JSON.stringify(fields.lint);
    if (fields.appliedAt) values.appliedAt = fields.appliedAt;
    if (status === "pending" && fields.runHooks !== undefined) {
      values.runHooks = fields.runHooks;
    }
    if (from === "pending") values.runHooks = null;
    const where = eq(changeSets.id, row.id);
    this.#store.db.update(changeSets).set(values).where(where).run();
  }

  /** Reads every pack file of a server through its connector. */
  async #readFiles(
    server: ServerRecord,
    pack: Pack,
    connector: Connector,
  ): Promise<Map<string, FileState>> {
    const known = this.#known(server.id);
    const states = new Map<string, FileState>();
    for (const file of pack.files) {
      const path = known.get(file.id)?.path ?? pathsOf(file, server.os).at(0);
      if (path === undefined) continue;
      states.set(file.id, await readState(connector, file.id, path));
    }
    return states;
  }

  /**
   * Compares what was just read with what the app last saw, and records the
   * differences as one history entry with cause external (outside-edit
   * detection on every read). Returns the entry's id, or null.
   */
  async #recordOutside(
    server: ServerRecord,
    pack: Pack,
    states: ReadonlyMap<string, FileState>,
  ): Promise<string | null> {
    const known = this.#known(server.id);
    const changed: { state: FileState; before: Uint8Array | null }[] = [];
    const base = new Map<string, BaseFile>();
    for (const state of states.values()) {
      const seen = known.get(state.fileId);
      if (seen === undefined) {
        this.#setKnown(server.id, state.fileId, state.path, state.sha256);
        continue;
      }
      if (seen.sha256 === state.sha256) continue;
      changed.push({ state, before: await this.#blob(seen.sha256) });
      base.set(state.fileId, { path: seen.path, sha256: seen.sha256 });
    }
    if (changed.length === 0) return null;
    const semantic: Chip[] = [];
    const text: TextDiff[] = [];
    for (const { state, before } of changed) {
      const chips = semanticChips(pack, state.fileId, before, state.bytes);
      if (chips.length === 0) {
        const old = decodeText(before);
        const now = decodeText(state.bytes);
        chips.push(lineChip("external", state.fileId, old, now));
      }
      semantic.push(...chips);
      const unifiedDiff = maskedDiff(pack, state.fileId, before, state.bytes);
      text.push({ fileId: state.fileId, unifiedDiff });
    }
    const row = this.#insert({
      serverId: server.id,
      status: "applied",
      cause: "external",
      author: OUTSIDE_AUTHOR,
      payload: null,
      base,
      diff: { semantic, text },
      lint: [],
      restoreOf: null,
    });
    for (const { state } of changed) {
      if (state.bytes !== null) {
        await this.#snapshots.record({
          serverId: server.id,
          changeSetId: row.id,
          fileId: state.fileId,
          path: state.path,
          kind: "external",
          bytes: state.bytes,
        });
      }
      this.#setKnown(server.id, state.fileId, state.path, state.sha256);
    }
    const files = changed.map(({ state }) => state.fileId);
    this.#activity.record("drift.detected", {
      serverId: server.id,
      data: { changeSetId: row.id, files },
    });
    return row.id;
  }

  /** Reads a server's files and records any outside edit; caller locks. */
  async #readLocked(
    server: ServerRecord,
    pack: Pack,
  ): Promise<Map<string, FileState>> {
    return this.#servers.use(server, async (connector) => {
      const states = await this.#readFiles(server, pack, connector);
      await this.#recordOutside(server, pack, states);
      return states;
    });
  }

  /** Reads a server's files; an outside edit is recorded on every read. */
  async read(server: ServerRecord): Promise<Map<string, FileState>> {
    const pack = this.#servers.pack(server);
    return this.#exclusive(server.id, () => this.#readLocked(server, pack));
  }

  /** The typed values and lint of a server's files (GET .../settings). */
  async settings(server: ServerRecord): Promise<ServerSettings> {
    const pack = this.#servers.pack(server);
    const states = await this.read(server);
    const bytes = new Map<string, Uint8Array | null>();
    for (const state of states.values()) bytes.set(state.fileId, state.bytes);
    const settings = new Map(pack.settings.map((s) => [s.key, s]));
    const values = new Map<string, JsonValue>();
    for (const [key, value] of allValues(pack, bytes)) {
      const setting = settings.get(key);
      if (setting !== undefined) values.set(key, shown(setting, value));
    }
    const files = [...states.values()].map((state) => ({
      fileId: state.fileId,
      path: state.path,
      exists: state.bytes !== null,
      sha256: state.sha256,
    }));
    return {
      packId: pack.id,
      packVersion: pack.version,
      files,
      values: Object.fromEntries(values),
      lint: lintEntries(pack, bytes, bytes.keys()),
    };
  }

  /** The text of one file (GET .../files/ID); writes go through patches. */
  async rawFile(server: ServerRecord, fileId: string): Promise<RawFile> {
    const pack = this.#servers.pack(server);
    const states = await this.read(server);
    const state = states.get(fileId);
    if (state === undefined) throw new ApiError(404, "file_not_found");
    const bytes = new Map([[fileId, state.bytes]]);
    const lint = lintEntries(pack, bytes, [fileId]);
    return {
      fileId,
      path: state.path,
      exists: state.bytes !== null,
      sha256: state.sha256,
      text: decodeText(state.bytes),
      lint: lint.filter((entry) => entry.settingKey === null),
    };
  }

  /**
   * The first read of a new server (P4-A import): every pack file found is
   * stored as a snapshot with cause import, in one history entry, and
   * becomes the base of outside-edit detection.
   */
  async importServer(
    server: ServerRecord,
    author: string,
  ): Promise<ImportResult> {
    const pack = this.#servers.pack(server);
    const task = () => this.#importLocked(server, pack, author);
    return this.#exclusive(server.id, task);
  }

  async #importLocked(
    server: ServerRecord,
    pack: Pack,
    author: string,
  ): Promise<ImportResult> {
    return this.#servers.use(server, async (connector) => {
      const found: ImportedFile[] = [];
      const sink = {
        store(file: ImportedFile) {
          found.push(file);
        },
      };
      const result = await importFiles(pack, server.os, connector, sink);
      const base = new Map<string, BaseFile>();
      const semantic: Chip[] = [];
      for (const file of found) {
        base.set(file.fileId, { path: file.path, sha256: file.sha256 });
        const text = decodeText(file.bytes);
        semantic.push(lineChip("import", file.fileId, "", text));
      }
      const row = this.#insert({
        serverId: server.id,
        status: "applied",
        cause: "import",
        author,
        payload: null,
        base,
        diff: { semantic, text: [] },
        lint: [],
        restoreOf: null,
      });
      for (const file of found) {
        await this.#snapshot(row, server, file, file.bytes, "import");
        this.#setKnown(server.id, file.fileId, file.path, file.sha256);
      }
      for (const missing of result.missing) {
        const path = missing.paths.at(0);
        if (path !== undefined) {
          this.#setKnown(server.id, missing.fileId, path, null);
        }
      }
      return result;
    });
  }

  async #snapshot(
    row: ChangeSetRow,
    server: ServerRecord,
    file: { readonly fileId: string; readonly path: string },
    bytes: Uint8Array,
    kind: SnapshotKind,
  ): Promise<void> {
    await this.#snapshots.record({
      serverId: server.id,
      changeSetId: row.id,
      fileId: file.fileId,
      path: file.path,
      kind,
      bytes,
    });
  }

  /**
   * A draft change set of setting edits or raw file patches. The editor's
   * own saves keep the default cause app; a preset applied to the server
   * (P5 screen 7) passes preset, so its history entry says so.
   */
  async create(
    server: ServerRecord,
    input: ChangeInput,
    author: string,
    cause: Cause = "app",
  ): Promise<ChangeSetView> {
    this.#servers.assertEditable(server.id);
    const pack = this.#servers.pack(server);
    const payload = payloadOf(pack, input);
    return this.#exclusive(server.id, async () => {
      const states = await this.#readLocked(server, pack);
      const plans: FilePlan[] = [];
      for (const fileId of touchedFiles(pack, payload)) {
        const state = states.get(fileId);
        if (state === undefined) {
          throw new ApiError(422, "unknown_file", { fileId });
        }
        const current = state.bytes ?? EMPTY;
        let after: Uint8Array;
        try {
          after = afterBytes(pack, payload, fileId, current);
        } catch (error) {
          if (!(error instanceof FormatError)) throw error;
          const message = error.message;
          throw new ApiError(422, "cannot_edit", { fileId, message });
        }
        plans.push({ state, after });
      }
      const described = describe(pack, states, plans);
      // Setting edits change something when a value changes (writing a
      // value again may only reformat it); patches when the bytes change.
      let changed = described.written.size > 0;
      if (payload.edits.length > 0) changed = described.changedKeys.size > 0;
      if (!changed) throw new ApiError(422, "no_change");
      const base = new Map<string, BaseFile>();
      for (const { state } of plans) {
        base.set(state.fileId, { path: state.path, sha256: state.sha256 });
        // Kept so the write path can merge against it later.
        if (state.bytes !== null) await this.#snapshots.put(state.bytes);
      }
      const row = this.#insert({
        serverId: server.id,
        status: "draft",
        cause,
        author,
        payload,
        base,
        diff: described.diff,
        lint: described.lint,
        restoreOf: null,
      });
      return viewOf(row);
    });
  }

  get(id: string): ChangeSetView {
    return viewOf(this.#require(id));
  }

  /**
   * Applies a draft (or a failed change set again) through the write path,
   * with the hook policy of P6-B (contract C5 runHooks): none writes only;
   * restart runs the pack live-reload action instead when every changed
   * setting supports it, else the restart hook; stop-start stops the server,
   * writes while it is down and starts it again. A stopped-only change on a
   * running server becomes pending in every mode.
   */
  async apply(
    id: string,
    actor: string,
    runHooks: RunHooks = "none",
  ): Promise<ChangeSetView> {
    const first = this.#require(id);
    const server = this.#servers.require(first.serverId);
    this.#servers.assertEditable(server.id);
    const pack = this.#servers.pack(server);
    return this.#exclusive(server.id, async () => {
      const row = this.#require(id);
      const status = row.status as ChangeSetStatus;
      if (!isApplicable(status)) {
        throw new ApiError(409, "invalid_state", { status });
      }
      await this.#apply(row, server, pack, actor, runHooks);
      return viewOf(this.#require(id));
    });
  }

  /** True when the payload changes at least one stopped-only file. */
  #stoppedOnly(pack: Pack, payload: Payload): boolean {
    const touched = new Set(touchedFiles(pack, payload));
    return pack.files.some(
      (file) => touched.has(file.id) && file.applyPolicy === "stopped-only",
    );
  }

  /**
   * True when every setting the payload edits is liveReloadable: the pack
   * live-reload action can apply the change without a restart. Raw patches
   * never qualify; the words they write are not known.
   */
  #liveReload(pack: Pack, payload: Payload): boolean {
    if (payload.edits.length === 0) return false;
    const settings = new Map(pack.settings.map((s) => [s.key, s]));
    return payload.edits.every(
      (edit) => settings.get(edit.key)?.liveReloadable === true,
    );
  }

  /** One apply under the server lock; the hook policy decides the order. */
  async #apply(
    row: ChangeSetRow,
    server: ServerRecord,
    pack: Pack,
    actor: string,
    runHooks: RunHooks,
  ): Promise<void> {
    const hooks = this.#hooks;
    const payload = this.#payloadOf(row);
    const stoppedOnly = this.#stoppedOnly(pack, payload);
    // The P4 path: no hooks asked for, and nothing in the change waits for a
    // stopped server. Without the hook service (tests of P4) every apply is
    // this one, exactly as before.
    if (runHooks === "none" && (hooks === null || !stoppedOnly)) {
      await this.#run(row, server, pack, actor);
      return;
    }
    if (hooks === null) {
      throw new ApiError(409, "hook_not_configured", { action: runHooks });
    }
    const states = await this.#readLocked(server, pack);
    const values = this.#valuesOf(pack, states);
    const context = hooks.contextFor(server, (key) => values.get(key));
    const sources = await hooks.sources(server, context);
    const answer = await hooks.probe(server, context, sources);
    const running = answer.state === "running";
    const live =
      this.#liveReload(pack, payload) &&
      !stoppedOnly &&
      running &&
      hooks.canRun(server, sources, "save") !== null;

    if (runHooks === "none") {
      if (running) {
        this.#park(row, server, actor, runHooks);
        return;
      }
      // Down: the change sets that waited for the stop are written first.
      const pendingStart = await this.#writePending(server, pack, actor);
      await this.#run(row, server, pack, actor);
      if (pendingStart) {
        await this.#afterWrite(server, sources, actor, "start", {});
      }
      return;
    }
    if (runHooks === "restart") {
      // The pack live-reload action replaces the restart: the change is
      // written and the game reloads it, no downtime.
      if (live) {
        const written = await this.#run(row, server, pack, actor);
        if (written === "applied") {
          await this.#afterWrite(server, sources, actor, "save", {
            liveReload: true,
          });
        }
        return;
      }
      if (stoppedOnly && running) {
        this.#park(row, server, actor, runHooks);
        return;
      }
      if (hooks.canRun(server, sources, "restart") === null) {
        throw new ApiError(409, "hook_not_configured", { action: "restart" });
      }
      const pendingStart = running
        ? false
        : await this.#writePending(server, pack, actor);
      const written = await this.#run(row, server, pack, actor);
      if (written === "applied") {
        await this.#afterWrite(server, sources, actor, "restart", {});
      } else if (pendingStart) {
        await this.#afterWrite(server, sources, actor, "start", {});
      }
      return;
    }
    // stop-start
    if (!stoppedOnly) {
      // Any-time files need no stop; the change is written and the game is
      // brought back with whatever the server has.
      const restart = hooks.canRun(server, sources, "restart") !== null;
      const stop = hooks.canRun(server, sources, "stop");
      const start = hooks.canRun(server, sources, "start");
      if (!restart && (stop === null || start === null)) {
        throw new ApiError(409, "hook_not_configured", {
          action: "stop-start",
        });
      }
      const pendingStart = running
        ? false
        : await this.#writePending(server, pack, actor);
      const written = await this.#run(row, server, pack, actor);
      if (written === "applied" && restart) {
        await this.#afterWrite(server, sources, actor, "restart", {});
      } else if (written === "applied") {
        await this.#afterWrite(server, sources, actor, "stop", {});
        await this.#afterWrite(server, sources, actor, "start", {});
      } else if (pendingStart) {
        await this.#afterWrite(server, sources, actor, "start", {});
      }
      return;
    }
    if (running) {
      const stop = hooks.canRun(server, sources, "stop");
      if (stop === null) {
        this.#park(row, server, actor, runHooks);
        return;
      }
      await hooks.runFrom(server, sources, "stop", actor);
      if (!(await hooks.awaitStopped(server, context, sources))) {
        this.#park(row, server, actor, runHooks);
        return;
      }
      // The stop window: the older pending change sets first, oldest first,
      // then this one (contract C5).
      await this.#writePending(server, pack, actor);
      await this.#run(row, server, pack, actor);
      // This request stopped the server, so it starts it again whatever the
      // writes did; a failed write is recorded in its change set.
      await this.#afterWrite(server, sources, actor, "start", {});
      return;
    }
    // Already down: the waiting change sets, then this one, and the start
    // hook runs once after every write.
    const pendingStart = await this.#writePending(server, pack, actor);
    const written = await this.#run(row, server, pack, actor);
    if (written === "applied" || pendingStart) {
      await this.#afterWrite(server, sources, actor, "start", {});
    }
  }

  /** Parks a change set as pending until the server is stopped (C5, C6). */
  #park(
    row: ChangeSetRow,
    server: ServerRecord,
    actor: string,
    runHooks: RunHooks,
  ): void {
    this.#finish(row, "pending", { runHooks });
    this.#activity.record("change.pending", {
      serverId: server.id,
      actor,
      data: { changeSetId: row.id, runHooks },
    });
  }

  /**
   * Writes the pending change sets of a server while it is down, oldest
   * first, under the lock the caller holds. True when one of them was
   * applied and had asked for restart or stop-start: the caller then runs
   * the start hook once, after every write, so no pending change lands on a
   * server that was started again in between (contract C5).
   */
  async #writePending(
    server: ServerRecord,
    pack: Pack,
    actor: string,
    written?: ChangeSetView[],
  ): Promise<boolean> {
    let start = false;
    for (const row of this.#pendingRows(server.id)) {
      const mode = (row.runHooks ?? "none") as RunHooks;
      const result = await this.#run(row, server, pack, actor);
      written?.push(viewOf(this.#require(row.id)));
      // A change set parked as none keeps the server down.
      if (mode !== "none" && result === "applied") start = true;
    }
    return start;
  }

  /**
   * Runs a hook after the write. Its failure never fails the apply: the
   * change set says the write, the activity says the hook, and the next
   * status probe says the server.
   */
  async #afterWrite(
    server: ServerRecord,
    sources: HookSources,
    actor: string,
    action: "save" | "stop" | "start" | "restart",
    extra: Record<string, unknown>,
  ): Promise<void> {
    const hooks = this.#hooks;
    if (hooks === null) return;
    try {
      await hooks.runFrom(server, sources, action, actor, extra);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // hook_not_configured or the control failure was recorded as a
      // hook.run event; the write stands.
    }
  }

  /**
   * Writes the pending change sets of a server while it is stopped (the
   * stopped-only policy of P6-B): the probe is asked again under the lock,
   * every pending change set is written in the order it was made, and the
   * start hook runs once after the last write (contract C5).
   */
  async flushPending(
    server: ServerRecord,
    actor: string,
  ): Promise<ChangeSetView[]> {
    const hooks = this.#hooks;
    if (hooks === null) return [];
    return this.#exclusive(server.id, async () => {
      const rows = this.#pendingRows(server.id);
      if (rows.length === 0) return [];
      const pack = this.#servers.pack(server);
      const states = await this.#readLocked(server, pack);
      const values = this.#valuesOf(pack, states);
      const context = hooks.contextFor(server, (key) => values.get(key));
      const sources = await hooks.sources(server, context);
      const answer = await hooks.probe(server, context, sources);
      if (answer.state === "running") return [];
      const written: ChangeSetView[] = [];
      if (await this.#writePending(server, pack, actor, written)) {
        await this.#afterWrite(server, sources, actor, "start", {});
      }
      return written;
    });
  }

  /** The pending change sets of a server, oldest first (contract C5). */
  pending(server: ServerRecord): ChangeSetView[] {
    return this.#pendingRows(server.id).map(viewOf);
  }

  #pendingRows(serverId: string): ChangeSetRow[] {
    return this.#store.db
      .select()
      .from(changeSets)
      .where(
        and(
          eq(changeSets.serverId, serverId),
          eq(changeSets.status, "pending"),
        ),
      )
      .orderBy(asc(changeSets.createdAt))
      .all();
  }

  /**
   * The live setting values of a server as the control clients need them:
   * read from the files, never masked (a probe's password is the game's
   * own), through the same read every other caller takes.
   */
  async controlValues(server: ServerRecord): Promise<SettingValue> {
    const pack = this.#servers.pack(server);
    const states = await this.read(server);
    const values = this.#valuesOf(pack, states);
    return (key) => values.get(key);
  }

  #valuesOf(
    pack: Pack,
    states: ReadonlyMap<string, FileState>,
  ): Map<string, JsonValue> {
    const values = new Map<string, JsonValue>();
    for (const state of states.values()) {
      if (state.bytes === null) continue;
      const read = readFileValues(pack, state.fileId, state.bytes);
      for (const [key, value] of read.values) values.set(key, value);
    }
    return values;
  }

  #payloadOf(row: ChangeSetRow): Payload {
    if (row.payloadEnc === null) return { edits: [], patches: [] };
    const text = this.#aead.decryptText(row.payloadEnc, PAYLOAD_CONTEXT);
    return decodePayload(text);
  }

  async #run(
    row: ChangeSetRow,
    server: ServerRecord,
    pack: Pack,
    actor: string,
  ): Promise<ChangeSetStatus> {
    const job: Job = {
      row,
      server,
      pack,
      payload: this.#payloadOf(row),
      base: baseOf(row),
      actor,
    };
    try {
      await this.#servers.use(server, (connector) => {
        return this.#attempts(job, connector);
      });
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      this.#finish(row, "failed", { error: connectorFailure(error) });
    }
    return this.#require(row.id).status as ChangeSetStatus;
  }

  async #attempts(job: Job, connector: Connector): Promise<void> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      if ((await this.#attempt(job, connector)) === "done") return;
    }
    this.#finish(job.row, "failed", { error: BUSY });
  }

  /** One pass of the write path; "retry" when a file changed meanwhile. */
  async #attempt(job: Job, connector: Connector): Promise<"done" | "retry"> {
    const { row, server, pack } = job;
    const states = await this.#readFiles(server, pack, connector);
    await this.#recordOutside(server, pack, states);
    let planned: { files: FilePlan[]; conflicts: ConflictFile[] };
    try {
      planned = await this.#plan(job, states);
    } catch (error) {
      if (!(error instanceof FormatError)) throw error;
      const failure = { code: "cannot_edit", message: error.message };
      this.#finish(row, "failed", { error: failure });
      return "done";
    }
    if (planned.conflicts.length > 0) {
      this.#finish(row, "conflict", { conflict: { files: planned.conflicts } });
      this.#activity.record("change.conflict", {
        serverId: server.id,
        actor: job.actor,
        data: { changeSetId: row.id },
      });
      return "done";
    }
    const described = describe(pack, states, planned.files);
    const { diff, lint, changedKeys, written } = described;
    const blocking = blockingIssues(lint, changedKeys, written);
    if (blocking.length > 0) {
      const count = blocking.length;
      const message = `${count} error${count === 1 ? "" : "s"} stop the write.`;
      const error = { code: "validation", message };
      this.#finish(row, "failed", { diff, lint, error });
      return "done";
    }
    if ((await this.#write(job, connector, planned.files)) === "retry") {
      return "retry";
    }
    const appliedAt = this.#stamp();
    this.#finish(row, "applied", { diff, lint, appliedAt });
    if (row.cause !== "external" && row.cause !== "import") {
      this.#servers.touchEdited(server.id, appliedAt);
    }
    this.#activity.record("change.applied", {
      serverId: server.id,
      actor: job.actor,
      data: { changeSetId: row.id, cause: row.cause },
    });
    return "done";
  }

  /**
   * The bytes to write per file. A file still as the change set found it
   * takes the change directly; one changed outside since then is merged
   * (setting edits by setting, patches by line), or becomes a conflict.
   */
  async #plan(job: Job, states: ReadonlyMap<string, FileState>) {
    const { pack, payload } = job;
    const files: FilePlan[] = [];
    const conflicts: ConflictFile[] = [];
    for (const [fileId, base] of job.base) {
      const state = states.get(fileId) ?? {
        fileId,
        path: base.path,
        bytes: null,
        sha256: null,
      };
      const current = state.bytes ?? EMPTY;
      if (state.sha256 === base.sha256) {
        const after = afterBytes(pack, payload, fileId, current);
        files.push({ state, after });
        continue;
      }
      const then = (await this.#blob(base.sha256)) ?? EMPTY;
      const patch = payload.patches.find((item) => item.fileId === fileId);
      if (patch !== undefined) {
        const ours = decodeText(patch.bytes);
        const merged = merge3(decodeText(then), ours, decodeText(current));
        if (merged.ok) {
          const after = new TextEncoder().encode(merged.text);
          files.push({ state, after });
          continue;
        }
        conflicts.push({
          kind: "text",
          fileId,
          conflicts: merged.conflicts,
          ours: maskedDiff(pack, fileId, then, patch.bytes),
          theirs: maskedDiff(pack, fileId, then, current),
        });
        continue;
      }
      const edits = editsOf(pack, payload, fileId);
      const settings = editConflicts(pack, fileId, then, current, edits);
      if (settings.length > 0) {
        conflicts.push({ kind: "settings", fileId, settings });
        continue;
      }
      const after = writeFileValues(pack, fileId, current, edits);
      files.push({ state, after });
    }
    return { files, conflicts };
  }

  /**
   * Writes the files in order: snapshot before, the atomic write with the
   * hash the file must still have, a re-read that verifies it, snapshot
   * after. When a file changed since it was read, the files already written
   * are put back and the caller plans again.
   */
  async #write(
    job: Job,
    connector: Connector,
    plans: readonly FilePlan[],
  ): Promise<"done" | "retry"> {
    const { row, server } = job;
    const done: { plan: FilePlan; sha256: string }[] = [];
    for (const plan of plans) {
      const { state, after } = plan;
      if (state.bytes !== null && sameBytes(state.bytes, after)) continue;
      if (state.bytes !== null) {
        await this.#snapshot(row, server, state, state.bytes, "before");
      }
      await this.beforeWrite?.(server.id, state.fileId);
      let sha256: string;
      try {
        const options = { expectedSha256: state.sha256 };
        sha256 = await connector.writeAtomic(state.path, after, options);
      } catch (error) {
        await this.#undo(job, connector, done);
        if (isConnectorError(error, "HashMismatch")) return "retry";
        throw error;
      }
      const check = await connector.read(state.path);
      if (check.sha256 !== sha256) {
        await this.#undo(job, connector, done);
        throw new ConnectorError(
          "HashMismatch",
          `${state.path} changed right after the write`,
        );
      }
      await this.#snapshot(row, server, state, after, "after");
      this.#setKnown(server.id, state.fileId, state.path, sha256);
      done.push({ plan, sha256 });
    }
    return "done";
  }

  /** Puts back the files a failed pass wrote (best effort). */
  async #undo(
    job: Job,
    connector: Connector,
    done: readonly { plan: FilePlan; sha256: string }[],
  ): Promise<void> {
    for (const { plan, sha256 } of [...done].reverse()) {
      const { state } = plan;
      // A file the change created stays: contract C4 has no delete.
      if (state.bytes === null) continue;
      try {
        const options = { expectedSha256: sha256 };
        await connector.writeAtomic(state.path, state.bytes, options);
        this.#setKnown(job.server.id, state.fileId, state.path, state.sha256);
      } catch {
        // Left as written: the next read records the difference.
      }
    }
  }

  /**
   * POST /snapshots/ID/restore: a new change set (cause rollback) that
   * writes the snapshot's bytes through the same write path. Restoring the
   * version before a change set marks that change set reverted.
   */
  async restore(snapshotId: string, author: string): Promise<ChangeSetView> {
    const snapshot = this.#snapshots.find(snapshotId);
    if (snapshot === null) throw new ApiError(404, "snapshot_not_found");
    const server = this.#servers.require(snapshot.serverId);
    this.#servers.assertEditable(server.id);
    this.#assertVisible(server, snapshot);
    const pack = this.#servers.pack(server);
    const bytes = await this.#blob(snapshot.sha256);
    if (bytes === null) throw new ApiError(410, "snapshot_unavailable");
    return this.#exclusive(server.id, async () => {
      const states = await this.#readLocked(server, pack);
      // Again under the lock and after the read, before any file is written:
      // an outside edit the read just recorded is a new entry on top.
      this.#assertVisible(server, snapshot);
      const state = states.get(snapshot.fileId);
      if (state === undefined) {
        throw new ApiError(409, "file_not_on_server", {
          fileId: snapshot.fileId,
        });
      }
      const plans = [{ state, after: bytes }];
      const described = describe(pack, states, plans);
      const base = new Map([
        [state.fileId, { path: state.path, sha256: state.sha256 }],
      ]);
      const patches = [{ fileId: snapshot.fileId, bytes }];
      const row = this.#insert({
        serverId: server.id,
        status: "draft",
        cause: "rollback",
        author,
        payload: { edits: [], patches },
        base,
        diff: described.diff,
        lint: described.lint,
        restoreOf: snapshot.id,
      });
      await this.#run(row, server, pack, author);
      const result = this.#require(row.id);
      const undone = snapshot.changeSetId;
      if (result.status === "applied" && snapshot.kind === "before") {
        if (undone !== null) this.#revert(undone, server.id);
      }
      return viewOf(result);
    });
  }

  /**
   * Marks a change set reverted once every file it wrote holds its before
   * version again; restoring one file of a multi-file change set leaves it
   * applied until the others are restored too.
   */
  #revert(id: string, serverId: string): void {
    const row = this.#row(id);
    if (row === null || row.status !== "applied") return;
    const before = new Map<string, string>();
    const written = new Set<string>();
    for (const snap of this.#snapshots.ofChangeSets([id])) {
      if (snap.kind === "before") before.set(snap.fileId, snap.sha256);
      if (snap.kind === "after") written.add(snap.fileId);
    }
    const known = this.#known(serverId);
    for (const fileId of written) {
      const sha256 = before.get(fileId);
      if (sha256 === undefined || known.get(fileId)?.sha256 !== sha256) return;
    }
    this.#finish(row, "reverted", {});
  }

  /** History entries newest first; drafts are not history. */
  #historyRows(serverId: string): ChangeSetRow[] {
    const where = and(
      eq(changeSets.serverId, serverId),
      ne(changeSets.status, "draft"),
    );
    const at = sql`coalesce(${changeSets.appliedAt}, ${changeSets.updatedAt})`;
    return this.#store.db
      .select()
      .from(changeSets)
      .where(where)
      .orderBy(desc(at))
      .all();
  }

  /**
   * On Free a restore reaches only the 5 visible entries (402 otherwise).
   * The history page restores an entry one file per call, and each call adds
   * its rollback on top. Rollbacks of the entry's own snapshots do not count,
   * so every call of one restore gets the same answer: a multi-file entry is
   * restored whole or not at all.
   */
  #assertVisible(server: ServerRecord, snapshot: SnapshotRecord): void {
    const limit = this.#entitlement.limit("historyVisible");
    if (limit === null) return;
    const rows = this.#historyRows(server.id);
    const refused = limitReached("historyVisible", rows.length, limit);
    const owner = snapshot.changeSetId;
    if (owner === null) throw refused;
    const own = this.#snapshots.ofChangeSets([owner]).map((item) => item.id);
    const ownRestores = new Set(own);
    const counted = rows.filter((row) => !ownRestores.has(row.restoreOf ?? ""));
    const visible = counted.slice(0, limit).map((row) => row.id);
    if (visible.includes(owner)) return;
    throw refused;
  }

  /** GET /servers/SLUG/history (contract C5), limited to 5 on Free. */
  history(server: ServerRecord): History {
    const rows = this.#historyRows(server.id);
    const limit = this.#entitlement.limit("historyVisible");
    const visible = limit === null ? rows : rows.slice(0, limit);
    const kept = this.#snapshots.ofChangeSets(visible.map((row) => row.id));
    const entries = visible.map((row) => ({
      changeSetId: row.id,
      at: row.appliedAt ?? row.updatedAt,
      author: row.author,
      cause: row.cause as Cause,
      status: row.status as ChangeSetStatus,
      chips: (JSON.parse(row.diff) as Diff).semantic,
      snapshots: kept
        .filter((snapshot) => snapshot.changeSetId === row.id)
        .map((snapshot) => ({
          id: snapshot.id,
          fileId: snapshot.fileId,
          kind: snapshot.kind,
          at: snapshot.at,
        })),
    }));
    const hiddenCount = rows.length - visible.length;
    return { entries, visibleLimit: limit, hiddenCount };
  }
}
