#!/usr/bin/env node
// The test-key check (dev-work-plan P1-A step 4): pnpm run build ends with it,
// so CI and the image build fail when a built bundle could carry a test key.
// - no private key block anywhere;
// - no reference to the entitlement test helpers and none of their names;
// - an Ed25519 public key only inside a key slot file
//   (packages/entitlement/keys/*.pub).
// Usage: node tools/licence/src/check-bundle.mjs [PATH ...]
/* eslint-disable security/detect-non-literal-fs-filename -- folders given on the command line and the files inside them */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TARGETS = [
  "apps/server/dist",
  "packages/entitlement/dist",
  "packages/entitlement/keys",
];

const MAX_FILE_BYTES = 32 * 1024 * 1024;

const RULES = [
  {
    name: "private key block",
    pattern: /-----BEGIN (?:[A-Z0-9]+ PRIVATE|PRIVATE) KEY-----/,
  },
  {
    name: "test helper reference",
    pattern: /@dialwarden\/entitlement\/testing|[\\/]test[\\/]testing\b/,
  },
  {
    name: "test helper name",
    pattern: /\b(?:testKeyRing|testKeys|customerLicence|devLicence)\b/,
  },
];

const PUBLIC_PEM = /-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]{40,}-----END/;
/** The fixed SPKI DER prefix of every Ed25519 public key, base64 and hex. */
const ED25519_SPKI_BASE64 = "MCowBQYDK2VwAyEA";
const ED25519_SPKI_HEX = "302a300506032b6570032100";

async function* files(path) {
  const info = await stat(path);
  if (info.isFile()) {
    yield path;
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      yield* files(child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

function isSlotFile(path) {
  const parts = resolve(path).split(sep);
  return (
    (parts.at(-1) ?? "").endsWith(".pub") &&
    parts.at(-2) === "keys" &&
    parts.at(-3) === "entitlement"
  );
}

function holdsPublicKey(text) {
  return (
    PUBLIC_PEM.test(text) ||
    text.includes(ED25519_SPKI_BASE64) ||
    text.toLowerCase().includes(ED25519_SPKI_HEX)
  );
}

/**
 * Scans files and folders. Returns the findings as { file, rule }. A missing
 * target throws (the build has not run). options.skip(path) leaves files out.
 */
export async function scan(targets, options = {}) {
  const skip = options.skip ?? (() => false);
  const findings = [];
  for (const target of targets) {
    for await (const file of files(target)) {
      if (skip(file) || (await stat(file)).size > MAX_FILE_BYTES) {
        continue;
      }
      const text = await readFile(file, "utf8");
      for (const rule of RULES) {
        if (rule.pattern.test(text)) {
          findings.push({ file, rule: rule.name });
        }
      }
      if (!isSlotFile(file) && holdsPublicKey(text)) {
        findings.push({ file, rule: "public key outside a key slot" });
      }
    }
  }
  return findings;
}

export async function main(args, io = process) {
  const targets = args.length > 0 ? args : DEFAULT_TARGETS;
  let findings;
  try {
    findings = await scan(targets);
  } catch (error) {
    io.stderr.write(`check-bundle: ${error.message} (build first)\n`);
    return 2;
  }
  for (const finding of findings) {
    io.stderr.write(`check-bundle: ${finding.rule}: ${finding.file}\n`);
  }
  if (findings.length > 0) {
    return 1;
  }
  io.stdout.write(`check-bundle: no test key in ${targets.join(", ")}\n`);
  return 0;
}

const invoked = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
