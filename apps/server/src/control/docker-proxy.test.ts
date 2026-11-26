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
let rawBody: string | undefined;
let verbStatus = 204;
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
      .end(rawBody ?? JSON.stringify(list));
    return;
  }
  const action = url.pathname.split("/").at(-1);
  if (action === "stop" || action === "start" || action === "restart") {
    response.writeHead(verbStatus).end();
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

// Threat tests T8 (security review THE-2598) and the id and status cases of
// the test acceptance (G1, G2): an unusable answer or URL is a ControlError
// that quotes nothing, and an id is validated before it goes into a path.
describe("docker proxy hook: refusals (simulated)", () => {
  it("refuses a body that is not JSON without quoting it", async () => {
    list = [entry("running", { "dialwarden.game": "valheim" })];
    rawBody = "<html>proxy-secret-body</html>";
    asked = [];
    const error: unknown = await client()
      .restart()
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "Protocol" });
    expect((error as Error).message).not.toContain("proxy-secret-body");
    expect(asked.filter((a) => a.method === "POST")).toEqual([]);
    rawBody = undefined;
  });

  it.each(["not a url", ""])(
    "refuses the proxy URL %j with a ControlError",
    (url) => {
      expect(() => new DockerProxy({ url, containerLabel: LABEL })).toThrow(
        expect.objectContaining({ code: "Refused" }),
      );
    },
  );

  it.each([
    "../images/create",
    "../../images/create",
    ID.toUpperCase(),
    ID.slice(0, 12),
    "abc",
    ID.slice(1),
  ])("never puts the id %j into a path", async (id) => {
    list = [
      { Id: id, State: "running", Labels: { "dialwarden.game": "valheim" } },
    ];
    asked = [];
    await expect(client().restart()).rejects.toMatchObject({
      code: "Protocol",
    });
    expect(asked.map((a) => a.method)).toEqual(["GET"]);
    expect(await client().probe()).toEqual({ state: "unknown" });
  });

  it("takes 304 from a verb as done and any other non-2xx as failed", async () => {
    list = [entry("running", { "dialwarden.game": "valheim" })];
    verbStatus = 304;
    asked = [];
    await client().start();
    expect(asked.map((a) => a.method)).toEqual(["GET", "POST"]);
    verbStatus = 500;
    asked = [];
    await expect(client().stop()).rejects.toMatchObject({ code: "Failed" });
    expect(asked.filter((a) => a.method === "POST")).toHaveLength(1);
    verbStatus = 204;
  });

  it("refuses a container whose label value differs", async () => {
    list = [entry("running", { "dialwarden.game": "rust" })];
    asked = [];
    await expect(client().restart()).rejects.toMatchObject({
      code: "Protocol",
    });
    expect(asked.filter((a) => a.method === "POST")).toEqual([]);
  });

  it.each([
    "http://127.0.0.1:2375/?x=1",
    "http://127.0.0.1:2375/#f",
    "unix:///var/run/docker.sock",
    "http://user@127.0.0.1:2375",
    "http://127.0.0.1:2375/v1.43",
    // P10-A L6: link-local (cloud metadata), unspecified and multicast.
    "http://169.254.169.254/",
    "http://[fe80::1]:2375/",
    "http://0.0.0.0:2375/",
    "http://224.0.0.1:2375/",
    "http://[::ffff:169.254.169.254]/",
  ])("refuses the proxy URL %j at construction", (url) => {
    expect(() => new DockerProxy({ url, containerLabel: LABEL })).toThrow(
      expect.objectContaining({ code: "Refused" }),
    );
  });

  it("L6 keeps private and loopback proxies usable", () => {
    for (const url of [
      "http://10.0.0.8:2375/",
      "http://127.0.0.1:2375/",
      "http://[::1]:2375/",
      "http://socket-proxy:2375/",
    ]) {
      expect(
        () => new DockerProxy({ url, containerLabel: LABEL }),
      ).not.toThrow();
    }
  });

  // P10-A G2.7: a proxy that redirects never moves a request elsewhere.
  it("G2.7 follows no redirect of the proxy", async () => {
    const elsewhere: string[] = [];
    const second = createServer((request, response) => {
      elsewhere.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    await new Promise<void>((resolve) => {
      second.listen(0, "127.0.0.1", () => resolve());
    });
    const target = `http://127.0.0.1:${(second.address() as AddressInfo).port}`;
    const redirecting = createServer((request, response) => {
      response.writeHead(302, { location: `${target}${request.url ?? "/"}` });
      response.end();
    });
    await new Promise<void>((resolve) => {
      redirecting.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const where = redirecting.address() as AddressInfo;
      const proxy = new DockerProxy({
        url: `http://127.0.0.1:${where.port}`,
        containerLabel: LABEL,
        readMs: 2_000,
      });
      expect(await proxy.probe()).toEqual({ state: "unknown" });
      await expect(proxy.restart()).rejects.toMatchObject({
        code: "Connection",
      });
      expect(elsewhere).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => redirecting.close(() => resolve()));
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  });
});
