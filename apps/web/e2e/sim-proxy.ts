// A simulated docker-socket-proxy for the P6 e2e specs (dev-work-plan P6-C):
// the one labelled container of the game and the three verbs a hook may ever
// run. It answers exactly what the server's docker proxy client asks for
// (apps/server/src/control/docker-proxy.ts) and nothing else, so every stop,
// start and restart driven by a spec is simulated and no container exists.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A container id of the exact shape the client's check requires. */
export const CONTAINER_ID = "0123456789abcdef".repeat(4);

/** The label the simulated container carries. */
export const CONTAINER_LABEL = "dialwarden.server=palworld-home";

const VERBS = /\/(stop|start|restart)$/;

export class SimProxy {
  /** Every verb the proxy answered, in order. */
  readonly verbs: string[] = [];
  #server: Server;
  #running = true;
  #port = 0;

  constructor() {
    this.#server = createServer((request, response) => {
      response.setHeader("connection", "close");
      const url = request.url ?? "";
      const answer = (status: number, body: string) => {
        response.statusCode = status;
        response.end(body);
      };
      if (request.method === "GET" && url.startsWith("/containers/json")) {
        answer(
          200,
          JSON.stringify([
            {
              Id: CONTAINER_ID,
              State: this.#running ? "running" : "stopped",
              Labels: { "dialwarden.server": "palworld-home" },
            },
          ]),
        );
      } else if (request.method === "POST" && VERBS.test(url)) {
        const verb = url.split("/").at(-1) ?? "";
        this.verbs.push(verb);
        answer(204, "");
        this.#running = verb !== "stop";
      } else {
        answer(404, "{}");
      }
    });
  }

  /** The container is put up or down by hand, between the flows. */
  set running(value: boolean) {
    this.#running = value;
  }

  get port(): number {
    return this.#port;
  }

  async start(): Promise<void> {
    await new Promise<void>((ready) => {
      this.#server.listen(0, "127.0.0.1", () => ready());
    });
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  close(): void {
    this.#server.close();
  }
}
