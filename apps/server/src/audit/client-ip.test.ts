// The client address and the audit IP setting (dev-work-plan P8-A step 4;
// p8-threat-specs N-01 to N-14). TRUSTED_PROXIES is the Runtime value; the
// address is the right-most X-Forwarded-For entry that is not a trusted
// proxy, and only what node:net accepts is stored.
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FAILURES_PER_ADDRESS } from "../auth/limiter.js";
import { loadConfig } from "../config.js";
import { auditEvents, sessions } from "../db/schema.js";
import {
  headersOf,
  ownerCredentials,
  setupOwner,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import { call, teamFixture, testEmail } from "../../test/team.js";
import { auditAddress, truncateAddress } from "./ip.js";

const TRUSTED = "172.31.1.0/24,172.17.0.1";
const TRUSTED_V6 = "fd00:1::/64,2001:db8:ffff::1";
const HYPERLINK = '=HYPERLINK("http://evil.example","x")';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** A probe route that answers request.ip. */
function withProbe(app: FastifyInstance): void {
  app.get(
    "/api/v1/test/ip",
    { config: { auth: "public" } },
    async (request) => ({ ip: request.ip }),
  );
}

async function ipApp(trusted: string | null = TRUSTED): Promise<TestApp> {
  current = await testApp({
    extend: withProbe,
    extraEnv: trusted === null ? {} : { TRUSTED_PROXIES: trusted },
  });
  return current;
}

async function seen(
  app: FastifyInstance,
  remoteAddress: string,
  forwarded?: string,
): Promise<string> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/test/ip",
    remoteAddress,
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  });
  return response.json<{ ip: string }>().ip;
}

describe("client address (N-01 to N-08)", () => {
  it("N-01 ignores a spoofed header from an untrusted peer", async () => {
    const { app } = await ipApp();
    expect(await seen(app, "203.0.113.5", "10.1.2.3")).toBe("203.0.113.5");
  });

  it("N-02 takes the client behind one trusted proxy", async () => {
    const { app } = await ipApp();
    expect(await seen(app, "172.17.0.1", "198.51.100.9")).toBe("198.51.100.9");
  });

  it("N-03 takes the right-most address that is not a trusted proxy", async () => {
    const { app } = await ipApp();
    const chain = "1.2.3.4, 198.51.100.9, 172.31.1.20";
    expect(await seen(app, "172.31.1.10", chain)).toBe("198.51.100.9");
  });

  it("N-04 ignores a spoofed left part through a trusted proxy", async () => {
    const { app } = await ipApp();
    const chain = "127.0.0.1, 203.0.113.50";
    expect(await seen(app, "172.17.0.1", chain)).toBe("203.0.113.50");
  });

  it("N-05 takes the left-most address when every hop is trusted", async () => {
    const { app } = await ipApp();
    expect(await seen(app, "172.17.0.1", "172.31.1.5")).toBe("172.31.1.5");
  });

  it("N-06 stores no address when the client sent no address", async () => {
    const { app } = await ipApp();
    const credentials = ownerCredentials();
    await setupOwner(app, credentials);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "172.17.0.1",
      headers: { "x-forwarded-for": `${HYPERLINK}, not-an-ip` },
      payload: credentials,
    });
    expect(login.statusCode).toBe(200);
    const rows = app.ctx.store.db.select().from(auditEvents).all();
    const row = rows.find((item) => item.action.endsWith("/auth/login"));
    expect(row?.ip).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("HYPERLINK");
  });

  it("N-07 trusts no proxy without TRUSTED_PROXIES", async () => {
    const { app } = await ipApp(null);
    expect(await seen(app, "203.0.113.5", "198.51.100.9")).toBe("203.0.113.5");
  });

  it("N-08 matches an IPv4-mapped peer against the IPv4 entry", async () => {
    const { app } = await ipApp();
    const answer = await seen(app, "::ffff:172.17.0.1", "198.51.100.9");
    expect(answer).toBe("198.51.100.9");
  });
});

describe("IPv6 proxies and clients (N-01 to N-04, N-10)", () => {
  const CLIENT_V6 = "2001:db8:abcd:12::9";

  it("takes the IPv6 client behind a trusted IPv6 proxy", async () => {
    const { app } = await ipApp(TRUSTED_V6);
    expect(await seen(app, "fd00:1::5", CLIENT_V6)).toBe(CLIENT_V6);
    const chain = `198.51.100.9, ${CLIENT_V6}`;
    expect(await seen(app, "2001:db8:ffff::1", chain)).toBe(CLIENT_V6);
  });

  it("takes the right-most untrusted address through IPv6 hops", async () => {
    const { app } = await ipApp(TRUSTED_V6);
    const chain = `2001:db8:1::1, ${CLIENT_V6}, fd00:1::7`;
    expect(await seen(app, "fd00:1::5", chain)).toBe(CLIENT_V6);
  });

  it("ignores a spoofed header from an untrusted IPv6 peer", async () => {
    const { app } = await ipApp(TRUSTED_V6);
    const peer = "2001:db8:bad::7";
    expect(await seen(app, peer, "fd00:1::5")).toBe(peer);
    expect(await seen(app, peer, CLIENT_V6)).toBe(peer);
  });

  it("stores the /48 form of an IPv6 client behind the proxy", async () => {
    const { app } = await ipApp(TRUSTED_V6);
    const credentials = ownerCredentials();
    await setupOwner(app, credentials);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "fd00:1::5",
      headers: { "x-forwarded-for": CLIENT_V6 },
      payload: credentials,
    });
    expect(login.statusCode).toBe(200);
    const rows = app.ctx.store.db.select().from(auditEvents).all();
    const row = rows.find((item) => item.action.endsWith("/auth/login"));
    expect(row?.ip).toBe("2001:db8:abcd::");
  });
});

describe("the audit IP setting (N-09 to N-12)", () => {
  it("N-09 truncates IPv4 to /24, the mapped form as IPv4", () => {
    expect(truncateAddress("198.51.100.9")).toBe("198.51.100.0");
    expect(truncateAddress("::ffff:198.51.100.9")).toBe("198.51.100.0");
  });

  it("N-10 truncates IPv6 to /48 and drops a zone id", () => {
    const full = "2001:db8:abcd:12:3456:789a:bcde:f012";
    expect(truncateAddress(full)).toBe("2001:db8:abcd::");
    expect(truncateAddress("2001:db8::1")).toBe("2001:db8::");
    expect(auditAddress("fe80::1%eth0", "truncated")).toBe("fe80::");
    expect(auditAddress("fe80::1%eth0", "full")).toBe("fe80::1");
    expect(auditAddress("not-an-ip", "full")).toBeNull();
  });

  it("N-11 keeps no address in the audit log or the sessions with none", async () => {
    const t = await teamFixture();
    current = t.current;
    const url = "/api/v1/settings/audit";
    const set = await call(t.app, t.owner, "PUT", url, { ipMode: "none" });
    expect(set.statusCode).toBe(200);
    const before = t.app.ctx.store.db.select().from(auditEvents).all().length;
    const login = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "203.0.113.7",
      payload: { email: t.editor.email, password: t.editor.password },
    });
    expect(login.statusCode).toBe(200);
    const rows = t.app.ctx.store.db.select().from(auditEvents).all();
    for (const row of rows.slice(before)) {
      expect(row.ip).toBeNull();
    }
    const kept = t.app.ctx.store.db.select().from(sessions).all();
    expect(kept.some((row) => row.ip === "203.0.113.7")).toBe(false);
  });

  it("N-12 lets only the owner and admins change the setting", async () => {
    const t = await teamFixture();
    current = t.current;
    const url = "/api/v1/settings/audit";
    const byEditor = await call(t.app, t.editor, "PUT", url, {
      ipMode: "full",
    });
    expect(byEditor.statusCode).toBe(403);
    const half = await call(t.app, t.owner, "PUT", url, { ipMode: "half" });
    expect(half.statusCode).toBe(400);
    const ok = await call(t.app, t.owner, "PUT", url, {
      ipMode: "truncated",
    });
    expect(ok.statusCode).toBe(200);
    const rows = t.app.ctx.store.db.select().from(auditEvents).all();
    expect(rows.at(-1)?.action).toBe("PUT /api/v1/settings/audit");
  });
});

describe("rate limit key and TRUSTED_PROXIES (N-13, N-14)", () => {
  it("N-13 counts failures per client behind a proxy", async () => {
    const { app } = await ipApp();
    await setupOwner(app);
    const codes: number[] = [];
    for (let n = 0; n <= MAX_FAILURES_PER_ADDRESS; n += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: "172.17.0.1",
        headers: { "x-forwarded-for": `10.0.0.${String(n)}, 198.51.100.9` },
        payload: { email: testEmail("nobody"), password: "wrong-password" },
      });
      codes.push(response.statusCode);
    }
    const early = codes.slice(0, MAX_FAILURES_PER_ADDRESS);
    expect(early.every((code) => code === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("N-14 refuses a TRUSTED_PROXIES value that trusts nearly everyone", () => {
    for (const value of [
      "0.0.0.0/0",
      "::/0",
      "*",
      "loopback",
      "0.0.0.0/1,128.0.0.0/1",
      "10.0.0.0/7",
      "2001::/31",
      // IPv6 ranges that hold every IPv4 peer in its mapped form.
      "::ffff:0:0/96",
      "::ffff:0.0.0.0/100",
      "::/32",
      "::/80",
      "::ffff:0:0/103",
      // Host bits do not narrow a range: this is ::/32.
      "0:0:1::/32",
    ]) {
      expect(() => loadConfig({ TRUSTED_PROXIES: value }), value).toThrow(
        /TRUSTED_PROXIES/,
      );
    }
    const ok = loadConfig({ TRUSTED_PROXIES: TRUSTED });
    expect(ok.trustProxy).toBe(TRUSTED);
  });

  it("N-14 accepts IPv6 entries of /32 or longer", () => {
    for (const value of [
      TRUSTED_V6,
      "2001:db8::/32",
      "::ffff:172.17.0.0/112",
      "::ffff:10.0.0.0/104",
      "::1",
    ]) {
      expect(loadConfig({ TRUSTED_PROXIES: value }).trustProxy).toBe(value);
    }
  });

  it("keeps sign-in working behind the proxy", async () => {
    const { app } = await ipApp();
    const owner = await setupOwner(app);
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      remoteAddress: "172.17.0.1",
      headers: { ...headersOf(owner), "x-forwarded-for": "198.51.100.9" },
    });
    expect(session.statusCode).toBe(200);
  });
});
