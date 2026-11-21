// Test-only helpers: throwaway Ed25519 keys generated when the test run starts,
// and a signer for licence payloads. This file is outside src/, is not in the
// package "files", and its export path has only the "source" condition, so the
// image cannot import it. tools/licence/src/check-bundle.mjs fails the build if
// a bundle references it or carries an Ed25519 public key.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { KeyRing } from "../src/keys.js";
import type { LicencePayload } from "../src/token.js";

export interface TestKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

function pair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

/** Generated once per test run; never written anywhere. */
export const testKeys = {
  production: pair(),
  development: pair(),
  developmentNext: pair(),
  stranger: pair(),
};

/** The key ring tests inject instead of the compiled-in slots. */
export const testKeyRing: KeyRing = {
  production: [testKeys.production.publicKey],
  development: [
    testKeys.development.publicKey,
    testKeys.developmentNext.publicKey,
  ],
};

let counter = 0;

/** A fresh, valid ULID-shaped licence id. */
export function testLid(): string {
  counter += 1;
  return `01JD${String(counter).padStart(22, "0")}`;
}

export function customerPayload(
  overrides: Partial<LicencePayload> = {},
): LicencePayload {
  return {
    v: 1,
    lid: testLid(),
    plan: "paid",
    maxServers: 25,
    customer: { id: "cus-test", name: "Test Customer" },
    issuedAt: "2026-11-01T10:00:00Z",
    updatesUntil: "2027-11-01",
    kind: "customer",
    ...overrides,
  };
}

export function devPayload(
  overrides: Partial<LicencePayload> = {},
): LicencePayload {
  return customerPayload({
    kind: "internal-dev",
    customer: { id: "theriark-dev", name: "Theriark Development" },
    ...overrides,
  });
}

/** Signs a payload the way the issuer does: Ed25519 over the JSON bytes. */
export function signPayload(payload: unknown, privateKey: KeyObject): string {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, bytes, privateKey);
  return `DW1.${bytes.toString("base64url")}.${signature.toString("base64url")}`;
}

export function customerLicence(
  overrides: Partial<LicencePayload> = {},
): string {
  return signPayload(
    customerPayload(overrides),
    testKeys.production.privateKey,
  );
}

export function devLicence(overrides: Partial<LicencePayload> = {}): string {
  return signPayload(devPayload(overrides), testKeys.development.privateKey);
}
