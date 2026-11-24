// Steam A2S status probe (dev-work-plan P6-A step 4): a UDP A2S_INFO query
// with the 2021 challenge round, and an optional A2S_PLAYER query for the
// connected count. The query port of most games is not the game port (Valheim
// answers on game port plus one), and games that are not listed publicly often
// do not answer at all, so a silent port is unknown, never stopped. A UDP
// port-unreachable reply (ECONNREFUSED) means nothing is listening: stopped.
//
// The player count of A2S_INFO includes bots, so the count is only asked for
// from A2S_PLAYER when the pack wants it; a failed player query never changes
// the state, which the INFO round already proved.
import { createSocket } from "node:dgram";
import {
  ControlError,
  LIMITS,
  refused,
  type ControlTimeouts,
  type ProbeResult,
} from "./types.js";

const HEADER = 0xffff_ffff;
const A2S_INFO = 0x54;
const A2S_INFO_REPLY = 0x49;
const A2S_PLAYER = 0x55;
const A2S_PLAYER_REPLY = 0x44;
const CHALLENGE_REPLY = 0x41;

function request(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(HEADER, 0);
  return Buffer.concat([head, Buffer.from([type]), body]);
}

function infoPayload(challenge?: Buffer): Buffer {
  const payload = Buffer.from("Source Engine Query\0", "latin1");
  const extra = challenge ?? Buffer.alloc(0);
  return request(A2S_INFO, Buffer.concat([payload, extra]));
}

function playerPayload(challenge: Buffer): Buffer {
  return request(A2S_PLAYER, challenge);
}

/** Reads a zero-terminated string; the offset moves past its zero byte. */
function stringAt(bytes: Buffer, at: number): [string, number] | undefined {
  const end = bytes.indexOf(0, at);
  if (end < 0) return undefined;
  return [bytes.subarray(at, end).toString("utf8"), end + 1];
}

/** The reply type byte (I, A or D) and where the body starts. */
function replyType(bytes: Buffer): number | undefined {
  if (bytes.length < 5 || bytes.readUInt32LE(0) !== HEADER) return undefined;
  return bytes.readUInt8(4);
}

/** The connected and maximum player counts of an A2S_INFO reply. */
function parseInfo(
  bytes: Buffer,
): { players: number; max: number } | undefined {
  // After the header (4) and the reply type (1) comes the protocol byte,
  // then the four zero-terminated strings, the app id (2 bytes) and the
  // counts.
  let at = 6;
  for (let field = 0; field < 4; field += 1) {
    const found = stringAt(bytes, at);
    if (found === undefined) return undefined;
    at = found[1];
  }
  if (at + 4 > bytes.length) return undefined;
  return { players: bytes.readUInt8(at + 2), max: bytes.readUInt8(at + 3) };
}

/** The connected count of an A2S_PLAYER reply (bots are not listed). */
function parsePlayers(bytes: Buffer): number | undefined {
  if (bytes.length < 6) return undefined;
  return bytes.readUInt8(5);
}

export interface A2sOptions extends ControlTimeouts {
  readonly host: string;
  readonly port: number;
  /** Also ask A2S_PLAYER for the connected count (default false). */
  readonly players?: boolean;
}

export class A2sProbe {
  readonly kind = "a2s" as const;
  readonly #host: string;
  readonly #port: number;
  readonly #askPlayers: boolean;
  readonly #connectMs: number;
  readonly #readMs: number;

  constructor(options: A2sOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#askPlayers = options.players === true;
    this.#connectMs = options.connectMs ?? LIMITS.connectMs;
    this.#readMs = options.readMs ?? LIMITS.readMs;
  }

  async probe(): Promise<ProbeResult> {
    try {
      const info = await this.#info();
      if (!this.#askPlayers) return { state: "running", players: info.players };
      const players = await this.#playerCount();
      return { state: "running", players: players ?? info.players };
    } catch (error) {
      // Nothing listening is stopped; silence or a reply that cannot be
      // read is unknown (contract C7: probe never throws).
      return { state: refused(error) ? "stopped" : "unknown" };
    }
  }

  /** The INFO round, with the challenge retry newer servers ask for. */
  async #info(): Promise<{ players: number; max: number }> {
    const first = await this.#exchange(infoPayload(), this.#connectMs);
    if (replyType(first) === A2S_INFO_REPLY) {
      const info = parseInfo(first);
      if (info !== undefined) return info;
      throw new ControlError("Protocol", "the A2S_INFO reply is malformed");
    }
    if (replyType(first) === CHALLENGE_REPLY && first.length >= 9) {
      const second = await this.#exchange(
        infoPayload(first.subarray(5, 9)),
        this.#readMs,
      );
      const info =
        replyType(second) === A2S_INFO_REPLY ? parseInfo(second) : undefined;
      if (info !== undefined) return info;
    }
    throw new ControlError("Protocol", "the query port did not answer A2S");
  }

  /** The connected count, or undefined when the game does not report it. */
  async #playerCount(): Promise<number | undefined> {
    try {
      const first = await this.#exchange(
        playerPayload(Buffer.from([0xff, 0xff, 0xff, 0xff])),
        this.#readMs,
      );
      if (replyType(first) !== CHALLENGE_REPLY || first.length < 9) {
        return replyType(first) === A2S_PLAYER_REPLY
          ? parsePlayers(first)
          : undefined;
      }
      const second = await this.#exchange(
        playerPayload(first.subarray(5, 9)),
        this.#readMs,
      );
      return replyType(second) === A2S_PLAYER_REPLY
        ? parsePlayers(second)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Sends one packet and resolves with the first reply packet. The socket is
   * connected first, so an ICMP port-unreachable reply arrives as an
   * ECONNREFUSED error (an unconnected UDP socket never hears of it).
   */
  #exchange(payload: Buffer, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = createSocket("udp4");
      let settled = false;
      const finish = (error: unknown, reply?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (reply !== undefined) resolve(reply);
        else reject(error);
      };
      const timer = setTimeout(
        () => finish(new ControlError("Timeout", "the query timed out")),
        timeoutMs,
      );
      socket.once("error", (error) => finish(error));
      socket.once("message", (message) => {
        if (message.length <= LIMITS.maxA2sBytes) finish(undefined, message);
        else finish(new ControlError("Protocol", "the A2S reply is too large"));
      });
      socket.connect(this.#port, this.#host, () => {
        socket.send(payload, (error) => {
          if (error !== null) finish(error);
        });
      });
    });
  }
}
