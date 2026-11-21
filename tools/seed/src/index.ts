// Seed tool. tools/seed/seed-accounts.mjs (logic in src/lib.mjs) creates the
// owner through the setup API in P1; P8 adds admin, editor and viewer. Stage is
// seeded only after Gate 2, by the operator or the gate script, never by the
// crew. This folder is excluded from the image.

export const SEED_ENVIRONMENTS = ["dev", "stage"] as const;

export type SeedEnvironment = (typeof SEED_ENVIRONMENTS)[number];

export function parseSeedEnvironment(value: string): SeedEnvironment {
  const found = SEED_ENVIRONMENTS.find((env) => env === value);
  if (found === undefined) {
    throw new Error(`unknown seed environment: ${value}`);
  }
  return found;
}
