// Activity events (contract C6). A row has type, serverId (optional), at, actor
// and data. Every module writes through record(); GET /api/v1/activity pages
// through them newest first, and the P9 notification channels subscribe by type.
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { activityEvents } from "../db/schema.js";
import type { Store } from "../db/store.js";

export const ACTIVITY_TYPES = [
  "change.applied",
  "change.pending",
  "change.conflict",
  "hook.run",
  "drift.detected",
  "schedule.run",
  "schedule.reverted",
  "backup.done",
  "backup.failed",
  "licence.changed",
  "user.changed",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** "system", or the e-mail address of the signed-in user who acted. */
export type Actor = string;

export interface ActivityEvent {
  id: number;
  type: ActivityType;
  serverId: string | null;
  at: string;
  actor: Actor;
  data: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityEvent[];
  /** Pass as before= to read the next (older) page; null on the last page. */
  nextBefore: number | null;
}

export type ActivityListener = (event: ActivityEvent) => void;

export interface RecordInput {
  serverId?: string;
  actor?: Actor;
  data?: Record<string, unknown>;
}

function parseData(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // A row written by hand; show it without data.
  }
  return {};
}

export class ActivityService {
  readonly #store: Store;
  readonly #now: () => Date;
  readonly #listeners = new Set<ActivityListener>();

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  record(type: ActivityType, input: RecordInput = {}): ActivityEvent {
    const row = {
      type,
      serverId: input.serverId ?? null,
      at: this.#now().toISOString(),
      actor: input.actor ?? "system",
      data: JSON.stringify(input.data ?? {}),
    };
    const inserted = this.#store.db
      .insert(activityEvents)
      .values(row)
      .returning({ id: activityEvents.id })
      .get();
    const event: ActivityEvent = {
      ...row,
      id: inserted.id,
      data: input.data ?? {},
    };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener never breaks the action that wrote the event.
      }
    }
    return event;
  }

  /** Subscribes to new events; returns the unsubscribe function. */
  subscribe(listener: ActivityListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  list(query: {
    before?: number;
    limit: number;
    type?: ActivityType;
    serverId?: string;
  }): ActivityPage {
    const conditions: SQL[] = [];
    if (query.before !== undefined) {
      conditions.push(lt(activityEvents.id, query.before));
    }
    if (query.type !== undefined) {
      conditions.push(eq(activityEvents.type, query.type));
    }
    if (query.serverId !== undefined) {
      conditions.push(eq(activityEvents.serverId, query.serverId));
    }
    const rows = this.#store.db
      .select()
      .from(activityEvents)
      .where(and(...conditions))
      .orderBy(desc(activityEvents.id))
      .limit(query.limit + 1)
      .all();
    const page = rows.slice(0, query.limit);
    const items = page.map((row) => ({
      id: row.id,
      type: row.type as ActivityType,
      serverId: row.serverId,
      at: row.at,
      actor: row.actor,
      data: parseData(row.data),
    }));
    const last = page.at(-1);
    const more = rows.length > query.limit && last !== undefined;
    return { items, nextBefore: more ? last.id : null };
  }
}
