// 7 Days to Die telnet client (contract C7, dev-work-plan P6-A step 1): the
// game has no Source RCON; its console is a telnet server. On connect it
// greets ("*** Connected with 7DTD server.") and asks for the password
// ("Please enter password:"), which is answered once; a wrong password
// ("Password incorrect") is a configuration blocker and the connection is
// closed at once, because the game bans addresses after failed logins. After
// login, commands are newline-terminated lines and the game streams lines
// back, mixed with its live log, so one command's output is collected until
// the socket goes quiet. Telnet IAC negotiation bytes are stripped; nothing
// else about the stream is interpreted.
import { connect, type Socket } from "node:net";
import {
  allowedCommand,
  checkLineSafePassword,
  ControlError,
  LIMITS,
  type AllowList,
  type ControlTimeouts,
  type GameControl,
  type ProbeResult,
} from "./types.js";
import { stateOf } from "./source-rcon.js";

const PASSWORD_PROMPT = /please enter password:?/i;
const LOGGED_IN = /logon successful/i;
const WRONG_PASSWORD = /password incorrect/i;

/** Strips IAC sequences from a buffer, in one pass. */
function stripIac(buffer: Buffer): Buffer {
  const out: number[] = [];
  let index = 0;
  while (index < buffer.length) {
    const byte = buffer.readUInt8(index);
    if (byte !== 0xff) {
      out.push(byte);
      index += 1;
      continue;
    }
    const next = buffer.subarray(index + 1);
    const after = next.length > 0 ? next.readUInt8(0) : -1;
    if (after === 0xff) {
      out.push(0xff);
      index += 2;
      continue;
    }
    if (after === 0xfa) {
      const end = next.indexOf(Buffer.from([0xff, 0xf0]));
      if (end < 0) return Buffer.from(out);
      index += 2 + end + 2;
      continue;
    }
    if (after >= 0xfb && after <= 0xfe) {
      index += 3;
      continue;
    }
    index += 2;
  }
  return Buffer.from(out);
}

/** One connected console: line reading with IAC bytes stripped. */
class Console {
  readonly socket: Socket;
  #text = "";
  #lines: string[] = [];
  #waiters: {
    readonly resolve: (line: string | undefined) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  #ended = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      const plain = stripIac(chunk);
      this.#text += plain.toString("utf8");
      for (;;) {
        const end = this.#text.indexOf("\n");
        if (end < 0) break;
        const line = this.#text.slice(0, end).replace(/\r$/, "");
        this.#text = this.#text.slice(end + 1);
        if (line.length > LIMITS.maxTelnetLine) {
          this.#text = "";
          continue;
        }
        this.#hand(line);
      }
      if (this.#text.length > LIMITS.maxTelnetLine) this.#text = "";
      // The password prompt may come without a line break: it is handed on
      // as a line of its own, so the login never waits for one.
      if (PASSWORD_PROMPT.test(this.#text)) {
        const prompt = this.#text;
        this.#text = "";
        this.#hand(prompt.replace(/\r$/, ""));
      }
    });
    socket.once("close", () => this.#end());
    socket.once("error", () => this.#end());
  }

  get ended(): boolean {
    return this.#ended;
  }

  #hand(line: string): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#lines.push(line);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(line);
  }

  #end(): void {
    this.#ended = true;
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiting) {
      clearTimeout(waiter.timer);
      waiter.resolve(undefined);
    }
  }

  /** The next line, or undefined when the bound passes with nothing. */
  nextLine(timeoutMs: number): Promise<string | undefined> {
    const queued = this.#lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          resolve(undefined);
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  /** Every line until the socket stays quiet, or the bound passes. */
  async collect(quietMs: number, boundMs: number): Promise<string[]> {
    const out: string[] = [];
    const deadline = Date.now() + boundMs;
    for (;;) {
      const wait = Math.min(quietMs, deadline - Date.now());
      if (wait <= 0) break;
      const line = await this.nextLine(wait);
      if (line === undefined) break;
      out.push(line);
    }
    return out;
  }

  send(line: string): void {
    this.socket.write(`${line}\n`);
  }

  close(): void {
    this.socket.destroy();
  }
}

export interface Telnet7dtdOptions extends ControlTimeouts {
  readonly host: string;
  readonly port: number;
  /** The telnet password; the pack probe reads it from serverconfig.xml. */
  readonly password: string;
  /** The pack's command allow-list; nothing else is ever sent. */
  readonly allow: AllowList;
  /** The allow-listed command the pack maps the save hook to. */
  readonly saveCommand?: string;
  /** The allow-listed command the pack maps the stop hook to. */
  readonly stopCommand?: string;
}

/** Connects and hands over the console; probe and actions share it. */
async function connectConsole(options: Telnet7dtdOptions): Promise<Console> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const made = connect(options.port, options.host);
    const timer = setTimeout(() => {
      made.destroy();
      reject(new ControlError("Timeout", "the telnet port did not answer"));
    }, options.connectMs ?? LIMITS.connectMs);
    made.once("error", (error) => {
      clearTimeout(timer);
      reject(new ControlError("Connection", "the telnet port refused", error));
    });
    made.once("ready", () => {
      clearTimeout(timer);
      resolve(made);
    });
  });
  return new Console(socket);
}

export class Telnet7dtd implements GameControl {
  readonly kind = "telnet7dtd" as const;
  readonly #options: Telnet7dtdOptions;

  constructor(options: Telnet7dtdOptions) {
    this.#options = options;
  }

  /**
   * The greeting or the password prompt proves the game is listening; the
   * password is never sent by a probe.
   */
  async probe(): Promise<ProbeResult> {
    try {
      const session = await connectConsole(this.#options);
      const readMs = this.#options.readMs ?? LIMITS.readMs;
      try {
        const first = await session.nextLine(readMs);
        return first !== undefined
          ? { state: "running" }
          : { state: "unknown" };
      } finally {
        session.close();
      }
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
        "the pack does not allow this telnet command",
      );
    }
    // The password goes out as one line: a line break in it would send a
    // second console command past the allow-list.
    checkLineSafePassword(this.#options.password);
    const session = await connectConsole(this.#options);
    try {
      await this.#login(session);
      session.send(allowed);
      // The game answers with the echo line and then the command output, but
      // a shutdown may close the socket first; both are success.
      await session.collect(750, this.#options.readMs ?? LIMITS.readMs);
    } finally {
      session.close();
    }
  }

  /** Answers the one password prompt; one attempt, then the socket closes. */
  async #login(session: Console): Promise<void> {
    const readMs = this.#options.readMs ?? LIMITS.readMs;
    let answered = false;
    for (;;) {
      const text = await session.nextLine(readMs);
      if (text === undefined) {
        throw new ControlError("Connection", "the telnet console closed");
      }
      if (WRONG_PASSWORD.test(text)) {
        throw new ControlError("Auth", "the telnet password was refused");
      }
      if (LOGGED_IN.test(text)) return;
      if (PASSWORD_PROMPT.test(text)) {
        // One attempt only: the game bans addresses after failed logins.
        if (answered) {
          throw new ControlError("Auth", "the telnet password was refused");
        }
        answered = true;
        checkLineSafePassword(this.#options.password);
        session.send(this.#options.password);
      }
    }
  }
}
