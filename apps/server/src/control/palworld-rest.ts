// Palworld REST client (contract C7, dev-work-plan P6-A step 1): the REST API
// the game itself serves when OptionSettings RESTAPIEnabled is on. Basic
// authentication with the admin user and the game's AdminPassword (which the
// pack probe reads from the settings file); the paths are the game's own
// v1/api endpoints. The shutdown message is a fixed string of the client,
// never text from the UI. Redirects are never followed.
import {
  ControlError,
  LIMITS,
  type ControlTimeouts,
  type GameControl,
  type ProbeResult,
} from "./types.js";
import { readCapped } from "./http.js";
import { stateOf } from "./source-rcon.js";

export interface PalworldRestOptions extends ControlTimeouts {
  readonly host: string;
  readonly port: number;
  /** The REST user (the game only knows admin). */
  readonly user: string;
  readonly password: string;
  /** http or https (default http; the game serves plain HTTP). */
  readonly scheme?: "http" | "https";
  /** Where to read the server info (default /v1/api/info). */
  readonly infoPath?: string;
}

interface Request {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
}

const SHUTDOWN_MESSAGE = "The server is shutting down.";

export class PalworldRest implements GameControl {
  readonly kind = "palworldRest" as const;
  readonly #options: PalworldRestOptions;

  constructor(options: PalworldRestOptions) {
    this.#options = options;
  }

  async probe(): Promise<ProbeResult> {
    try {
      const body = await this.#request({
        method: "GET",
        path: this.#options.infoPath ?? "/v1/api/info",
      });
      // The info reply (version, servername, description, worldguid) holds
      // no player count; any JSON object proves the game answers.
      const info: unknown = JSON.parse(body);
      if (info === null || typeof info !== "object") {
        return { state: "unknown" };
      }
      return { state: "running" };
    } catch (error) {
      // The REST API answers only while the game runs, so a refused
      // authentication still proves the game is up.
      if (error instanceof ControlError && error.code === "Auth") {
        return { state: "running" };
      }
      return stateOf(error);
    }
  }

  /** Saves the world. The endpoint takes no body. */
  async save(): Promise<void> {
    await this.#request({ method: "POST", path: "/v1/api/save" });
  }

  /** Announces a message in game; only the server itself calls this. */
  async announce(message: string): Promise<void> {
    const text = message.replace(/[\u{0}-\u{1f}\u{7f}]/gu, " ").trim();
    if (text === "" || text.length > LIMITS.maxAnnounceLength) {
      throw new ControlError("Refused", "the announce message is not usable");
    }
    await this.#request({
      method: "POST",
      path: "/v1/api/announce",
      body: JSON.stringify({ message: text }),
    });
  }

  /** Shuts the world down after the given seconds. */
  async stop(): Promise<void> {
    await this.#request({
      method: "POST",
      path: "/v1/api/shutdown",
      body: JSON.stringify({
        waittime: 1,
        message: SHUTDOWN_MESSAGE,
      }),
    });
  }

  /**
   * One request with basic authentication. A 2xx answer returns the body; a
   * 401 or 403 is the configuration blocker; every other status is a
   * ControlError, so probe() can map it to unknown.
   */
  async #request(request: Request): Promise<string> {
    const scheme = this.#options.scheme ?? "http";
    const url = `${scheme}://${this.#options.host}:${this.#options.port}${request.path}`;
    const authorization = Buffer.from(
      `${this.#options.user}:${this.#options.password}`,
      "utf8",
    ).toString("base64");
    const timeoutMs = this.#options.readMs ?? LIMITS.readMs;
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          authorization: `Basic ${authorization}`,
          ...(request.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ControlError(
        "Connection",
        "the REST API is unreachable",
        error,
      );
    }
    const body = await readCapped(response, LIMITS.maxHttpBytes);
    if (response.status === 401 || response.status === 403) {
      throw new ControlError("Auth", "the REST API refused the credentials");
    }
    if (!response.ok) {
      throw new ControlError(
        "Connection",
        `the REST API answered ${response.status}`,
      );
    }
    return body;
  }
}
