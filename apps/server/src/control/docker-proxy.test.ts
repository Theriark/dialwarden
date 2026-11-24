// The docker-socket-proxy hook against an in-process fake of the Docker API
// (dev-work-plan P6 tests: the client never mounts the Docker socket, so
// this is labelled simulated). Only the two endpoints the client may ever
// call are served: the label-filtered container list and the three verbs,
// and the client is held to them: the label is verified, ambiguity is
// refused, and the id is validated before it goes into a path.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerProxy } from "./docker-proxy.js";

const LABEL = "dialwarden.game=valheim";
const ID = "1f2e3d4c5b6a7988776677889900aabbccddeeff00112233445566778899aabb";

interface Asked {
  readonly method: string;
  readonly path: string;
}

let port = 0;
let asked: Asked[] = [];
let list: unknown[] = [];
let status = 200;
const server: Server = createServer((request, response) => {
  asked.push({ method: request.method ?? "", path: request.url ?? "" });
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/containers/json") {
    if (status !== 200) {
      response.writeHead(status).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(list));
    return;
  }
  const action = url.pathname.split("/").at(-1);
  if (action === "stop" || action === "start" || action === "restart") {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(404).end();
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

const entry = (state: string, labels: { [key: string]: string }) => ({
  Id: ID,
  State: state,
  Labels: labels,
});

const client = () =>
  new DockerProxy({
    url: `http://127.0.0.1:${port}`,
    containerLabel: LABEL,
    readMs: 2_000,
  });

describe("docker proxy hook (simulated)", () => {
  it("finds nothing to ask before the label is verified", async () => {
    list = [];
    status = 200;
    await expect(client().restart()).rejects.toMatchObject({
      code: "Refused",
    });
    const query = asked[0]?.path ?? "";
    expect(query).toContain("/containers/json");
    expect(query).toContain(encodeURIComponent(`{"label":["${LABEL}"]}`));
  });

  it("reports running and stopped by the container state", async () => {
    list = [entry("running", { "dialwarden.game": "valheim" })];
    expect(await client().probe()).toEqual({ state: "running" });
    list = [entry("exited", { "dialwarden.game": "valheim" })];
    expect(await client().probe()).toEqual({ state: "stopped" });
  });

  it("refuses a container that does not carry the label", async () => {
    list = [entry("running", { "other.label": "x" })];
    await expect(client().restart()).rejects.toMatchObject({
      code: "Protocol",
    });
  });

  it("refuses when several containers carry the label", async () => {
    list = [
      entry("running", { "dialwarden.game": "valheim" }),
      entry("running", { "dialwarden.game": "valheim" }),
    ];
    await expect(client().restart()).rejects.toMatchObject({
      code: "Refused",
    });
  });

  it("restarts through the one verb endpoint it may call", async () => {
    list = [entry("running", { "dialwarden.game": "valheim" })];
    asked = [];
    await client().restart();
    const verbs = asked.map((a) => [
      a.method,
      new URL(a.path, "http://127.0.0.1").pathname.split("/").at(-1),
    ]);
    expect(verbs).toEqual([
      ["GET", "json"],
      ["POST", "restart"],
    ]);
  });

  it("starts and stops the same way", async () => {
    list = [entry("running", { "dialwarden.game": "valheim" })];
    asked = [];
    const control = client();
    await control.stop();
    await control.start();
    expect(asked.map((a) => a.method)).toEqual(["GET", "POST", "GET", "POST"]);
  });

  it("says unknown when the proxy is unreachable or unusual", async () => {
    status = 500;
    expect(await client().probe()).toEqual({ state: "unknown" });
    status = 200;
    const down = new DockerProxy({
      url: "http://127.0.0.1:1",
      containerLabel: LABEL,
      readMs: 1_000,
    });
    expect(await down.probe()).toEqual({ state: "unknown" });
  });

  it("refuses unusable URLs and labels at construction", () => {
    expect(
      () =>
        new DockerProxy({
          url: "http://user:pass@127.0.0.1:2375",
          containerLabel: LABEL,
        }),
    ).toThrowError(/not usable/);
    expect(
      () =>
        new DockerProxy({
          url: "http://127.0.0.1:2375/path",
          containerLabel: LABEL,
        }),
    ).toThrowError(/not usable/);
    expect(
      () =>
        new DockerProxy({
          url: "ftp://127.0.0.1:2375",
          containerLabel: LABEL,
        }),
    ).toThrowError(/not usable/);
    expect(
      () =>
        new DockerProxy({
          url: "http://127.0.0.1:2375",
          containerLabel: "label with spaces",
        }),
    ).toThrowError(/not usable/);
  });
});
