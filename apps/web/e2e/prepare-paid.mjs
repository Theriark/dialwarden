// Run by the e2e CI job only: generates a throwaway Ed25519 pair, writes the
// public key into the production slot of the from-source build (packages/
// entitlement/keys/production.pub, never committed) and signs one customer
// licence token the paid spec enters through the licence page, the way a
// customer does. The shipped image trusts no test key: this file writes the
// slot in the CI workspace only, and the private key never leaves the job.
/* eslint-disable security/detect-non-literal-fs-filename -- paths the CI job passes on the command line */
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [keysDir, tokenFile] = process.argv.slice(2);
if (keysDir === undefined || tokenFile === undefined) {
  console.error("usage: node prepare-paid.mjs <keys-dir> <token-file>");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
mkdirSync(keysDir, { recursive: true });
writeFileSync(
  join(keysDir, "production.pub"),
  `# CI e2e throwaway slot: generated at job time, never committed.\n${pem}`,
);

// The payload shape of packages/entitlement/src/token.ts: v, lid, plan,
// maxServers, customer, issuedAt, updatesUntil, kind.
const payload = {
  v: 1,
  lid: `01JD${"1".padStart(22, "0")}`,
  plan: "paid",
  maxServers: 25,
  customer: { id: "cus-e2e", name: "E2E Customer" },
  issuedAt: new Date().toISOString(),
  updatesUntil: "2027-12-31",
  kind: "customer",
};
const bytes = Buffer.from(JSON.stringify(payload));
const signature = sign(null, bytes, privateKey);
writeFileSync(
  tokenFile,
  `DW1.${bytes.toString("base64url")}.${signature.toString("base64url")}`,
);
console.log(`prepare-paid: licence token written, updates until 2027-12-31`);
