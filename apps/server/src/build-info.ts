// Build information for the CRA-safe rule (dev-work-plan P1-A step 5). In
// production the commit, its commit time and the feature baseline come only
// from /app/build-info.json, which the Dockerfile writes from its build
// arguments (owned by root, read-only). An environment variable therefore
// cannot move the dates the rule compares, and an image built without them
// refuses to start. Outside production (tests, a run from source) the
// DIALWARDEN_* variables are read instead.
import { readFileSync } from "node:fs";
import { readBuildInfo, type BuildInfo } from "@dialwarden/entitlement";
import { z } from "zod";

export const BUILD_INFO_FILE = "/app/build-info.json";

const fileSchema = z.object({
  revision: z.string().max(64),
  buildEpoch: z.string().max(16),
  featureBaselineEpoch: z.string().max(16),
});

export function loadBuildInfo(
  env: NodeJS.ProcessEnv,
  file: string = BUILD_INFO_FILE,
): BuildInfo {
  if (env["NODE_ENV"] !== "production") {
    return readBuildInfo(env);
  }
  let parsed: z.infer<typeof fileSchema>;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path in the image; tests pass their own
    const text = readFileSync(file, "utf8");
    parsed = fileSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`cannot read the build information in ${file}`, {
      cause: error,
    });
  }
  const info = readBuildInfo({
    DIALWARDEN_REVISION: parsed.revision,
    DIALWARDEN_BUILD_EPOCH: parsed.buildEpoch,
    DIALWARDEN_FEATURE_BASELINE_EPOCH: parsed.featureBaselineEpoch,
  });
  if (info.buildDate === null || info.featureBaseline === null) {
    throw new Error(
      `${file} has no valid build dates: build the image with SOURCE_DATE_EPOCH and FEATURE_BASELINE_EPOCH`,
    );
  }
  return info;
}
