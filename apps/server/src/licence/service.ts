// Licences (dev-work-plan P1-A step 6, it-input-1 2.4).
// - DIALWARDEN_LICENCE is read once at start and held in memory only: never
//   written to the database, never logged. Logs show the state and lidHash8.
// - A licence pasted in the UI is stored in the licence table, encrypted with
//   APP_SECRET_KEY. While one is stored it decides, in whatever state.
// - Removing it falls back to the environment licence at once; the owner-only
//   switch settings.licence_env_ignored turns the environment licence off.
// - An invalid environment licence never blocks the start: the app runs Free and
//   the licence page shows the reason.
// - The API never returns a token (see the Entitlement type), and every change
//   writes the activity event licence.changed.
import {
  evaluateLicence,
  resolveEntitlement,
  type BuildInfo,
  type Entitlement,
  type LicenceEvaluation,
  type RuleContext,
} from "@dialwarden/entitlement";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ActivityService } from "../activity/service.js";
import type { Aead } from "../crypto/aead.js";
import { licence } from "../db/schema.js";
import { SETTING_KEYS, type Settings } from "../db/settings.js";
import type { Store } from "../db/store.js";

export const LICENCE_CONTEXT = "licence.token";

// Log entries use the key licenceState: the logger redacts any field named
// licence (log.ts), and these entries must show the state and lidHash8.
function logFields(evaluation: LicenceEvaluation) {
  return {
    state: evaluation.state,
    lidHash8: evaluation.lidHash8,
    reason: evaluation.reason,
  };
}

export interface LicenceServiceOptions {
  store: Store;
  settings: Settings;
  aead: Aead;
  activity: ActivityService;
  rule: RuleContext;
  build: BuildInfo;
  envLicence: string | null;
  log: FastifyBaseLogger;
  now?: () => Date;
}

export class LicenceService {
  readonly #options: LicenceServiceOptions;
  readonly #env: LicenceEvaluation | null;
  readonly #now: () => Date;
  #ui: LicenceEvaluation | null | undefined = undefined;

  constructor(options: LicenceServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#env =
      options.envLicence === null
        ? null
        : evaluateLicence(options.envLicence, options.rule);
    if (this.#env !== null) {
      options.log.info(
        { licenceState: { source: "environment", ...logFields(this.#env) } },
        "environment licence read",
      );
    }
  }

  /** The stored UI licence, evaluated (cached until it changes). */
  #uiLicence(): LicenceEvaluation | null {
    if (this.#ui !== undefined) {
      return this.#ui;
    }
    const row = this.#options.store.db
      .select({ tokenEnc: licence.tokenEnc })
      .from(licence)
      .where(eq(licence.id, 1))
      .get();
    if (row === undefined) {
      this.#ui = null;
      return null;
    }
    let stored: string;
    try {
      stored = this.#options.aead.decryptText(row.tokenEnc, LICENCE_CONTEXT);
    } catch (error) {
      this.#options.log.error(
        { err: error },
        "the stored licence does not decrypt with APP_SECRET_KEY",
      );
      this.#ui = {
        state: "malformed",
        payload: null,
        lidHash8: null,
        last6: "",
        reason: "undecryptable",
      };
      return this.#ui;
    }
    this.#ui = evaluateLicence(stored, this.#options.rule);
    return this.#ui;
  }

  /** Forget the cached UI licence (after an import replaced the database). */
  reload(): void {
    this.#ui = undefined;
  }

  current(): Entitlement {
    return resolveEntitlement({
      ui: this.#uiLicence(),
      env: this.#env,
      envIgnored: this.#options.settings.getBoolean(
        SETTING_KEYS.licenceEnvIgnored,
      ),
      buildDate: this.#options.build.buildDate,
      featureBaseline: this.#options.build.featureBaseline,
      now: this.#now(),
    });
  }

  /**
   * Stores a licence pasted in the UI. A token that does not parse or whose
   * signature is invalid is refused (and not stored); a verified licence is
   * stored in any other state, so an ended licence can be tested.
   */
  setUiLicence(input: string, actor: string): LicenceEvaluation {
    const evaluation = evaluateLicence(input, this.#options.rule);
    if (
      evaluation.state === "malformed" ||
      evaluation.state === "invalid_signature"
    ) {
      return evaluation;
    }
    const tokenEnc = this.#options.aead.encrypt(input.trim(), LICENCE_CONTEXT);
    const updatedAt = this.#now().toISOString();
    this.#options.store.db
      .insert(licence)
      .values({ id: 1, tokenEnc, updatedAt, updatedBy: actor })
      .onConflictDoUpdate({
        target: licence.id,
        set: { tokenEnc, updatedAt, updatedBy: actor },
      })
      .run();
    this.#ui = evaluation;
    this.#changed("set", actor);
    return evaluation;
  }

  removeUiLicence(actor: string): boolean {
    const result = this.#options.store.db
      .delete(licence)
      .where(eq(licence.id, 1))
      .run();
    this.#ui = null;
    if (result.changes === 0) {
      return false;
    }
    this.#changed("removed", actor);
    return true;
  }

  setEnvIgnored(ignored: boolean, actor: string): void {
    this.#options.settings.set(SETTING_KEYS.licenceEnvIgnored, ignored);
    this.#changed(ignored ? "environment_ignored" : "environment_used", actor);
  }

  #changed(action: string, actor: string): void {
    const now = this.current();
    const data = {
      action,
      source: now.source,
      plan: now.plan,
      state: now.state,
      lidHash8: now.licence?.lidHash8 ?? null,
    };
    this.#options.activity.record("licence.changed", { actor, data });
    this.#options.log.info({ licenceState: data }, "licence changed");
  }
}
