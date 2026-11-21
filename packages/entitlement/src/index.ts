// The licence key functionality of Dialwarden (LICENSING.md): build information,
// licence tokens, the public key slots, revocation, the feature registry, the
// CRA-safe rule and the gate every other module asks (getEntitlement, can,
// limit, isServerEditable). The Dockerfile turns the build arguments REVISION,
// SOURCE_DATE_EPOCH and FEATURE_BASELINE_EPOCH into the variables read here.
import type { FeatureKey, LimitKey } from "./registry.js";
import type { BuildDates, Entitlement } from "./rule.js";

export * from "./keys.js";
export * from "./registry.js";
export * from "./revocation.js";
export * from "./rule.js";
export * from "./token.js";

export interface BuildInfo {
  /** Full source commit SHA, or "unknown" outside an image build. */
  revision: string;
  /** Commit time of the built commit (ISO 8601, UTC), or null. */
  buildDate: string | null;
  /** Commit time of the feature release this build belongs to, or null. */
  featureBaseline: string | null;
}

const REVISION = /^[0-9a-f]{40}$/;
const EPOCH = /^[0-9]{1,12}$/;

/** Unix seconds as ISO 8601 without milliseconds, or null when not a valid epoch. */
export function epochToIso(value: string | undefined): string | null {
  if (value === undefined || !EPOCH.test(value)) {
    return null;
  }
  return new Date(Number(value) * 1000).toISOString().replace(".000Z", "Z");
}

export function readBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
): BuildInfo {
  const revision = env["DIALWARDEN_REVISION"] ?? "";
  return {
    revision: REVISION.test(revision) ? revision : "unknown",
    buildDate: epochToIso(env["DIALWARDEN_BUILD_EPOCH"]),
    featureBaseline: epochToIso(env["DIALWARDEN_FEATURE_BASELINE_EPOCH"]),
  };
}

/**
 * The dates the rule compares. Outside an image build (no build variables, for
 * example a run from source) the process start time stands in for both, so the
 * rule still has a fixed point that does not move with the clock.
 */
export function ruleDates(info: BuildInfo, startedAt: Date): BuildDates {
  const buildDate =
    info.buildDate === null ? startedAt : new Date(info.buildDate);
  const featureBaseline =
    info.featureBaseline === null ? buildDate : new Date(info.featureBaseline);
  return { buildDate, featureBaseline };
}

/**
 * The gate the server and every later phase ask. It reads the current
 * entitlement through a callback (the server's licence service) and the owner's
 * editable-server choice for the Free fallback (rnd-report-1 3.4).
 */
export class EntitlementGate {
  readonly #current: () => Entitlement;
  readonly #editableServers: () => readonly string[];

  constructor(
    current: () => Entitlement,
    editableServers: () => readonly string[],
  ) {
    this.#current = current;
    this.#editableServers = editableServers;
  }

  getEntitlement(): Entitlement {
    return this.#current();
  }

  can(feature: FeatureKey): boolean {
    // eslint-disable-next-line security/detect-object-injection -- typed FeatureKey
    return this.#current().features[feature];
  }

  /** The limit value; null means unlimited. */
  limit(name: LimitKey): number | null {
    // eslint-disable-next-line security/detect-object-injection -- typed LimitKey
    return this.#current().limits[name];
  }

  /** On Paid every server is editable; on Free only the owner's chosen three. */
  isServerEditable(id: string): boolean {
    if (this.#current().plan === "paid") {
      return true;
    }
    const max = this.limit("servers") ?? Number.POSITIVE_INFINITY;
    return this.#editableServers().slice(0, max).includes(id);
  }
}
