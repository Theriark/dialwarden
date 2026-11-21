// Build information the licence rule reads (rnd-report-1 3.3, P1 CRA rule).
// The Dockerfile turns the build arguments REVISION, SOURCE_DATE_EPOCH and
// FEATURE_BASELINE_EPOCH into the variables read here. P1 adds the licence
// verification and the feature registry (src/registry.ts) to this package.

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

export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const revision = env["DIALWARDEN_REVISION"] ?? "";
  return {
    revision: REVISION.test(revision) ? revision : "unknown",
    buildDate: epochToIso(env["DIALWARDEN_BUILD_EPOCH"]),
    featureBaseline: epochToIso(env["DIALWARDEN_FEATURE_BASELINE_EPOCH"]),
  };
}
