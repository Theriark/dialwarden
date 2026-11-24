// Source RCON client (contract C7, dev-work-plan P6-A step 1): the protocol
// of ARK: Survival Ascended and Project Zomboid. One TCP connection per
// operation: authenticate (SERVERDATA_AUTH, type 3), then one allow-listed
// command (SERVERDATA_EXECCOMMAND, type 2) and its response frame. A refused
// password is a configuration blocker, never retried; the password never
// appears in an error or a log line.
//
// Frames are length-prefixed little endian: int32 length, int32 request id,
// int32 type, body, two null bytes. Most servers send an empty response
// frame before the auth response, so frames are read until the one the
// operation waits for.
import { randomInt } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  allowedCommand,
  checkLineSafePassword,
  ControlError,
  LIMITS,
  refused,
  type AllowList,
  type ControlTimeouts,
  type GameControl,
  type ProbeResult,
} from "./types.js";

const AUTH = 3;
const AUTH_RESPONSE = 2;
const COMMAND = 2;
const RESPONSE = 0;
const FAILED_ID = -1;
/** The longest password a control endpoint is configured with. */
const MAX_PASSWORD = 512;

interface Frame {
  readonly id: number;
  readonly type: number;
  readonly body: string;
}

/** One client frame: length, id, type, body, two null bytes. */
function frame(id: number, type: number, body: string): Buffer {
  // UTF-8 both ways: a password outside latin1 must not be mangled into a
  // refusal the user cannot fix by retyping it.
  const text = Buffer.from(body, "utf8");
  const packet = Buffer.alloc(14 + text.length);
  packet.writeUInt32LE(10 + text.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  text.copy(packet, 12);
  return packet;
}

/**
 * Reads the frames of one connection. A TCP chunk may hold several frames
 * (the empty frame and the auth answer often arrive together) or part of
 * one, so the bytes past a frame stay buffered for the next read.
 */
class FrameReader {
  #buffer = Buffer.alloc(0);
  readonly #frames: Frame[] = [];
  #closed = false;
  #failure: ControlError | undefined;
  #wake: (() => void) | undefined;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#parse(socket);
      this.#wake?.();
    });
    const closed = () => {
      this.#closed = true;
      this.#wake?.();
    };
    socket.once("close", closed);
    socket.on("error", closed);
  }

  #parse(socket: Socket): void {
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length < 10 || length > LIMITS.maxRconBody + 10) {
        this.#failure = new ControlError(
          "Protocol",
          "the RCON frame length is invalid",
        );
        socket.destroy();
        return;
      }
      if (this.#buffer.length < 4 + length) return;
      this.#frames.push({
        id: this.#buffer.readInt32LE(4),
        type: this.#buffer.readInt32LE(8),
        body: this.#buffer.subarray(12, 4 + length - 2).toString("utf8"),
      });
      this.#buffer = this.#buffer.subarray(4 + length);
    }
  }

  /** The next frame, or undefined when the connection closed first. */
  next(timeoutMs: number): Promise<Frame | undefined> {
    return new Promise((resolve, reject) => {
      const ready = (): boolean => {
        const frame = this.#frames.shift();
        if (frame !== undefined) resolve(frame);
        else if (this.#failure !== undefined) reject(this.#failure);
        else if (this.#closed) resolve(undefined);
        else return false;
        return true;
      };
      if (ready()) return;
      const timer = setTimeout(() => {
        this.#wake = undefined;
        reject(new ControlError("Timeout", "the RCON server did not answer"));
      }, timeoutMs);
      this.#wake = () => {
        if (!ready()) return;
        clearTimeout(timer);
        this.#wake = undefined;
      };
    });
  }
}

export interface SourceRconOptions extends ControlTimeouts {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  /** The pack's command allow-list; nothing else is ever sent. */
  readonly allow: AllowList;
  /** The allow-listed command the pack maps the save hook to. */
  readonly saveCommand?: string;
  /** The allow-listed command the pack maps the stop hook to. */
  readonly stopCommand?: string;
}

/** One RCON operation: connect, authenticate, run one command, close. */
async function operate(
  options: SourceRconOptions,
  command?: string,
): Promise<string | undefined> {
  if (options.password.length > MAX_PASSWORD) {
    throw new ControlError("Refused", "the RCON password is too long");
  }
  checkLineSafePassword(options.password);
  const connectMs = options.connectMs ?? LIMITS.connectMs;
  const readMs = options.readMs ?? LIMITS.readMs;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const made = connect(options.port, options.host);
    const timer = setTimeout(() => {
      made.destroy();
      reject(new ControlError("Timeout", "the RCON port did not answer"));
    }, connectMs);
    made.once("error", (error) => {
      clearTimeout(timer);
      reject(new ControlError("Connection", "the RCON port refused", error));
    });
    made.once("ready", () => {
      clearTimeout(timer);
      resolve(made);
    });
  });
  const reader = new FrameReader(socket);
  try {
    const id = randomInt(1, 0x7fff_ffff);
    socket.write(frame(id, AUTH, options.password));
    // Most servers send an empty response frame before the auth response;
    // more than a few is not a server we want to talk to.
    for (let skipped = 0; ;) {
      const answer = await reader.next(readMs);
      if (answer === undefined) {
        throw new ControlError("Connection", "the RCON server closed");
      }
      if (answer.type !== AUTH_RESPONSE) {
        skipped += 1;
        if (skipped > 5) {
          throw new ControlError(
            "Protocol",
            "the RCON server did not answer the login",
          );
        }
        continue;
      }
      if (answer.id === FAILED_ID) {
        throw new ControlError("Auth", "the RCON password was refused");
      }
      if (answer.id !== id) {
        throw new ControlError("Protocol", "the RCON auth answer is wrong");
      }
      break;
    }
    if (command === undefined) return undefined;
    socket.write(frame(id, COMMAND, command));
    for (let read = 0; read < 10;) {
      const answer = await reader.next(readMs);
      if (answer === undefined) return undefined;
      if (answer.type === RESPONSE && answer.id === id) return answer.body;
      read += 1;
    }
    throw new ControlError("Protocol", "the RCON command got no answer");
  } finally {
    socket.destroy();
  }
}

export class SourceRcon implements GameControl {
  readonly kind = "sourceRcon" as const;
  readonly #options: SourceRconOptions;

  constructor(options: SourceRconOptions) {
    this.#options = options;
  }

  async probe(): Promise<ProbeResult> {
    try {
      await operate(this.#options);
      return { state: "running" };
    } catch (error) {
      return stateOf(error);
    }
  }

  async save(): Promise<void> {
    await this.#command(this.#options.saveCommand);
  }

  async stop(): Promise<void> {
    await this.#command(this.#options.stopCommand);
  }

  async #command(given?: string): Promise<void> {
    const command = given ?? "";
    const allowed = allowedCommand(this.#options.allow, command);
    if (command === "" || allowed === undefined) {
      throw new ControlError(
        "Refused",
        "the pack does not allow this RCON command",
      );
    }
    await operate(this.#options, allowed);
  }
}

/**
 * The state a failed probe maps to: a closed port is the game being down, a
 * refused password still proves the game is listening, anything else is
 * unknown. Shared by the other protocol clients.
 */
export function stateOf(error: unknown): ProbeResult {
  if (refused(error)) return { state: "stopped" };
  if (error instanceof ControlError && error.code === "Auth") {
    return { state: "running" };
  }
  return { state: "unknown" };
}
