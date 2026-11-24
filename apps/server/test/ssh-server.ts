// An SSH server inside the test process (ssh2 Server on 127.0.0.1), for the
// host key and confinement threat tests of the security review (THE-2398:
// T5, T6, T7 and T9). It needs no Docker. It counts authentication requests,
// accepts one password when given one, and hands an authenticated SFTP
// session to the test. Every key is generated when the test runs.
import type { AddressInfo } from "node:net";
import ssh2, { type Connection, type SFTPWrapper } from "ssh2";
import { publicKeyFingerprint } from "../src/connectors/host-key.js";

export interface HostKeyPair {
  /** The OpenSSH private key the server presents. */
  readonly privateKey: string;
  /** Its SHA256 fingerprint, as ssh-keygen -l prints it. */
  readonly fingerprint: string;
}

/** An OpenSSH key pair as ssh2.utils.generateKeyPairSync returns it. */
export interface GeneratedPair {
  readonly private: string;
  readonly public: string;
}

/** How many generated keys may fail to parse before hostKeyPair gives up. */
export const HOST_KEY_ATTEMPTS = 10;

const ed25519 = (): GeneratedPair => ssh2.utils.generateKeyPairSync("ed25519");

/**
 * True when ssh2 parses the private key back (as new ssh2.Server does with
 * its host keys) and the key matches the public key the test pins.
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
 * A new Ed25519 key pair that ssh2 parses back. ssh2's generator now and
 * then writes an OpenSSH private key its own parser calls malformed ("Cannot
 * parse privateKey" in new ssh2.Server, push CI run 45302896324), so such a
 * key is made again, a few times at most.
 */
export function usablePair(generate = ed25519): GeneratedPair {
  for (let attempt = 0; attempt < HOST_KEY_ATTEMPTS; attempt += 1) {
    const pair = generate();
    if (parsesBack(pair)) return pair;
  }
  throw new Error(`no usable host key in ${HOST_KEY_ATTEMPTS} attempts`);
}

export function hostKeyPair(generate = ed25519): HostKeyPair {
  const pair = usablePair(generate);
  return {
    privateKey: pair.private,
    fingerprint: publicKeyFingerprint(pair.public),
  };
}

export interface SshServerOptions {
  readonly hostKey: HostKeyPair;
  /** The port to listen on; default a free one. */
  readonly port?: number;
  /** The one password accepted; without it every login is refused. */
  readonly password?: string;
  /** Serves the SFTP subsystem of a logged-in client. */
  readonly sftp?: (sftp: SFTPWrapper) => void;
}

export interface SshServer {
  readonly port: number;
  /** Authentication requests received so far, of any method. */
  authentications(): number;
  close(): Promise<void>;
}

export async function startSshServer(
  options: SshServerOptions,
): Promise<SshServer> {
  let authentications = 0;
  const clients = new Set<Connection>();
  const server = new ssh2.Server(
    { hostKeys: [options.hostKey.privateKey] },
    (client) => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      // A client that stops at the host key check drops the socket.
      client.on("error", () => undefined);
      client.on("authentication", (context) => {
        authentications += 1;
        if (
          context.method === "password" &&
          options.password !== undefined &&
          context.password === options.password
        ) {
          context.accept();
        } else {
          context.reject(["password"]);
        }
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const channel = accept();
          channel.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            options.sftp?.(sftp);
          });
        });
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    authentications: () => authentications,
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
