// The instance SSH key pair and the confirmed host keys (dev-work-plan P4-A
// step 2). One Ed25519 key pair per Dialwarden instance, made on first use;
// its private key is stored only encrypted with APP_SECRET_KEY (column
// instance_ssh_key.private_key_enc, registered in ENCRYPTED_COLUMNS so an app
// backup import re-encrypts it) and never leaves the server. The public key
// is what the owner adds to authorized_keys on a game server. A pair is
// stored only when ssh2 parses its private key back and it matches its
// public key: the generator sometimes writes a key its own parser calls
// malformed, so it is made again, a few times at most (THE-2534 follow-up).
import { eq, and } from "drizzle-orm";
import ssh2 from "ssh2";
import type { Aead } from "../crypto/aead.js";
import { instanceSshKey, knownHosts } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { publicKeyFingerprint, type HostKeyId } from "./host-key.js";

/** The AEAD context of the private key (its ENCRYPTED_COLUMNS entry). */
export const KEY_CONTEXT = "instance_ssh_key.private_key";
export const KEY_ALGORITHM = "ssh-ed25519";
const KEY_COMMENT = "dialwarden";

/** How many generated keys may fail before the instance key gives up. */
export const KEY_ATTEMPTS = 10;

/** An OpenSSH key pair as ssh2.utils.generateKeyPairSync returns it. */
export interface GeneratedPair {
  readonly private: string;
  readonly public: string;
}

const ed25519 = (): GeneratedPair =>
  ssh2.utils.generateKeyPairSync("ed25519", { comment: KEY_COMMENT });

/**
 * True when ssh2 parses the private key back (as its SFTP client does when
 * the connector signs in) and the key matches the public key stored with
 * it. The generator now and then writes an OpenSSH private key its own
 * parser calls malformed, so such a pair is never stored.
 */
export function parsesBack(pair: GeneratedPair): boolean {
  try {
    const parsed = ssh2.utils.parseKey(pair.private);
    if (parsed instanceof Error) return false;
    const blob = parsed.getPublicSSH().toString("base64");
    return pair.public.trim().split(/\s+/)[1] === blob;
  } catch {
    return false;
  }
}

/**
 * A new Ed25519 key pair ssh2 can parse back, for the instance key: made
 * again while it does not parse, a few times at most, then a clear error.
 * The same approach as usablePair() in test/ssh-server.ts (THE-2534).
 */
export function usableInstanceKey(
  generate: () => GeneratedPair = ed25519,
): GeneratedPair {
  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
    const pair = generate();
    if (parsesBack(pair)) return pair;
  }
  throw new Error(`no usable instance key in ${KEY_ATTEMPTS} attempts`);
}

export interface InstancePublicKey {
  readonly algorithm: string;
  /** The OpenSSH public key line, ready for authorized_keys. */
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface PinnedHostKey extends HostKeyId {
  readonly host: string;
  readonly port: number;
  readonly confirmedAt: string;
  readonly confirmedBy: string | null;
}

export class InstanceKey {
  readonly #store: Store;
  readonly #aead: Aead;
  readonly #now: () => Date;
  readonly #generate: () => GeneratedPair;

  constructor(
    store: Store,
    aead: Aead,
    now: () => Date = () => new Date(),
    generate: () => GeneratedPair = ed25519,
  ) {
    this.#store = store;
    this.#aead = aead;
    this.#now = now;
    this.#generate = generate;
  }

  #row() {
    return this.#store.db
      .select()
      .from(instanceSshKey)
      .where(eq(instanceSshKey.id, 1))
      .get();
  }

  /** Makes the key pair when there is none; a second caller keeps the first. */
  #ensure() {
    const found = this.#row();
    if (found !== undefined) return found;
    const pair = usableInstanceKey(this.#generate);
    const publicKey = pair.public.trim();
    this.#store.db
      .insert(instanceSshKey)
      .values({
        id: 1,
        privateKeyEnc: this.#aead.encrypt(pair.private, KEY_CONTEXT),
        publicKey,
        fingerprint: publicKeyFingerprint(publicKey),
        createdAt: this.#now().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    const row = this.#row();
    if (row === undefined) throw new Error("the instance key was not stored");
    return row;
  }

  /** The public half, made on first use. */
  publicKey(): InstancePublicKey {
    const row = this.#ensure();
    return {
      algorithm: KEY_ALGORITHM,
      publicKey: row.publicKey,
      fingerprint: row.fingerprint,
      createdAt: row.createdAt,
    };
  }

  /** The OpenSSH private key, for the SFTP connector only. */
  privateKey(): string {
    const row = this.#ensure();
    return this.#aead.decryptText(row.privateKeyEnc, KEY_CONTEXT);
  }
}

export class KnownHosts {
  readonly #store: Store;
  readonly #now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  get(host: string, port: number): PinnedHostKey | null {
    const row = this.#store.db
      .select()
      .from(knownHosts)
      .where(and(eq(knownHosts.host, host), eq(knownHosts.port, port)))
      .get();
    if (row === undefined) return null;
    return {
      host: row.host,
      port: row.port,
      algorithm: row.algorithm,
      fingerprint: row.fingerprint,
      confirmedAt: row.confirmedAt,
      confirmedBy: row.confirmedBy,
    };
  }

  /** Pins a host key; it replaces the key pinned for that host and port. */
  pin(
    host: string,
    port: number,
    key: HostKeyId,
    by: string | null,
  ): PinnedHostKey {
    const confirmedAt = this.#now().toISOString();
    const values = {
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
      confirmedAt,
      confirmedBy: by,
    };
    this.#store.db
      .insert(knownHosts)
      .values({ host, port, ...values })
      .onConflictDoUpdate({
        target: [knownHosts.host, knownHosts.port],
        set: values,
      })
      .run();
    return { host, port, ...values };
  }
}
