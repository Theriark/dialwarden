// The instance SSH key pair (dev-work-plan P4-A step 2): made once, stored
// only encrypted with APP_SECRET_KEY, and re-encrypted by the app backup
// import like every other registered column.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { testApp, type TestApp } from "../../test/helpers.js";
import { reencrypt } from "../backup/import.js";
import { createAead, ENCRYPTED_COLUMNS } from "../crypto/aead.js";
import { DB_FILE } from "../db/store.js";
import { publicKeyFingerprint } from "./host-key.js";
import {
  type GeneratedPair,
  InstanceKey,
  KEY_ATTEMPTS,
  KEY_CONTEXT,
  parsesBack,
  usableInstanceKey,
} from "./keys.js";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe("instance SSH key", () => {
  it("is made once and its private key is a working Ed25519 key", async () => {
    current = await testApp();
    const { key } = current.app.ctx.connectors;
    const first = key.publicKey();
    expect(key.publicKey()).toEqual(first);
    expect(first.fingerprint).toBe(publicKeyFingerprint(first.publicKey));
    const parsed = ssh2.utils.parseKey(key.privateKey());
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe("ssh-ed25519");
    // The private key matches the public key shown to the owner.
    const blob = parsed.getPublicSSH().toString("base64");
    expect(first.publicKey.split(" ")[1]).toBe(blob);
  });

  it("is a registered encrypted column, re-encrypted by an import", async () => {
    expect(ENCRYPTED_COLUMNS).toContainEqual({
      table: "instance_ssh_key",
      column: "private_key_enc",
      context: "instance_ssh_key.private_key",
    });
    current = await testApp();
    const { app, dataDir } = current;
    const privateKey = app.ctx.connectors.key.privateKey();
    const other = createAead(randomBytes(32));
    app.ctx.store.close();
    const path = join(dataDir, DB_FILE);
    expect(reencrypt(path, app.ctx.aead, other)).toBeGreaterThanOrEqual(1);
    const db = new Database(path);
    try {
      const row = db
        .prepare("SELECT private_key_enc AS v FROM instance_ssh_key")
        .get() as { v: string };
      expect(other.decryptText(row.v, "instance_ssh_key.private_key")).toBe(
        privateKey,
      );
    } finally {
      db.close();
    }
    await app.ctx.store.open();
  });

  // Threat test T10 of the security review (THE-2398).
  it("is stored only under its own context, the one ENCRYPTED_COLUMNS names", async () => {
    expect(ENCRYPTED_COLUMNS).toContainEqual({
      table: "instance_ssh_key",
      column: "private_key_enc",
      context: KEY_CONTEXT,
    });
    current = await testApp();
    const { app } = current;
    app.ctx.connectors.key.publicKey();
    const row = app.ctx.store.sqlite
      .prepare("SELECT private_key_enc AS v FROM instance_ssh_key")
      .get() as { v: string };
    const { aead } = app.ctx;
    expect(aead.decryptText(row.v, KEY_CONTEXT)).toContain("PRIVATE KEY");
    expect(() => aead.decryptText(row.v, "users.totp_secret")).toThrow();
  });

  it("works under the new key after an import re-encrypts it (T10)", async () => {
    current = await testApp();
    const { app, dataDir } = current;
    const before = app.ctx.connectors.key.publicKey();
    const other = createAead(randomBytes(32));
    app.ctx.store.close();
    reencrypt(join(dataDir, DB_FILE), app.ctx.aead, other);
    await app.ctx.store.open();
    const moved = new InstanceKey(app.ctx.store, other);
    const parsed = ssh2.utils.parseKey(moved.privateKey());
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe("ssh-ed25519");
    expect(moved.publicKey()).toEqual(before);
  });

  it("parsesBack: a good pair yes, a corrupt key or a wrong public no", () => {
    const good = ssh2.utils.generateKeyPairSync("ed25519");
    const other = ssh2.utils.generateKeyPairSync("ed25519");
    expect(parsesBack(good)).toBe(true);
    const corrupt: GeneratedPair = {
      private: "not a key",
      public: good.public,
    };
    expect(parsesBack(corrupt)).toBe(false);
    const mismatched: GeneratedPair = {
      private: good.private,
      public: other.public,
    };
    expect(parsesBack(mismatched)).toBe(false);
  });

  it("is made again while its generator writes keys ssh2 cannot parse", () => {
    const good = ssh2.utils.generateKeyPairSync("ed25519");
    const bad: GeneratedPair = { private: "not a key", public: good.public };
    let calls = 0;
    const generate = (): GeneratedPair => {
      calls += 1;
      return calls <= 2 ? bad : good;
    };
    expect(usableInstanceKey(generate)).toEqual(good);
    expect(calls).toBe(3);
  });

  it("gives up with a clear error when no key parses back", () => {
    const bad: GeneratedPair = { private: "not a key", public: "" };
    expect(() => usableInstanceKey(() => bad)).toThrow(
      `no usable instance key in ${KEY_ATTEMPTS} attempts`,
    );
  });

  it("stores only a key that was made after unusable ones", async () => {
    current = await testApp();
    const { app } = current;
    const good = ssh2.utils.generateKeyPairSync("ed25519", {
      comment: "dialwarden",
    });
    const bad: GeneratedPair = { private: "not a key", public: good.public };
    let calls = 0;
    const generate = (): GeneratedPair => {
      calls += 1;
      return calls <= 2 ? bad : good;
    };
    const key = new InstanceKey(
      app.ctx.store,
      app.ctx.aead,
      undefined,
      generate,
    );
    const made = key.publicKey();
    expect(calls).toBe(3);
    expect(made.publicKey).toBe(good.public.trim());
    // What was stored parses back, and the app serves the same key.
    const parsed = ssh2.utils.parseKey(key.privateKey());
    if (parsed instanceof Error) throw parsed;
    expect(parsed.getPublicSSH().toString("base64")).toBe(
      made.publicKey.split(" ")[1],
    );
    expect(app.ctx.connectors.key.publicKey()).toEqual(made);
  });
});
