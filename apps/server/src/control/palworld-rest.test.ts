// The Palworld REST client against an in-process HTTP server (dev-work-plan
// P6 tests: the Theriark Mock Server has no Palworld REST stub, so this is
// labelled simulated). The requests are asserted exactly: the basic
// authorization of the admin user, the paths of the game's own v1 API, the
// fixed shutdown message, and the refusal of redirects and oversized
// bodies.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PalworldRest } from "./palworld-rest.js";

const PASSWORD = "admin-rcon-secret";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

let port = 0;
let seen: Seen[] = [];
let status = 200;
let reply = "{}";
let redirect = false;
let huge = false;
const server: Server = createServer((request, response) => {
  const parts: Buffer[] = [];
  request.on("data", (chunk: Buffer) => parts.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(parts).toString("utf8");
    seen.push({
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body,
    });
    if (redirect) {
      response.writeHead(302, { location: "http://127.0.0.1:9/" });
      response.end();
      return;
    }
    if (huge) {
      response.writeHead(200, { "content-length": "999999999" });
      response.end();
      return;
    }
    if (status === 200 && request.url === "/v1/api/info") {
      reply = JSON.stringify({
        version: "v0.0.0-synthetic",
        servername: "Quarry Lane",
        description: "A synthetic server.",
        worldguid: "00000000000000000000000000000000",
      });
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(reply);
  });
});

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

const client = () =>
  new PalworldRest({
    host: "127.0.0.1",
    port,
    user: "admin",
    password: PASSWORD,
  });

describe("Palworld REST client (simulated)", () => {
  it("probes the info path with the admin credentials", async () => {
    status = 200;
    seen = [];
    const result = await client().probe();
    expect(result).toEqual({ state: "running" });
    expect(seen).toEqual([
      {
        method: "GET",
        path: "/v1/api/info",
        authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`,
        body: "",
      },
    ]);
  });

  it("saves with the empty-body endpoint", async () => {
    status = 200;
    seen = [];
    await client().save?.();
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/api/save" });
  });

  it("announces a bounded, cleaned message", async () => {
    status = 200;
    seen = [];
    await client().announce("Restart in five minutes");
    const request = seen.at(-1);
    expect(request?.path).toBe("/v1/api/announce");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      message: "Restart in five minutes",
    });
    await expect(client().announce("")).rejects.toMatchObject({
      code: "Refused",
    });
    await expect(client().announce("x".repeat(300))).rejects.toMatchObject({
      code: "Refused",
    });
  });

  it("shuts down with the fixed client message", async () => {
    status = 200;
    seen = [];
    await client().stop?.();
    const request = seen.at(-1);
    expect(request?.path).toBe("/v1/api/shutdown");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      waittime: 1,
      message: "The server is shutting down.",
    });
  });

  it("maps a refused credential to a running server and a config blocker", async () => {
    status = 401;
    const control = client();
    expect(await control.probe()).toEqual({ state: "running" });
    await expect(control.save?.()).rejects.toMatchObject({ code: "Auth" });
    status = 200;
  });

  it("reports stopped when the REST port is closed", async () => {
    // fetch refuses some low ports outright (port 1 is on its bad-port
    // list), so the closed port is one that was just bound and released.
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as AddressInfo;
        probe.close(() => resolve(free));
      });
    });
    const down = new PalworldRest({
      host: "127.0.0.1",
      port: closed,
      user: "admin",
      password: PASSWORD,
      readMs: 2_000,
    });
    expect(await down.probe()).toEqual({ state: "stopped" });
  });

  it("refuses a redirect and an oversized answer", async () => {
    redirect = true;
    expect(await client().probe()).toEqual({ state: "unknown" });
    redirect = false;
    huge = true;
    expect(await client().probe()).toEqual({ state: "unknown" });
    huge = false;
  });
});
