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

export function hostKeyPair(): HostKeyPair {
  const pair = ssh2.utils.generateKeyPairSync("ed25519");
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
