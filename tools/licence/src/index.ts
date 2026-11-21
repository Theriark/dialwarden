// Development licence helper. P1 adds the test-key tooling used by CI; the
// production key pair stays with Ruben and is never used here. This folder is
// excluded from the image (the runtime stage copies only the server deploy).

/** Every Dialwarden licence token starts with this version prefix. */
export const TOKEN_PREFIX = "DW1";

export function hasTokenPrefix(token: string): boolean {
  return token.startsWith(`${TOKEN_PREFIX}.`);
}
