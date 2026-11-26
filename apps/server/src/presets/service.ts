// The saved user presets (screen 7 of dev-work-plan P5): named bundles of
// typed setting values the owner creates from a server's current values, or
// a selection of them, and applies to any server of the same game. Applying
// goes through ChangeSetService, so a preset lands as a draft change set of
// cause preset (contract C5): the save dialog shows its diff, the normal
// apply path writes it and the history entry says cause preset.
//
// Free holds three presets (limit presets of contract C1): the fourth
// creation answers 402 with the upgrade body the web app renders. Paid is
// unlimited. The values come from the settings read, which masks secrets,
// and the write path drops a masked secret. A real secret sent through the
// API is stored and shown as the mask too (P10-A L11), so a preset never
// carries a real secret. The built-in pack presets of P3 stay in the pack
// data, not here.
//
// P9-A adds the bulk apply of the Paid plan (presets.bulk): drafts for many
// servers first, each with its own diff, then one apply per server with a
// report that keeps going past a failed server.
import { randomUUID } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import {
  SECRET_MASK,
  type JsonValue,
  type Pack,
  type SettingEdit,
} from "@dialwarden/packs-schema";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ChangeSetService } from "../changes/service.js";
import type {
  ChangeSetStatus,
  ChangeSetView,
  RunHooks,
} from "../changes/types.js";
import { ConnectorError } from "../connectors/types.js";
import { ControlError } from "../control/types.js";
import { presets } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError, limitReached } from "../http/errors.js";
import type { ServerService } from "../servers/service.js";

/** A saved preset as the API answers it (the web client's UserPreset). */
export interface PresetView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly packId: string;
  readonly createdAt: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** The body of POST /api/v1/presets (the web client's CreatePresetBody). */
export interface NewPreset {
  readonly name: string;
  readonly description: string;
  readonly packId: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface PresetServiceOptions {
  readonly store: Store;
  /** The game packs loaded at start, by pack id (contract C3). */
  readonly packs: ReadonlyMap<string, Pack>;
  readonly servers: ServerService;
  readonly changes: ChangeSetService;
  readonly entitlement: EntitlementGate;
  readonly log: FastifyBaseLogger;
  readonly now?: () => Date;
}

type PresetRow = typeof presets.$inferSelect;

/** The values with every non-empty secret setting replaced by the mask. */
function maskSecrets(
  pack: Pack | undefined,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const secret = new Set(
    (pack?.settings ?? [])
      .filter((setting) => setting.secret === true)
      .map((setting) => setting.key),
  );
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      secret.has(key) && value !== "" && value !== null ? SECRET_MASK : value,
    ]),
  );
}

export class PresetService {
  readonly #store: Store;
  readonly #packs: ReadonlyMap<string, Pack>;
  readonly #servers: ServerService;
  readonly #changes: ChangeSetService;
  readonly #entitlement: EntitlementGate;
  readonly #log: FastifyBaseLogger;
  readonly #now: () => Date;

  constructor(options: PresetServiceOptions) {
    this.#store = options.store;
    this.#packs = options.packs;
    this.#servers = options.servers;
    this.#changes = options.changes;
    this.#entitlement = options.entitlement;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  #viewOf(row: PresetRow): PresetView {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      packId: row.packId,
      createdAt: row.createdAt,
      values: maskSecrets(
        this.#packs.get(row.packId),
        JSON.parse(row.values) as Record<string, unknown>,
      ),
    };
  }

  #require(id: string): PresetRow {
    const row = this.#store.db
      .select()
      .from(presets)
      .where(eq(presets.id, id))
      .get();
    if (row === undefined) throw new ApiError(404, "preset_not_found");
    return row;
  }

  /** GET /api/v1/presets: the saved presets, oldest first like the servers. */
  list(): PresetView[] {
    const rows = this.#store.db
      .select()
      .from(presets)
      .orderBy(presets.createdAt, presets.id)
      .all();
    return rows.map((row) => this.#viewOf(row));
  }

  /**
   * POST /api/v1/presets: saves a named bundle of values of one game. The
   * pack must be loaded and every key a setting of it; on Free the fourth
   * preset answers 402 (limit presets of contract C1).
   */
  create(input: NewPreset): PresetView {
    const pack = this.#packs.get(input.packId);
    if (pack === undefined) {
      throw new ApiError(422, "unknown_game", { id: input.packId });
    }
    const known = new Set(pack.settings.map((setting) => setting.key));
    const unknown = Object.keys(input.values).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new ApiError(422, "unknown_setting", { keys: unknown });
    }
    const max = this.#entitlement.limit("presets");
    const current = this.list().length;
    if (max !== null && current >= max) {
      throw limitReached("presets", current, max);
    }
    const row: PresetRow = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      packId: input.packId,
      values: JSON.stringify(maskSecrets(pack, input.values)),
      createdAt: this.#now().toISOString(),
    };
    this.#store.db.insert(presets).values(row).run();
    return this.#viewOf(row);
  }

  /** DELETE /api/v1/presets/ID: servers that applied it keep their values. */
  remove(id: string): void {
    this.#require(id);
    this.#store.db.delete(presets).where(eq(presets.id, id)).run();
  }

  /**
   * POST /api/v1/presets/ID/apply: a draft change set of cause preset that
   * writes the preset's values to a server of the same game. The save dialog
   * shows its diff; the normal apply path writes it. Nothing to change
   * answers 422 no_change, a non-editable server on Free 402.
   */
  async apply(
    id: string,
    serverId: string,
    author: string,
  ): Promise<ChangeSetView> {
    const preset = this.#require(id);
    const server = this.#servers.require(serverId);
    if (server.packId !== preset.packId) {
      throw new ApiError(422, "pack_mismatch", {
        preset: preset.packId,
        server: server.packId,
      });
    }
    const values = JSON.parse(preset.values) as Record<string, JsonValue>;
    const edits: SettingEdit[] = Object.entries(values).map(([key, value]) => ({
      key,
      value,
    }));
    return this.#changes.create(server, { edits }, author, "preset");
  }

  /**
   * The error of one bulk item. An unexpected one is logged and answered as
   * internal, so the report of the servers already done is still answered.
   */
  #failureOf(error: unknown, server: string): BulkFailure {
    const failure = failureOf(error);
    if (failure.code === "internal") {
      this.#log.error({ err: error, server }, "bulk preset item failed");
    }
    return failure;
  }

  /**
   * POST /api/v1/presets/ID/bulk-drafts (Paid, presets.bulk): the per-server
   * diff first. Each server gets its own draft change set of cause preset,
   * made on its own files, exactly as a single apply makes it; a server the
   * caller may not write, or that does not exist, answers server_not_found
   * in its item, so the answer never tells which servers exist.
   */
  async bulkDrafts(
    id: string,
    serverIds: readonly string[],
    author: string,
    canWrite: (serverId: string) => boolean,
  ): Promise<BulkDraft[]> {
    this.#require(id);
    const items: BulkDraft[] = [];
    for (const server of new Set(serverIds)) {
      if (!this.#servers.exists(server) || !canWrite(server)) {
        items.push({ server, changeSet: null, error: notFound() });
        continue;
      }
      try {
        const changeSet = await this.apply(id, server, author);
        items.push({ server, changeSet, error: null });
      } catch (error) {
        const failure = this.#failureOf(error, server);
        items.push({ server, changeSet: null, error: failure });
      }
    }
    return items;
  }

  /**
   * POST /api/v1/presets/bulk-apply (Paid, presets.bulk): applies the drafts
   * the caller reviewed, one server after the other, each with the hook mode
   * of contract C5, and reports every one: a failure on one server never
   * stops the others. Only draft change sets of cause preset on servers the
   * caller may write are applied; any other id answers change_set_not_found
   * in its item.
   */
  async bulkApply(
    changeSetIds: readonly string[],
    author: string,
    runHooks: RunHooks,
    canWrite: (serverId: string) => boolean,
  ): Promise<BulkReport> {
    const items: BulkApplied[] = [];
    for (const id of new Set(changeSetIds)) {
      let found: ChangeSetView;
      try {
        found = this.#changes.get(id);
      } catch {
        items.push(refused(id, null, { code: "change_set_not_found" }));
        continue;
      }
      if (!canWrite(found.serverId)) {
        items.push(refused(id, null, { code: "change_set_not_found" }));
        continue;
      }
      if (found.cause !== "preset" || found.status !== "draft") {
        const error = { code: "not_a_preset_draft", status: found.status };
        items.push(refused(id, found.serverId, error));
        continue;
      }
      try {
        const done = await this.#changes.apply(id, author, runHooks);
        items.push({
          changeSetId: id,
          server: done.serverId,
          status: done.status,
          error: done.error === null ? null : { ...done.error },
        });
      } catch (error) {
        const failure = this.#failureOf(error, found.serverId);
        items.push(refused(id, found.serverId, failure));
      }
    }
    const count = (status: string) =>
      items.filter((item) => item.status === status).length;
    return {
      items,
      applied: count("applied"),
      pending: count("pending"),
      failed: items.length - count("applied") - count("pending"),
    };
  }
}

/** Why one server of a bulk action did not get its change. */
export interface BulkFailure {
  readonly code: string;
  readonly [detail: string]: unknown;
}

export interface BulkDraft {
  readonly server: string;
  readonly changeSet: ChangeSetView | null;
  readonly error: BulkFailure | null;
}

export interface BulkApplied {
  readonly changeSetId: string;
  readonly server: string | null;
  /** The change set's status after the apply, or refused. */
  readonly status: ChangeSetStatus | "refused";
  readonly error: BulkFailure | null;
}

/** The partial-failure report of a bulk apply. */
export interface BulkReport {
  readonly items: BulkApplied[];
  readonly applied: number;
  readonly pending: number;
  /** Everything neither applied nor pending: refused, failed or conflict. */
  readonly failed: number;
}

const notFound = (): BulkFailure => ({ code: "server_not_found" });

function refused(
  changeSetId: string,
  server: string | null,
  error: BulkFailure,
): BulkApplied {
  return { changeSetId, server, status: "refused", error };
}

/**
 * The answer of an API, connector or control failure as an item's error:
 * its code and the details the single call would have answered; any other
 * error is internal.
 */
function failureOf(error: unknown): BulkFailure {
  if (error instanceof ApiError) return { code: error.code, ...error.details };
  if (error instanceof ConnectorError || error instanceof ControlError) {
    return { code: error.code, message: error.message };
  }
  return { code: "internal" };
}
