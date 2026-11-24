// The SSH command hook (contract C7, dev-work-plan P6-A step 2): one fixed
// command string per server, set only by the owner or an admin; editors can
// only trigger it, and nothing is ever appended at run time, so no user data
// reaches the shell. The connection is the server's own SSH access (the SFTP
// connector's host, user and authentication), so the host key must have been
// confirmed already: an unconfirmed or changed host key refuses the hook, and
// nothing but the exit status is looked at. A non-zero exit is reported as
// the failure it is.
import ssh2 from "ssh2";
import type { SftpAuth } from "../connectors/sftp.js";
import { hostKeyId } from "../connectors/host-key.js";
import {
  ControlError,
  LIMITS,
  type ControlTimeouts,
  type GameControl,
  type ProbeResult,
} from "./types.js";

export interface SshCommandOptions extends ControlTimeouts {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth: SftpAuth;
  /**
   * The confirmed host key fingerprint of the SSH server. Without one the
   * hook refuses to connect (the owner confirms it once on the connectors
   * page, exactly as for file access).
   */
  readonly pinnedFingerprint: string | null;
  /** The fixed command string; nothing is ever added to it. */
  readonly command: string;
}

/** Bound of the command output, which is read and dropped. */
const OUTPUT_CAP = 64 * 1024;

/** The fixed command a server may run; nothing else passes this check. */
function checkedCommand(command: string): string {
  if (command.trim() === "" || command.length > LIMITS.maxSshCommandLength) {
    throw new ControlError("Refused", "the command is not usable");
  }
  // A command with breaks or nulls is not one fixed string.
  if (/[\u{0}\r\n]/u.test(command)) {
    throw new ControlError("Refused", "the command is not one line");
  }
  return command;
}

export class SshCommand implements GameControl {
  readonly kind = "sshCommand" as const;
  readonly #options: SshCommandOptions;
  readonly #command: string;

  constructor(options: SshCommandOptions) {
    this.#options = options;
    this.#command = checkedCommand(options.command);
  }

  /** A command hook cannot see the game, so it never claims a state. */
  async probe(): Promise<ProbeResult> {
    return { state: "unknown" };
  }

  /** Runs the fixed command once; this is the restart action of the hook. */
  async restart(): Promise<void> {
    const options = this.#options;
    if (options.pinnedFingerprint === null) {
      throw new ControlError(
        "Refused",
        "the SSH host key of this server is not confirmed",
      );
    }
    const client = new ssh2.Client();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.end();
          reject(new ControlError("Timeout", "the SSH server did not answer"));
        }, options.connectMs ?? LIMITS.connectMs);
        client.once("error", (error) => {
          clearTimeout(timer);
          reject(new ControlError("Connection", "SSH is unreachable", error));
        });
        client.once("ready", () => {
          clearTimeout(timer);
          resolve();
        });
        client.connect({
          host: options.host,
          port: options.port,
          username: options.username,
          ...(options.auth.method === "password"
            ? { password: options.auth.password }
            : { privateKey: options.auth.privateKey }),
          readyTimeout: options.connectMs ?? LIMITS.connectMs,
          hostVerifier: (key: Buffer) => {
            if (hostKeyId(key).fingerprint !== options.pinnedFingerprint) {
              reject(new ControlError("HostKey", "the SSH host key changed"));
              return false;
            }
            return true;
          },
        });
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.end();
          reject(
            new ControlError(
              "Timeout",
              "the command on the server did not finish in time",
            ),
          );
        }, options.readMs ?? LIMITS.readMs);
        client.exec(this.#command, (error, stream) => {
          if (error !== null && error !== undefined) {
            clearTimeout(timer);
            reject(
              new ControlError("Connection", "the command cannot start", error),
            );
            return;
          }
          if (stream === undefined) {
            clearTimeout(timer);
            reject(new ControlError("Connection", "the command cannot start"));
            return;
          }
          // The output is drained and dropped: only the exit status matters.
          let drained = 0;
          stream.on("data", (chunk: Buffer) => {
            drained += chunk.length;
            if (drained > OUTPUT_CAP) client.end();
          });
          stream.stderr.on("data", () => undefined);
          stream.once("close", (code: number | null) => {
            clearTimeout(timer);
            if (code === 0 || code === null) resolve();
            else {
              reject(
                new ControlError(
                  "Failed",
                  "the command on the server exited with an error",
                ),
              );
            }
          });
        });
      });
    } finally {
      client.end();
    }
  }
}
