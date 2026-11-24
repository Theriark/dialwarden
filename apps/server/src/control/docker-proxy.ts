// Docker restart hook through a docker-socket-proxy (contract C7,
// dev-work-plan P6-A step 3): the app never mounts the Docker socket; the
// user gives the base URL of their own proxy and the label that marks the
// game's container. The client can only ever list containers by that label
// and start, stop and restart the one container that carries it; every
// other Docker API surface is out of reach by construction. An unreachable
// proxy says nothing about the game, so its probe reports unknown, and only
// a found container gives running or stopped. The container is looked up
// again right before every action, and the id is validated before it goes
// into a path, so nothing but the labelled container is ever touched.
import { readCapped } from "./http.js";
import {
  ControlError,
  LIMITS,
  type ControlTimeouts,
  type GameControl,
  type ProbeResult,
} from "./types.js";

/** A Docker container id the list endpoint returns. */
const CONTAINER_ID = /^[0-9a-f]{64}$/;
/** A label selector: a key, or key=value (Docker accepts both). */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:=.+)?$/;

export interface DockerProxyOptions extends ControlTimeouts {
  /** The base URL of the docker-socket-proxy, http or https, no path. */
  readonly url: string;
  /** Only containers carrying this label are ever touched. */
  readonly containerLabel: string;
}

interface ContainerEntry {
  readonly Id: string;
  readonly State: string;
  readonly Labels: { readonly [key: string]: string };
}

export class DockerProxy implements GameControl {
  readonly kind = "dockerProxy" as const;
  readonly #base: string;
  readonly #label: string;
  readonly #readMs: number;

  constructor(options: DockerProxyOptions) {
    const url = new URL(options.url);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/"
    ) {
      throw new ControlError("Refused", "the proxy URL is not usable");
    }
    if (!LABEL.test(options.containerLabel)) {
      throw new ControlError("Refused", "the container label is not usable");
    }
    this.#base = `${url.protocol}//${url.host}`;
    this.#label = options.containerLabel;
    this.#readMs = options.readMs ?? LIMITS.readMs;
  }

  async probe(): Promise<ProbeResult> {
    try {
      const container = await this.#find();
      return { state: container.State === "running" ? "running" : "stopped" };
    } catch {
      // An unreachable or unusual proxy says nothing about the game.
      return { state: "unknown" };
    }
  }

  async stop(): Promise<void> {
    await this.#act("stop");
  }

  async start(): Promise<void> {
    await this.#act("start");
  }

  async restart(): Promise<void> {
    await this.#act("restart");
  }

  /** The one container with the label; ambiguity is refused, never guessed. */
  async #find(): Promise<ContainerEntry> {
    const filters = JSON.stringify({ label: [this.#label] });
    const response = await this.#request(
      "GET",
      `/containers/json?all=1&filters=${encodeURIComponent(filters)}`,
    );
    const listed = JSON.parse(response) as unknown;
    if (!Array.isArray(listed)) {
      throw new ControlError("Protocol", "the proxy answer is not usable");
    }
    if (listed.length === 0) {
      throw new ControlError("Refused", "no container carries the label");
    }
    if (listed.length > 1) {
      throw new ControlError("Refused", "several containers carry the label");
    }
    const entry = listed[0] as ContainerEntry;
    if (
      typeof entry.Id !== "string" ||
      !CONTAINER_ID.test(entry.Id) ||
      typeof entry.State !== "string" ||
      this.#carriesLabel(entry) === false
    ) {
      throw new ControlError("Protocol", "the proxy answer is not usable");
    }
    return entry;
  }

  /** True when the entry really carries the configured label. */
  #carriesLabel(entry: ContainerEntry): boolean {
    const at = this.#label.indexOf("=");
    const key = at < 0 ? this.#label : this.#label.slice(0, at);
    const value = at < 0 ? undefined : this.#label.slice(at + 1);
    const labels: unknown = entry.Labels;
    if (labels === null || typeof labels !== "object") return false;
    const found = new Map(Object.entries(labels)).get(key);
    if (typeof found !== "string") return false;
    return value === undefined || found === value;
  }

  /** One of the three verbs, on the container found again right before. */
  async #act(verb: "stop" | "start" | "restart"): Promise<void> {
    const container = await this.#find();
    await this.#request("POST", `/containers/${container.Id}/${verb}`);
  }

  /**
   * One request to the proxy; a 2xx answer returns the body. Docker answers
   * the verbs with 204 and no body, and with 304 when the container is
   * already in that state; both are success and return "".
   */
  async #request(method: "GET" | "POST", path: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.#base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.#readMs),
      });
    } catch (error) {
      throw new ControlError("Connection", "the proxy is unreachable", error);
    }
    if (response.status === 204 || response.status === 304) {
      await response.body?.cancel();
      return "";
    }
    if (response.ok) {
      const body = await readCapped(response, LIMITS.maxHttpBytes);
      if (method === "GET" && body === "") {
        throw new ControlError("Protocol", "the proxy answer is not usable");
      }
      return body;
    }
    throw new ControlError(
      "Failed",
      `the proxy refused the request (${response.status})`,
    );
  }
}
