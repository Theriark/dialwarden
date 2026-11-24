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
// and the write path drops a masked secret, so a preset never carries a real
// secret. The built-in pack presets of P3 stay in the pack data, not here.
import { randomUUID } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import type { JsonValue, Pack, SettingEdit } from "@dialwarden/packs-schema";
import { eq } from "drizzle-orm";
import type { ChangeSetService } from "../changes/service.js";
import type { ChangeSetView } from "../changes/types.js";
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
  readonly now?: () => Date;
}

type PresetRow = typeof presets.$inferSelect;

export class PresetService {
  readonly #store: Store;
  readonly #packs: ReadonlyMap<string, Pack>;
  readonly #servers: ServerService;
  readonly #changes: ChangeSetService;
  readonly #entitlement: EntitlementGate;
  readonly #now: () => Date;

  constructor(options: PresetServiceOptions) {
    this.#store = options.store;
    this.#packs = options.packs;
    this.#servers = options.servers;
    this.#changes = options.changes;
    this.#entitlement = options.entitlement;
    this.#now = options.now ?? (() => new Date());
  }

  #viewOf(row: PresetRow): PresetView {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      packId: row.packId,
      createdAt: row.createdAt,
      values: JSON.parse(row.values) as Record<string, unknown>,
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
      values: JSON.stringify(input.values),
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
}
