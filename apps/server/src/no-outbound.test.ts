// No-outbound test (legal-input-1 5.5, dev-work-plan P1-A step 11). With its
// default settings the app opens no network connection of its own. Every way
// out (TCP and TLS sockets, DNS, UDP and fetch) is trapped while the app
// starts, listens, serves the first-run and signed-in API, runs the backup
// schedule, takes a backup and stops. Any attempt fails the test.
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { headersOf, setupOwner, testApp } from "../test/helpers.js";

const attempts: string[] = [];

function trap(name: string): never {
  attempts.push(name);
  throw new Error(`outbound network access blocked: ${name}`);
}

beforeAll(() => {
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() =>
    trap("net.Socket.connect"),
  );
  vi.spyOn(dgram.Socket.prototype, "send").mockImplementation(() =>
    trap("dgram.Socket.send"),
  );
  vi.spyOn(dns, "lookup").mockImplementation(() => trap("dns.lookup"));
  vi.spyOn(dns, "resolve").mockImplementation(() => trap("dns.resolve"));
  vi.spyOn(dns.promises, "lookup").mockImplementation(() =>
    trap("dns.promises.lookup"),
  );
  vi.spyOn(dns.promises, "resolve").mockImplementation(() =>
    trap("dns.promises.resolve"),
  );
  vi.stubGlobal("fetch", async (input: unknown) =>
    trap(`fetch ${String(input)}`),
  );
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("no outbound connections", () => {
  it("the trap catches a connection attempt", async () => {
    expect(() => net.connect(443, "192.0.2.1")).toThrow(/blocked/);
    await expect(fetch("https://example.invalid/")).rejects.toThrow(/blocked/);
    expect(attempts).toEqual([
      "net.Socket.connect",
      "fetch https://example.invalid/",
    ]);
    attempts.length = 0;
  });

  it("the app makes none while it starts, serves and stops", async () => {
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
      const backup = await app.inject({
        method: "POST",
        url: "/api/v1/system/backups",
        headers: headersOf(owner),
      });
      expect(backup.statusCode).toBe(201);
    } finally {
      await instance.close();
    }
    expect(attempts).toEqual([]);
  });
});
