// A webhook receiver inside the test process (P9-B): an HTTP server on
// 127.0.0.1 that records every request and answers from a script, so the
// webhook and Discord channels are tested against recorded answers without
// any outside service. The Discord answers below are simulated: they follow
// the shapes Discord documents for webhook execution (204 without a body,
// 429 with retry_after in seconds, 404 Unknown Webhook with code 10015).
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Answer {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** Simulated Discord answers (recorded shapes, see above). */
export const DISCORD_ANSWERS = {
  ok: { status: 204 },
  okLastOfBucket: {
    status: 204,
    headers: {
      "x-ratelimit-limit": "5",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset-after": "1.5",
    },
  },
  rateLimited: {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "2" },
    body: JSON.stringify({
      message: "You are being rate limited.",
      retry_after: 2.5,
      global: false,
    }),
  },
  unknownWebhook: {
    status: 404,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Unknown Webhook", code: 10015 }),
  },
} satisfies Record<string, Answer>;

export interface HttpSink {
  readonly port: number;
  /** http://127.0.0.1:PORT */
  readonly base: string;
  readonly received: Received[];
  /** Answers for the next requests, in order; then the default answer. */
  script(...answers: Answer[]): void;
  close(): Promise<void>;
}

export async function startHttpSink(
  fallback: Answer = { status: 204 },
): Promise<HttpSink> {
  const received: Received[] = [];
  const queue: Answer[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const answer = queue.shift() ?? fallback;
      response.writeHead(answer.status, answer.headers ?? {});
      response.end(answer.body ?? "");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    base: `http://127.0.0.1:${String(port)}`,
    received,
    script: (...answers) => {
      queue.push(...answers);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
