// Build information for the CRA-safe rule (dev-work-plan P1-A step 5). The
// commit, its commit time and the feature baseline come from
// /app/build-info.json, which the Dockerfile writes from its build arguments
// (owned by root, read-only). Whenever that file exists only the file counts,
// whatever NODE_ENV says, so an environment variable cannot move the dates the
// rule compares (security review THE-2151 N1). An unreadable or invalid file
// refuses start. Only when the file is absent (tests, CI, a run from source)
// are the DIALWARDEN_* variables read, and in production an absent file
// refuses start too.
import { readFileSync } from "node:fs";
import { readBuildInfo, type BuildInfo } from "@dialwarden/entitlement";
import { z } from "zod";

export const BUILD_INFO_FILE = "/app/build-info.json";

const fileSchema = z.object({
  revision: z.string().max(64),
  buildEpoch: z.string().max(16),
  featureBaselineEpoch: z.string().max(16),
});

/** The file's text, or null when it does not exist. */
function readIfPresent(file: string): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path in the image; tests pass their own
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`cannot read the build information in ${file}`, {
      cause: error,
    });
  }
}

export function loadBuildInfo(
  env: NodeJS.ProcessEnv,
  file: string = BUILD_INFO_FILE,
): BuildInfo {
  const text = readIfPresent(file);
  if (text === null) {
    if (env["NODE_ENV"] === "production") {
      throw new Error(`cannot read the build information in ${file}`);
    }
    return readBuildInfo(env);
  }
  let parsed: z.infer<typeof fileSchema>;
  try {
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
