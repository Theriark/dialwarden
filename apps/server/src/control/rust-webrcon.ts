// Rust WebRCON client (contract C7, dev-work-plan P6-A step 1): one
// WebSocket at ws://host:port/<password>, the password in the URL path the
// game itself defines. A command is one JSON frame { Identifier, Message,
// Name }; the game answers with frames { Message, Identifier, Type,
// Stacktrace } that carry the command's Identifier (the last one is the
// reply, the ones before it the log lines the command wrote), and a command
// the game does not know gets no frame at all. A connection that never opens
// means the console is down or the password was refused; the two cannot be
// told apart on the wire, so the probe reports unknown. The URL holds the
// password, so no error text ever names the address.
import { connect, isIPv6 } from "node:net";
import {
  allowedCommand,
  ControlError,
  LIMITS,
  usableHost,
  usablePort,
  type AllowList,
  type ControlTimeouts,
  type GameControl,
  type ProbeResult,
} from "./types.js";
import { stateOf } from "./source-rcon.js";

/** The WebSocket this client needs; Node 24 provides it globally. */
interface Socket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "close" | "error",
    listener: () => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
}

function webSocket(): new (url: string) => Socket {
  const found = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof found !== "function") {
    throw new ControlError("Unsupported", "no WebSocket runtime");
  }
  return found as new (url: string) => Socket;
}

interface Waiter {
  readonly identifier: number;
  readonly take: (message: string) => void;
  readonly fail: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

/** One open console socket; one operation per instance. */
class Console {
  readonly #socket: Socket;
  readonly #opened: Promise<void>;
  #identifier = 0;
  #waiters: Waiter[] = [];

  constructor(url: string, connectMs: number) {
    const socket = new (webSocket())(url);
    this.#socket = socket;
    socket.addEventListener("error", () => undefined);
    this.#opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(
          new ControlError(
            "Connection",
            "the Rust web console did not answer in time",
          ),
        );
      }, connectMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(
          new ControlError(
            "Connection",
            "the Rust web console refused the connection",
          ),
        );
      });
    });
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (text.length > LIMITS.maxWebRconFrame) {
        this.#failAll(new ControlError("Protocol", "the reply is too large"));
        socket.close();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const frame = parsed as { Identifier?: unknown; Message?: unknown };
      const identifier = frame.Identifier;
      // Identifier 0 and negative ids are the game's own log and chat, never
      // a reply to a command.
      if (typeof identifier !== "number" || identifier <= 0) return;
      const message = typeof frame.Message === "string" ? frame.Message : "";
      const index = this.#waiters.findIndex(
        (waiter) => waiter.identifier === identifier,
      );
      if (index < 0) return;
      const [waiter] = this.#waiters.splice(index, 1);
      clearTimeout(waiter?.timer);
      waiter?.take(message);
    });
    socket.addEventListener("close", () => {
      this.#failAll(
        new ControlError("Connection", "the Rust web console closed"),
      );
    });
  }

  get opened(): Promise<void> {
    return this.#opened;
  }

  #failAll(error: unknown): void {
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiting) {
      clearTimeout(waiter.timer);
      waiter.fail(error);
    }
  }

  /** One allow-listed command and the first frame that answers it. */
  exec(command: string, readMs: number): Promise<string> {
    this.#identifier += 1;
    const identifier = this.#identifier;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter(
          (waiter) => waiter.identifier !== identifier,
        );
        reject(
          new ControlError(
            "Timeout",
            "the Rust web console did not answer the command",
          ),
        );
      }, readMs);
      this.#waiters.push({
        identifier,
        timer,
        take: resolve,
        fail: reject,
      });
      this.#socket.send(
        JSON.stringify({
          Identifier: identifier,
          Message: command,
          Name: "Dialwarden",
        }),
      );
    });
  }

  close(): void {
    this.#socket.close();
  }
}

export interface RustWebRconOptions extends ControlTimeouts {
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

export class RustWebRcon implements GameControl {
  readonly kind = "rustWebRcon" as const;
  readonly #options: RustWebRconOptions;

  constructor(options: RustWebRconOptions) {
    this.#options = options;
  }

  async probe(): Promise<ProbeResult> {
    try {
      const session = await this.#session();
      session.close();
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

  /**
   * The console URL, built by the URL parser like the Palworld REST address
   * (P10-A L5): an IPv6 host gets its brackets, and a host that would move
   * the URL elsewhere is refused before any connection is made.
   */
  #url(): URL {
    const { host, port, password } = this.#options;
    const hostPart = isIPv6(host) ? `[${host}]` : host;
    const url = usableHost(host)
      ? URL.parse(`ws://${hostPart}:${port}/`)
      : null;
    if (
      url === null ||
      !usablePort(port) ||
      url.hostname !== hostPart.toLowerCase() ||
      url.pathname !== "/"
    ) {
      throw new ControlError(
        "Refused",
        "the web console address is not usable",
      );
    }
    try {
      url.pathname = `/${encodeURIComponent(password)}`;
    } catch (error) {
      // A lone surrogate cannot be encoded (URIError): refused like a bad
      // address, so it answers control_error, never a 500 (P10-B N4).
      throw new ControlError(
        "Refused",
        "the web console password is not usable",
        error,
      );
    }
    return url;
  }

  /** Opens the console; the open failure says down or refused. */
  async #session(): Promise<Console> {
    const url = this.#url();
    // A closed TCP port is the game being down; the WebSocket API would
    // only say that the handshake never happened, which also covers a
    // refused password. The TCP probe tells the two apart.
    const connectMs = this.#options.connectMs ?? LIMITS.connectMs;
    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.#options.port, this.#options.host);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new ControlError("Timeout", "the web console port did not answer"),
        );
      }, connectMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new ControlError(
            "Connection",
            "the web console is unreachable",
            error,
          ),
        );
      });
      socket.once("ready", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
    });
    let session: Console;
    try {
      session = new Console(url.href, connectMs);
    } catch (error) {
      // The WebSocket constructor throws a SyntaxError on a URL it cannot
      // use; as a ControlError it answers control_error, never a 500.
      throw new ControlError(
        "Refused",
        "the web console address is not usable",
        error,
      );
    }
    try {
      await session.opened;
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  async #command(given?: string): Promise<void> {
    const command = given ?? "";
    const allowed = allowedCommand(this.#options.allow, command);
    if (command === "" || allowed === undefined) {
      throw new ControlError(
        "Refused",
        "the pack does not allow this WebRCON command",
      );
    }
    const session = await this.#session();
    try {
      await session.exec(allowed, this.#options.readMs ?? LIMITS.readMs);
    } finally {
      session.close();
    }
  }
}
