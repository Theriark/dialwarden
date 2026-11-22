// Password hashing with argon2id (dev-work-plan P1-A step 3), OWASP parameters:
// 19 MiB memory, 2 iterations, 1 lane.
import { argon2id, hash, verify } from "argon2";

export const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(
  stored: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;

/**
 * Spends the same work as a real check when the account does not exist, so the
 * answer time does not tell whether an e-mail address is registered.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummy ??= hashPassword("dialwarden-timing-equaliser");
  await verifyPassword(await dummy, plain);
  return false;
}
