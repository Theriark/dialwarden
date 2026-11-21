// Seed tool. P1 creates the owner through the setup API; P8 adds admin, editor
// and viewer. Stage is seeded only after Gate 2, by the operator or the gate
// script, never by the crew. This folder is excluded from the image.

export const SEED_ENVIRONMENTS = ["development", "stage"] as const;

export type SeedEnvironment = (typeof SEED_ENVIRONMENTS)[number];

export function parseSeedEnvironment(value: string): SeedEnvironment {
  const found = SEED_ENVIRONMENTS.find((env) => env === value);
  if (found === undefined) {
    throw new Error(`unknown seed environment: ${value}`);
  }
  return found;
}
