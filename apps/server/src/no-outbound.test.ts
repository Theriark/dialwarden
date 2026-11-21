// No-outbound test (legal-input-1 5.5, dev-work-plan P1-A step 11). With its
// default settings the app opens no network connection of its own. Every way
// out (TCP and TLS sockets, every DNS function and resolver, UDP and fetch) is
// trapped before the app's modules load, then the app starts, listens, serves
// the first-run and signed-in API, runs its scheduled backup job, takes a
// backup and stops. Any attempt fails the test.
//
// Looking up an IP literal stays allowed: Node answers it without the network,
// and net.Server.listen goes through dns.lookup even for 127.0.0.1.
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Helpers = typeof import("../test/helpers.js");

const attempts: string[] = [];
let helpers: Helpers;

function trap(name: string): never {
  attempts.push(name);
  throw new Error(`outbound network access blocked: ${name}`);
}

/** Every DNS function that can reach a server (c-ares or getaddrinfo). */
const DNS_FUNCTIONS = [
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
] as const;

function trapAll(target: object, label: string): void {
  for (const name of DNS_FUNCTIONS) {
    if (typeof Reflect.get(target, name) === "function") {
      const spy = vi.spyOn(target as Record<string, () => unknown>, name);
      spy.mockImplementation(() => trap(`${label}.${name}`));
    }
  }
}

beforeAll(async () => {
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() =>
    trap("net.Socket.connect"),
  );
  vi.spyOn(dgram.Socket.prototype, "send").mockImplementation(() =>
    trap("dgram.Socket.send"),
  );
  const lookup = dns.lookup.bind(dns) as (...args: unknown[]) => void;
  vi.spyOn(dns, "lookup").mockImplementation((...args: unknown[]) => {
    const [hostname] = args;
    if (typeof hostname === "string" && net.isIP(hostname) !== 0) {
      lookup(...args);
      return;
    }
    trap(`dns.lookup ${String(hostname)}`);
  });
  vi.spyOn(dns.promises, "lookup").mockImplementation(() =>
    trap("dns.promises.lookup"),
  );
  trapAll(dns, "dns");
  trapAll(dns.promises, "dns.promises");
  trapAll(dns.Resolver.prototype, "dns.Resolver");
  trapAll(dns.promises.Resolver.prototype, "dns.promises.Resolver");
  vi.stubGlobal("fetch", async (input: unknown) =>
    trap(`fetch ${String(input)}`),
  );
  // Loaded only now, so a call made while a module loads is caught too.
  helpers = await import("../test/helpers.js");
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("no outbound connections", () => {
  it("the trap catches a connection attempt", async () => {
    expect(() => net.connect(443, "192.0.2.1")).toThrow(/blocked/);
    await expect(fetch("https://example.invalid/")).rejects.toThrow(/blocked/);
    expect(() => dns.resolve4("example.invalid", () => undefined)).toThrow(
      /blocked/,
    );
    const resolver = new dns.Resolver();
    const any = () => resolver.resolveAny("example.invalid", () => undefined);
    expect(any).toThrow(/blocked/);
    expect(() => dns.lookup("example.invalid", () => undefined)).toThrow(
      /blocked/,
    );
    expect(attempts).toEqual([
      "net.Socket.connect",
      "fetch https://example.invalid/",
      "dns.resolve4",
      "dns.Resolver.resolveAny",
      "dns.lookup example.invalid",
    ]);
    attempts.length = 0;
  });

  it("the app makes none while it starts, serves and stops", async () => {
    const { headersOf, setupOwner, testApp } = helpers;
    const instance = await testApp();
    try {
      const { app } = instance;
      const { backupSchedule, backupTimezone } = app.ctx.config;
      app.ctx.backups.start(backupSchedule, backupTimezone);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const open = ["/healthz", "/readyz", "/api/v1/setup"];
      for (const url of [...open, "/api/v1/openapi.json"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(200);
      }
      const owner = await setupOwner(app);
      const signedIn = [
        "/api/v1/entitlement",
        "/api/v1/activity",
        "/api/v1/plan/registry",
        "/api/v1/system/status",
      ];
      for (const url of signedIn) {
        const headers = headersOf(owner);
        const res = await app.inject({ method: "GET", url, headers });
        expect(res.statusCode, url).toBe(200);
      }
      // The daily job, fired once by hand, then a backup through the API.
      await app.ctx.backups.runScheduledNow();
      const backup = await app.inject({
        method: "POST",
        url: "/api/v1/system/backups",
        headers: headersOf(owner),
      });
      expect(backup.statusCode).toBe(201);
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/system/backups",
        headers: headersOf(owner),
      });
      const { items } = list.json<{ items: unknown[] }>();
      expect(items.length).toBeGreaterThanOrEqual(2);
    } finally {
      await instance.close();
    }
    expect(attempts).toEqual([]);
  });
});
