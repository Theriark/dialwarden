// The connector factory (app.ctx.connectors): turns a connection spec into a
// contract C4 connector, and owns the instance SSH key and the host key
// pinning. P4-B stores a spec per server and opens its connector here.
//
// Host key confirm (dev-work-plan P4-A step 2): test() of an unpinned SFTP
// server returns the fingerprint; the owner compares it and confirms it with
// POST /api/v1/connectors/host-keys. The confirm connects again and pins only
// when the server still presents the confirmed key, so a fingerprint typed
// or replayed from elsewhere cannot be pinned.
import ssh2 from "ssh2";
import type { Aead } from "../crypto/aead.js";
import type { Store } from "../db/store.js";
import { hostKeyId, type HostKeyId } from "./host-key.js";
import { InstanceKey, KnownHosts, type PinnedHostKey } from "./keys.js";
import { LocalConnector } from "./local.js";
import { SftpConnector, type SftpAuth } from "./sftp.js";
import { ConnectorError, type Connector } from "./types.js";

export type ConnectionSpec =
  | { readonly kind: "local"; readonly root: string }
  | {
      readonly kind: "sftp";
      readonly host: string;
      readonly port: number;
      readonly username: string;
      readonly root: string;
      /**
       * Panel SFTP (a game panel that offers no SSH keys): password login.
       * Otherwise the instance key logs in and no password is used.
       */
      readonly panel: boolean;
      readonly password?: string;
    };

export interface ConnectorServiceOptions {
  readonly store: Store;
  readonly aead: Aead;
  /** The data folder; a Local root may never overlap it. */
  readonly dataDir: string;
  readonly now?: () => Date;
  /** Handshake bound for SFTP (default 10 s). */
  readonly readyTimeoutMs?: number;
  /** Bound of every SFTP request (default 30 s). */
  readonly operationTimeoutMs?: number;
}

export type ConfirmResult =
  | { readonly ok: true; readonly pinned: PinnedHostKey }
  | {
      readonly ok: false;
      readonly reason: "mismatch" | "pinned_differently";
      /** The key the server presents now. */
      readonly presented: HostKeyId;
    };

export class ConnectorService {
  readonly key: InstanceKey;
  readonly knownHosts: KnownHosts;
  readonly #dataDir: string;
  readonly #readyMs: number;
  readonly #operationMs: number;

  constructor(options: ConnectorServiceOptions) {
    this.key = new InstanceKey(options.store, options.aead, options.now);
    this.knownHosts = new KnownHosts(options.store, options.now);
    this.#dataDir = options.dataDir;
    this.#readyMs = options.readyTimeoutMs ?? 10_000;
    this.#operationMs = options.operationTimeoutMs ?? 30_000;
  }

  /** A connector for the spec; nothing connects before the first call. */
  open(spec: ConnectionSpec): Connector {
    if (spec.kind === "local") {
      return new LocalConnector({ root: spec.root, deny: [this.#dataDir] });
    }
    let auth: SftpAuth;
    if (spec.panel) {
      if (spec.password === undefined || spec.password === "") {
        throw new ConnectorError("Connection", "panel SFTP needs a password");
      }
      auth = { method: "password", password: spec.password };
    } else {
      auth = { method: "key", privateKey: this.key.privateKey() };
    }
    return new SftpConnector({
      host: spec.host,
      port: spec.port,
      username: spec.username,
      root: spec.root,
      auth,
      pinnedFingerprint:
        this.knownHosts.get(spec.host, spec.port)?.fingerprint ?? null,
      readyTimeoutMs: this.#readyMs,
      operationTimeoutMs: this.#operationMs,
    });
  }

  /**
   * The host key a server presents. The handshake stops right after the key
   * exchange: no user name or credential is sent.
   */
  scanHostKey(host: string, port: number): Promise<HostKeyId> {
    return new Promise((resolve, reject) => {
      const client = new ssh2.Client();
      let seen: HostKeyId | null = null;
      let settled = false;
      const finish = (error: unknown) => {
        if (settled) return;
        settled = true;
        client.end();
        if (seen !== null) resolve(seen);
        else
          reject(
            new ConnectorError(
              "Connection",
              "could not reach the SSH server",
              error,
            ),
          );
      };
      client.on("error", finish);
      client.on("close", () => finish(undefined));
      client.on("ready", () => finish(undefined));
      try {
        client.connect({
          host,
          port,
          // ssh2 needs a user name; the handshake ends before it is sent.
          username: "dialwarden",
          readyTimeout: this.#readyMs,
          hostVerifier: (key: Buffer): boolean => {
            seen = hostKeyId(key);
            return false;
          },
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  /**
   * Pins fingerprint for host and port when the server presents exactly that
   * key now. A different pinned key is replaced only with replace true.
   */
  async confirmHostKey(
    host: string,
    port: number,
    fingerprint: string,
    by: string | null,
    replace: boolean,
  ): Promise<ConfirmResult> {
    const presented = await this.scanHostKey(host, port);
    if (presented.fingerprint !== fingerprint) {
      return { ok: false, reason: "mismatch", presented };
    }
    const pinned = this.knownHosts.get(host, port);
    if (pinned !== null && pinned.fingerprint !== fingerprint && !replace) {
      return { ok: false, reason: "pinned_differently", presented };
    }
    return { ok: true, pinned: this.knownHosts.pin(host, port, presented, by) };
  }
}
