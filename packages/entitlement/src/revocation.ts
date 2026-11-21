// Revoked licences (dev-work-plan P1-A step 4, legal-input-1 5). The list holds
// salted SHA-256 hashes of licence ids, never raw ids: hex of
// sha256("dialwarden-revocation-v1:" + lid). It is compiled into the build and
// empty in 27.0.0; a revocation ships with a release.
import { createHash } from "node:crypto";

export const REVOCATION_SALT = "dialwarden-revocation-v1";

export const REVOKED_LID_HASHES: readonly string[] = [];

export function revocationHash(lid: string): string {
  return createHash("sha256")
    .update(`${REVOCATION_SALT}:${lid}`, "utf8")
    .digest("hex");
}

export function isRevoked(
  lid: string,
  revoked: readonly string[] = REVOKED_LID_HASHES,
): boolean {
  return revoked.includes(revocationHash(lid));
}

/** First 8 hex characters of sha256(lid): the only licence id form in logs and the API. */
export function lidHash8(lid: string): string {
  return createHash("sha256").update(lid, "utf8").digest("hex").slice(0, 8);
}
