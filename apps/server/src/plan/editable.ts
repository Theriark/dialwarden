// The Free fallback (dev-work-plan P1-A step 7, rnd-report-1 3.4): on Free the
// owner picks 3 editable servers; without a choice the 3 most recently edited
// ones are editable. Servers exist from P4: P4-B plugs in the two providers
// (recently edited ids, and whether an id exists) and calls
// app.ctx.entitlement.isServerEditable(id) before every write.
import { FREE_LIMITS } from "@dialwarden/entitlement";
import { ApiError } from "../http/errors.js";
import { SETTING_KEYS, type Settings } from "../db/settings.js";

export const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface EditableProviders {
  /** Server ids, most recently edited first. */
  recentlyEdited: () => readonly string[];
  /** True when a server with this id exists. */
  exists: (id: string) => boolean;
}

const NO_SERVERS: EditableProviders = {
  recentlyEdited: () => [],
  exists: () => true,
};

export class EditableServers {
  readonly #settings: Settings;
  #providers: EditableProviders = NO_SERVERS;

  constructor(settings: Settings) {
    this.#settings = settings;
  }

  /** Called once by P4-B when the servers module starts. */
  setProviders(providers: EditableProviders): void {
    this.#providers = providers;
  }

  get max(): number {
    return FREE_LIMITS.servers ?? 3;
  }

  /** The owner's choice, without ids that no longer exist. */
  chosen(): string[] {
    return this.#settings
      .getStrings(SETTING_KEYS.editableServers)
      .filter((id) => this.#providers.exists(id))
      .slice(0, this.max);
  }

  /** The ids editable on Free: the owner's choice, else the most recent. */
  effective(): string[] {
    const chosen = this.chosen();
    if (chosen.length > 0) {
      return chosen;
    }
    return this.#providers.recentlyEdited().slice(0, this.max);
  }

  set(ids: readonly string[]): string[] {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) {
      throw new ApiError(422, "duplicate_server");
    }
    if (unique.length > this.max) {
      throw new ApiError(422, "too_many_servers", { max: this.max });
    }
    const unknown = unique.filter((id) => !this.#providers.exists(id));
    if (unknown.length > 0) {
      throw new ApiError(422, "unknown_server", { servers: unknown });
    }
    this.#settings.set(SETTING_KEYS.editableServers, unique);
    return this.effective();
  }
}
