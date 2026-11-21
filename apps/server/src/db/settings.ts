// Instance settings: one JSON value per key in the settings table.
import { eq } from "drizzle-orm";
import { settings } from "./schema.js";
import type { Store } from "./store.js";

export const SETTING_KEYS = {
  /** The owner's "Use the Free plan on this instance" switch (C1). */
  licenceEnvIgnored: "licence_env_ignored",
  /** The owner's three editable servers on Free (rnd-report-1 3.4). */
  editableServers: "plan.editable_servers",
  /** The owner confirmed the generated app-secret.key is backed up. */
  appKeyBackedUp: "app_secret.backup_acknowledged",
} as const;

export class Settings {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  get(key: string): unknown {
    const row = this.#store.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    if (row === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }

  getBoolean(key: string): boolean {
    return this.get(key) === true;
  }

  getStrings(key: string): string[] {
    const value = this.get(key);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === "string");
  }

  set(key: string, value: unknown): void {
    const text = JSON.stringify(value);
    this.#store.db
      .insert(settings)
      .values({ key, value: text })
      .onConflictDoUpdate({ target: settings.key, set: { value: text } })
      .run();
  }
}
