// The audit log (dev-work-plan P8-A step 3): hash-chained, each row storing
// the hash of the row before it. The hash is an HMAC-SHA256 under a key
// derived from APP_SECRET_KEY (label dialwarden-audit-chain), so someone who
// can only write the database cannot recompute the chain after an edit (D8).
// It covers id, at, actor_id, action, target_type, target_id, server_id,
// data and prev_hash; the client address sits outside it, and names live in
// audit_actors, so the IP setting and an erasure never break the chain (D9).
// The newest row is anchored in the settings table (an HMAC of its id and
// hash), so deleting the newest rows is seen too; audit retention moves the
// start of the chain forward and writes a checkpoint row.
//
// Recording never stops, on any plan: security events matter most when the
// plan changes (R&D default D5).
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import { auditActors, auditEvents } from "../db/schema.js";
import type { Settings } from "../db/settings.js";
import type { Store } from "../db/store.js";
import { auditAddress, IP_MODES, type IpMode } from "./ip.js";

export const GENESIS = "0".repeat(64);
const SETTINGS_KEY = "audit.settings";
const HEAD_KEY = "audit.head";
const BASE_KEY = "audit.base";
const DAY_MS = 86_400_000;

export interface AuditSettings {
  ipMode: IpMode;
  /** Rows older than this many days are removed; null keeps every row. */
  retentionDays: number | null;
}

/** Privacy by default: a truncated address until the owner chooses. */
export const DEFAULT_AUDIT_SETTINGS: AuditSettings = {
  ipMode: "truncated",
  retentionDays: null,
};

export interface AuditInput {
  /** A user id, or system or anonymous. */
  actorId: string;
  /** The label of the actor (the e-mail address of a user). */
  actorLabel?: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  serverId?: string | null;
  /** Ids and codes only: never names, e-mail addresses or secrets. */
  data?: Record<string, unknown>;
  /** The client address before the IP setting is applied. */
  ip?: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: { id: string; label: string; erased: boolean };
  action: string;
  targetType: string | null;
  targetId: string | null;
  serverId: string | null;
  data: Record<string, unknown>;
  ip: string | null;
}

export interface AuditQuery {
  before?: number;
  limit: number;
  actorId?: string;
  action?: string;
  serverId?: string;
  from?: string;
  to?: string;
}

export interface AuditPage {
  items: AuditEntry[];
  /** Pass as before= for the next (older) page; null on the last page. */
  nextBefore: number | null;
}

export type Verification =
  | { valid: true; count: number; headHash: string }
  | { valid: false; firstBrokenId: number | null; reason: string };

type Row = typeof auditEvents.$inferSelect;
type ActorRow = typeof auditActors.$inferSelect;

interface Link {
  id: number;
  hash: string;
  mac: string;
}

/** The canonical text a row's hash covers (ip and hash excluded). */
export function canonical(row: Omit<Row, "ip" | "hash">): string {
  return JSON.stringify([
    row.id,
    row.at,
    row.actorId,
    row.action,
    row.targetType,
    row.targetId,
    row.serverId,
    row.data,
    row.prevHash,
  ]);
}

function parseData(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // A row written by hand shows without data; verify still reports it.
  }
  return {};
}

/** A copy with every object's keys in sorted order (a stable hash, D8). */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries.map(([key, item]) => [key, sorted(item)]));
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface AuditServiceOptions {
  store: Store;
  settings: Settings;
  appKey: Buffer;
  now?: () => Date;
}

export class AuditService {
  readonly #store: Store;
  readonly #settings: Settings;
  readonly #key: Buffer;
  readonly #now: () => Date;

  constructor(options: AuditServiceOptions) {
    this.#store = options.store;
    this.#settings = options.settings;
    const key = hkdfSync(
      "sha256",
      options.appKey,
      Buffer.alloc(0),
      "dialwarden-audit-chain",
      32,
    );
    this.#key = Buffer.from(key);
    this.#now = options.now ?? (() => new Date());
  }

  #mac(text: string): string {
    return createHmac("sha256", this.#key).update(text, "utf8").digest("hex");
  }

  /** The hash a row must carry. */
  hashOf(row: Omit<Row, "ip" | "hash">): string {
    return this.#mac(canonical(row));
  }

  #link(key: string): Link | null {
    const value = this.#settings.get(key);
    if (typeof value !== "object" || value === null) return null;
    const { id, hash, mac } = value as Partial<Link>;
    if (typeof id !== "number" || typeof hash !== "string") return null;
    if (typeof mac !== "string") return null;
    return { id, hash, mac };
  }

  #setLink(key: string, id: number, hash: string): void {
    const mac = this.#mac(`${key}|${String(id)}|${hash}`);
    this.#settings.set(key, { id, hash, mac });
  }

  #linkValid(key: string, link: Link): boolean {
    const mac = this.#mac(`${key}|${String(link.id)}|${link.hash}`);
    return sameHex(mac, link.mac);
  }

  settingsOf(): AuditSettings {
    const value = this.#settings.get(SETTINGS_KEY);
    if (typeof value !== "object" || value === null) {
      return { ...DEFAULT_AUDIT_SETTINGS };
    }
    const { ipMode, retentionDays } = value as Partial<AuditSettings>;
    const modes: readonly string[] = IP_MODES;
    return {
      ipMode: modes.includes(ipMode ?? "")
        ? (ipMode as IpMode)
        : DEFAULT_AUDIT_SETTINGS.ipMode,
      retentionDays:
        typeof retentionDays === "number" && retentionDays > 0
          ? retentionDays
          : null,
    };
  }

  setSettings(change: Partial<AuditSettings>): AuditSettings {
    const next = { ...this.settingsOf(), ...change };
    this.#settings.set(SETTINGS_KEY, next);
    return this.settingsOf();
  }

  /** The address as the IP setting keeps it (sessions use it too, D18). */
  address(ip: string | null | undefined): string | null {
    return auditAddress(ip ?? undefined, this.settingsOf().ipMode);
  }

  /** Appends one row to the chain, in one transaction with the head read. */
  record(input: AuditInput): number {
    const ip = this.address(input.ip);
    const at = this.#now().toISOString();
    const data = JSON.stringify(sorted(input.data ?? {}));
    return this.#store.sqlite.transaction((): number => {
      const db = this.#store.db;
      const head = db
        .select({ id: auditEvents.id, hash: auditEvents.hash })
        .from(auditEvents)
        .orderBy(desc(auditEvents.id))
        .limit(1)
        .get();
      const base = this.#link(BASE_KEY);
      const prev = head ?? base ?? { id: 0, hash: GENESIS };
      const unhashed = {
        id: prev.id + 1,
        at,
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        serverId: input.serverId ?? null,
        data,
        prevHash: prev.hash,
      };
      const hash = this.hashOf(unhashed);
      db.insert(auditEvents)
        .values({ ...unhashed, ip, hash })
        .run();
      this.#setLink(HEAD_KEY, unhashed.id, hash);
      if (input.actorLabel !== undefined) {
        this.#actor(input.actorId, input.actorLabel);
      }
      return unhashed.id;
    })();
  }

  /** Keeps the label of a living actor; an erased label stays erased. */
  #actor(id: string, label: string): void {
    const db = this.#store.db;
    const found = db
      .select({ erased: auditActors.erased })
      .from(auditActors)
      .where(eq(auditActors.id, id))
      .get();
    if (found?.erased === 1) return;
    db.insert(auditActors)
      .values({ id, label, erased: 0 })
      .onConflictDoUpdate({ target: auditActors.id, set: { label } })
      .run();
  }

  #conditions(query: Omit<AuditQuery, "limit">): SQL[] {
    const conditions: SQL[] = [];
    if (query.before !== undefined) {
      conditions.push(lt(auditEvents.id, query.before));
    }
    if (query.actorId !== undefined) {
      conditions.push(eq(auditEvents.actorId, query.actorId));
    }
    if (query.action !== undefined) {
      conditions.push(eq(auditEvents.action, query.action));
    }
    if (query.serverId !== undefined) {
      conditions.push(eq(auditEvents.serverId, query.serverId));
    }
    if (query.from !== undefined) {
      conditions.push(gte(auditEvents.at, query.from));
    }
    if (query.to !== undefined) {
      conditions.push(lte(auditEvents.at, query.to));
    }
    return conditions;
  }

  #entries(rows: readonly Row[]): AuditEntry[] {
    const actors = new Map<string, ActorRow>();
    for (const actor of this.#store.db.select().from(auditActors).all()) {
      actors.set(actor.id, actor);
    }
    return rows.map((row) => {
      const actor = actors.get(row.actorId);
      return {
        id: row.id,
        at: row.at,
        actor: {
          id: row.actorId,
          label: actor?.label ?? row.actorId,
          erased: actor?.erased === 1,
        },
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        serverId: row.serverId,
        data: parseData(row.data),
        ip: row.ip,
      };
    });
  }

  /** Newest first, paged with before=. */
  list(query: AuditQuery): AuditPage {
    const rows = this.#store.db
      .select()
      .from(auditEvents)
      .where(and(...this.#conditions(query)))
      .orderBy(desc(auditEvents.id))
      .limit(query.limit + 1)
      .all();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const more = rows.length > query.limit && last !== undefined;
    return { items: this.#entries(page), nextBefore: more ? last.id : null };
  }

  /** Every matching row, oldest first (the CSV export). */
  all(query: Omit<AuditQuery, "limit" | "before">): AuditEntry[] {
    const rows = this.#store.db
      .select()
      .from(auditEvents)
      .where(and(...this.#conditions(query)))
      .orderBy(asc(auditEvents.id))
      .all();
    return this.#entries(rows);
  }

  /**
   * Walks the chain from its start (the genesis, or the checkpoint audit
   * retention left) to the anchored head: every id follows the one before,
   * every row names the hash of the row before, and every hash is right.
   */
  verify(): Verification {
    const rows = this.#store.db
      .select()
      .from(auditEvents)
      .orderBy(asc(auditEvents.id))
      .all();
    const base = this.#link(BASE_KEY);
    if (base !== null && !this.#linkValid(BASE_KEY, base)) {
      const first = rows.at(0)?.id ?? null;
      return { valid: false, firstBrokenId: first, reason: "base_invalid" };
    }
    let prev = base ?? { id: 0, hash: GENESIS };
    for (const row of rows) {
      const broken = (reason: string): Verification => ({
        valid: false,
        firstBrokenId: row.id,
        reason,
      });
      if (row.id !== prev.id + 1) return broken("gap");
      if (row.prevHash !== prev.hash) return broken("prev_mismatch");
      const expected = this.hashOf(row);
      if (!sameHex(expected, row.hash)) return broken("hash_mismatch");
      prev = { id: row.id, hash: row.hash };
    }
    const head = this.#link(HEAD_KEY);
    const headOk =
      head === null
        ? rows.length === 0
        : this.#linkValid(HEAD_KEY, head) &&
          head.id === prev.id &&
          head.hash === prev.hash;
    if (!headOk) {
      return { valid: false, firstBrokenId: null, reason: "head_mismatch" };
    }
    return { valid: true, count: rows.length, headHash: prev.hash };
  }

  /**
   * Audit retention (a privacy control): removes the rows older than the
   * retention days, moves the start of the chain to the last removed row and
   * records a checkpoint row. Returns how many rows went.
   */
  prune(): number {
    const days = this.settingsOf().retentionDays;
    if (days === null) return 0;
    const cutoff = new Date(this.#now().getTime() - days * DAY_MS);
    return this.pruneBefore(cutoff.toISOString());
  }

  /** Removes the rows recorded before a time (see prune). */
  pruneBefore(cutoff: string): number {
    const removed = this.#store.sqlite.transaction((): number => {
      const db = this.#store.db;
      const last = db
        .select({ id: auditEvents.id, hash: auditEvents.hash })
        .from(auditEvents)
        .where(lt(auditEvents.at, cutoff))
        .orderBy(desc(auditEvents.id))
        .limit(1)
        .get();
      if (last === undefined) return 0;
      const gone = db
        .delete(auditEvents)
        .where(lte(auditEvents.id, last.id))
        .run();
      this.#setLink(BASE_KEY, last.id, last.hash);
      return gone.changes;
    })();
    if (removed > 0) {
      this.record({
        actorId: "system",
        action: "audit.checkpoint",
        data: { removed },
      });
    }
    return removed;
  }
}
