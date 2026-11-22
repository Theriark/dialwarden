// The CRA-safe entitlement rule (dev-work-plan P1-A step 5, legal-input-1 6.2)
// and the environment versus UI licence precedence (step 6, it-input-1 2.4).
//
// - A customer licence gives Paid when its signature is valid with a production
//   key, its salted lid hash is not revoked, and the image's featureBaseline is
//   on or before the end (UTC) of its updatesUntil day. A 27.0.x image carries the
//   baseline of v27.0.0, so security and fix releases keep Paid for every buyer
//   whose updatesUntil covers 27.0.0; a 27.1 image needs a newer updatesUntil.
// - An internal-dev licence gives Paid when its signature is valid with a
//   development key and the image's buildDate is within 120 days of issuedAt,
//   either side. updatesUntil is shown but not used.
// - A development-key signature on a customer payload, or a production-key
//   signature on an internal-dev payload, is invalid.
// - The clock is used only for the 30-day warning and for display.
import { verify, type KeyObject } from "node:crypto";
import {
  FREE_LIMITS,
  featureMap,
  paidLimits,
  type FeatureKey,
  type Limits,
} from "./registry.js";
import { isRevoked, lidHash8, REVOKED_LID_HASHES } from "./revocation.js";
import type { KeyRing } from "./keys.js";
import {
  parseToken,
  tokenLast6,
  type LicenceKind,
  type LicencePayload,
} from "./token.js";

export const LICENCE_STATES = [
  "active",
  "term_ended_for_this_version",
  "revoked",
  "invalid_signature",
  "malformed",
  "dev_window_passed",
  "none",
] as const;

export type LicenceState = (typeof LICENCE_STATES)[number];

const DAY_MS = 86_400_000;
export const DEV_WINDOW_DAYS = 120;
export const WARN_DAYS = 30;

/** Dates of the running image, as Date values (see readBuildInfo). */
export interface BuildDates {
  buildDate: Date;
  featureBaseline: Date;
}

export interface RuleContext {
  keys: KeyRing;
  build: BuildDates;
  revoked?: readonly string[];
}

export interface LicenceEvaluation {
  state: Exclude<LicenceState, "none">;
  /** The payload when it parsed; it is trusted only when state is active. */
  payload: LicencePayload | null;
  lidHash8: string | null;
  last6: string;
  /** Short machine reason for malformed tokens, otherwise null. */
  reason: string | null;
}

/** End of the updatesUntil day, UTC (inclusive). */
export function updatesUntilEnd(updatesUntil: string): Date {
  return new Date(Date.parse(`${updatesUntil}T00:00:00Z`) + DAY_MS - 1);
}

function verifiedBy(
  keys: readonly KeyObject[],
  payloadBytes: Buffer,
  signature: Buffer,
): boolean {
  return keys.some((key) => {
    try {
      return verify(null, payloadBytes, key, signature);
    } catch {
      return false;
    }
  });
}

function keysFor(kind: LicenceKind, ring: KeyRing): readonly KeyObject[] {
  return kind === "customer" ? ring.production : ring.development;
}

/** Evaluates one licence token against the rule. Never throws. */
export function evaluateLicence(
  input: string,
  context: RuleContext,
): LicenceEvaluation {
  const last6 = tokenLast6(input);
  const parsed = parseToken(input);
  if (!parsed.ok) {
    return {
      state: "malformed",
      payload: null,
      lidHash8: null,
      last6,
      reason: parsed.reason,
    };
  }
  const { payload, payloadBytes, signature } = parsed.token;
  const result = (state: LicenceEvaluation["state"]): LicenceEvaluation => ({
    state,
    payload,
    lidHash8: lidHash8(payload.lid),
    last6,
    reason: null,
  });
  const keys = keysFor(payload.kind, context.keys);
  if (!verifiedBy(keys, payloadBytes, signature)) {
    return result("invalid_signature");
  }
  if (isRevoked(payload.lid, context.revoked ?? REVOKED_LID_HASHES)) {
    return result("revoked");
  }
  if (payload.kind === "customer") {
    const baseline = context.build.featureBaseline.getTime();
    const end = updatesUntilEnd(payload.updatesUntil).getTime();
    return result(baseline <= end ? "active" : "term_ended_for_this_version");
  }
  const built = context.build.buildDate.getTime();
  const distance = Math.abs(built - Date.parse(payload.issuedAt));
  const inWindow = distance <= DEV_WINDOW_DAYS * DAY_MS;
  return result(inWindow ? "active" : "dev_window_passed");
}

export type LicenceSource = "none" | "ui" | "environment";

export interface LicenceSummary {
  lidHash8: string | null;
  last6: string;
  customerName: string | null;
  kind: LicenceKind | null;
  issuedAt: string | null;
  updatesUntil: string | null;
  warn30: boolean;
}

/** GET /api/v1/entitlement (contract C1; field names are fixed). */
export interface Entitlement {
  plan: "free" | "paid";
  state: LicenceState;
  source: LicenceSource;
  limits: Limits;
  features: Record<FeatureKey, boolean>;
  licence: LicenceSummary | null;
  envLicence: {
    present: boolean;
    state: LicenceState;
    ignored: boolean;
  };
  buildDate: string | null;
  featureBaseline: string | null;
}

export interface ResolveInput {
  /** The licence pasted in the UI, evaluated; null when none is stored. */
  ui: LicenceEvaluation | null;
  /** DIALWARDEN_LICENCE, evaluated once at start; null when not set. */
  env: LicenceEvaluation | null;
  /** settings.licence_env_ignored (the owner-only Free switch). */
  envIgnored: boolean;
  /** Build dates for display (ISO strings or null outside an image build). */
  buildDate: string | null;
  featureBaseline: string | null;
  now: Date;
}

function summarise(evaluation: LicenceEvaluation, now: Date): LicenceSummary {
  const payload = evaluation.payload;
  let warn30 = false;
  if (
    payload !== null &&
    evaluation.state === "active" &&
    payload.kind === "customer"
  ) {
    const end = updatesUntilEnd(payload.updatesUntil).getTime();
    warn30 = now.getTime() >= end - WARN_DAYS * DAY_MS;
  }
  return {
    lidHash8: evaluation.lidHash8,
    last6: evaluation.last6,
    customerName: payload?.customer.name ?? null,
    kind: payload?.kind ?? null,
    issuedAt: payload?.issuedAt ?? null,
    updatesUntil: payload?.updatesUntil ?? null,
    warn30,
  };
}

/**
 * The effective licence. A UI licence decides whenever one is stored, in
 * whatever state. Otherwise the environment licence decides unless the owner
 * chose the Free plan on this instance. Otherwise there is no licence (Free).
 */
export function resolveEntitlement(input: ResolveInput): Entitlement {
  let source: LicenceSource = "none";
  let effective: LicenceEvaluation | null = null;
  if (input.ui !== null) {
    source = "ui";
    effective = input.ui;
  } else if (input.env !== null && !input.envIgnored) {
    source = "environment";
    effective = input.env;
  }
  const paid = effective !== null && effective.state === "active";
  const maxServers = effective?.payload?.maxServers;
  return {
    plan: paid ? "paid" : "free",
    state: effective?.state ?? "none",
    source,
    limits: paid ? paidLimits(maxServers) : { ...FREE_LIMITS },
    features: featureMap(paid),
    licence: effective === null ? null : summarise(effective, input.now),
    envLicence: {
      present: input.env !== null,
      state: input.env?.state ?? "none",
      ignored: input.envIgnored,
    },
    buildDate: input.buildDate,
    featureBaseline: input.featureBaseline,
  };
}
