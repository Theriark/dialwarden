// The instance SSH key pair and the confirmed host keys (dev-work-plan P4-A
// step 2). One Ed25519 key pair per Dialwarden instance, made on first use;
// its private key is stored only encrypted with APP_SECRET_KEY (column
// instance_ssh_key.private_key_enc, registered in ENCRYPTED_COLUMNS so an app
// backup import re-encrypts it) and never leaves the server. The public key
// is what the owner adds to authorized_keys on a game server.
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

  constructor(store: Store, aead: Aead, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#aead = aead;
    this.#now = now;
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
    const pair = ssh2.utils.generateKeyPairSync("ed25519", {
      comment: KEY_COMMENT,
    });
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
