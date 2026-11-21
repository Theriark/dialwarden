// The test-key-not-in-bundle check (dev-work-plan P1-A step 4).
/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "./check-bundle.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const folders = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

/** A synthetic bundle folder with the given files. */
async function bundle(entries) {
  const dir = await mkdtemp(join(tmpdir(), "dialwarden-bundle-"));
  folders.push(dir);
  for (const [name, text] of entries) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return dir;
}

function throwawayKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const rules = async (dir) => (await scan([dir])).map((found) => found.rule);
const isTest = (path) => /\.test\.[cm]?[jt]s$/.test(path);

describe("check-bundle", () => {
  it("passes a clean bundle", async () => {
    const dir = await bundle([["main.js", 'export const plan = "free";\n']]);
    expect(await scan([dir])).toEqual([]);
  });

  it("finds a reference to the test helpers", async () => {
    const dir = await bundle([
      ["main.js", 'import { testKeyRing } from "@dialwarden/entitlement/testing";\n'],
    ]);
    expect(await rules(dir)).toEqual([
      "test helper reference",
      "test helper name",
    ]);
  });

  it("finds a private key", async () => {
    const { privatePem } = throwawayKeys();
    const dir = await bundle([["keys.js", `const k = \`${privatePem}\`;\n`]]);
    expect(await rules(dir)).toContain("private key block");
  });

  it("finds a public key outside a key slot, as PEM or as base64", async () => {
    const { publicPem, spki } = throwawayKeys();
    const pem = await bundle([["a.js", `const k = \`${publicPem}\`;\n`]]);
    expect(await rules(pem)).toEqual(["public key outside a key slot"]);
    const raw = await bundle([["b.js", `const k = "${spki}";\n`]]);
    expect(await rules(raw)).toEqual(["public key outside a key slot"]);
  });

  it("accepts a public key in a key slot file", async () => {
    const { publicPem } = throwawayKeys();
    const slot = "packages/entitlement/keys/development-current.pub";
    const dir = await bundle([[slot, `# fingerprint\n${publicPem}`]]);
    expect(await scan([dir])).toEqual([]);
  });

  it("refuses a missing target (the build has not run)", async () => {
    await expect(scan([join(tmpdir(), "dialwarden-no-such-dist")])).rejects.toThrow();
  });

  it("the shipped sources reference no test helper and hold no test key", async () => {
    const targets = [
      "apps/server/src",
      "packages/entitlement/src",
      "packages/entitlement/keys",
    ].map((path) => join(root, path));
    expect(await scan(targets, { skip: isTest })).toEqual([]);
  });

  const built = join(root, "apps/server/dist");
  it.skipIf(!existsSync(built))("the built bundle holds no test key", async () => {
    const targets = [
      "apps/server/dist",
      "packages/entitlement/dist",
      "packages/entitlement/keys",
    ]
      .map((path) => join(root, path))
      .filter((path) => existsSync(path));
    expect(await scan(targets)).toEqual([]);
  });
});
