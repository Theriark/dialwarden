// Authentication (dev-work-plan P1-A step 3, P1 Acceptance): argon2id, first-run
// setup, the session cookie, CSRF, the login rate limit, TOTP with recovery
// codes, and the password change.
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  headersOf,
  randomPassword,
  sessionCookie,
  setupOwner,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import {
  MAX_FAILURES_PER_ACCOUNT,
  MAX_FAILURES_PER_ADDRESS,
  WINDOW_MS,
} from "./limiter.js";
import { base32Decode, hotp, totpStep } from "./totp.js";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** A clock the test moves by hand (the app reads it through options.now). */
function manualClock(start = "2026-11-21T10:00:00Z") {
  let at = Date.parse(start);
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const codeAt = (secret: string, date: Date): string =>
  hotp(base32Decode(secret), totpStep(date));

/** A six-digit code that differs from the given one. */
const otherCode = (code: string): string =>
  String((Number(code) + 1) % 1_000_000).padStart(6, "0");

function login(
  app: FastifyInstance,
  email: string,
  password: string,
  remoteAddress = "127.0.0.1",
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    remoteAddress,
  });
}

function secondFactor(
  app: FastifyInstance,
  challenge: string,
  answer: { code: string } | { recoveryCode: string },
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login/totp",
    payload: { challenge, ...answer },
  });
}

/** Cookie and CSRF headers of the session a sign-in response started. */
function sessionHeaders(
  response: LightMyRequestResponse,
): Record<string, string> {
  const { csrfToken } = response.json<{ csrfToken: string }>();
  return { cookie: sessionCookie(response), "x-csrf-token": csrfToken };
}

/** Signs in with the password and returns the TOTP challenge. */
async function challengeOf(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const response = await login(app, email, password);
  const body = response.json<{ status: string; challenge: string }>();
  expect(body.status).toBe("totp_required");
  expect(response.cookies.some((c) => c.name === "dw_session")).toBe(false);
  return body.challenge;
}

/** An owner with TOTP on; the clock is one step past the enabling code. */
async function ownerWithTotp(app: FastifyInstance, clock: { now: () => Date }) {
  const owner = await setupOwner(app);
  const enrol = await app.inject({
    method: "POST",
    url: "/api/v1/auth/totp/enrol",
    headers: headersOf(owner),
    payload: { password: owner.password },
  });
  const { secret } = enrol.json<{ secret: string }>();
  const enable = await app.inject({
    method: "POST",
    url: "/api/v1/auth/totp/enable",
    headers: headersOf(owner),
    payload: { code: codeAt(secret, clock.now()) },
  });
  expect(enable.statusCode).toBe(200);
  return { owner, secret };
}

describe("first-run setup", () => {
  it("creates the owner once, with an argon2id hash", async () => {
    current = await testApp();
    const { app } = current;
    const before = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(before.json()).toEqual({ required: true });

    const owner = await setupOwner(app);
    const row = app.ctx.store.sqlite
      .prepare("SELECT role, password_hash AS hash FROM users")
      .get() as { role: string; hash: string };
    expect(row.role).toBe("owner");
    expect(row.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(row.hash).not.toContain(owner.password);

    const after = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(after.json()).toEqual({ required: false });
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: {
        email: "second@dialwarden.test",
        password: randomPassword(),
        name: "Second owner",
      },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "setup_done" });
  });

  it("lets only one of two concurrent setup requests create the owner", async () => {
    current = await testApp();
    const { app } = current;
    const setup = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/setup",
        payload: { email, password: randomPassword(), name: "Owner" },
      });
    const results = await Promise.all([
      setup("one@dialwarden.test"),
      setup("two@dialwarden.test"),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
  });

  it("refuses a password shorter than 12 characters", async () => {
    current = await testApp();
    const res = await current.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: {
        email: "owner@dialwarden.test",
        password: "short-pw",
        name: "Owner",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("session cookie and CSRF", () => {
  it("sets an HttpOnly, SameSite=Strict session cookie", async () => {
    current = await testApp();
    const res = await current.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: {
        email: "owner@dialwarden.test",
        password: randomPassword(),
        name: "Owner",
      },
    });
    const cookie = res.cookies.find((c) => c.name === "dw_session");
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
  });

  it("refuses a state-changing request without the right CSRF header", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const patch = (headers: Record<string, string>) =>
      app.inject({
        method: "PATCH",
        url: "/api/v1/auth/profile",
        headers,
        payload: { name: "Changed" },
      });

    const missing = await patch({ cookie: owner.cookie });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ error: "csrf" });
    const wrong = await patch({
      cookie: owner.cookie,
      "x-csrf-token": "x".repeat(43),
    });
    expect(wrong.statusCode).toBe(403);

    // The CSRF token of another session of the same user is refused too.
    const other = await login(app, owner.email, owner.password);
    const foreign = await patch({
      cookie: owner.cookie,
      "x-csrf-token": sessionHeaders(other)["x-csrf-token"] ?? "",
    });
    expect(foreign.statusCode).toBe(403);

    const ok = await patch(headersOf(owner));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ user: { name: "Changed" } });

    // Reading needs no CSRF header.
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: owner.cookie },
    });
    expect(read.statusCode).toBe(200);
  });

  it("needs a session for the API and ignores a tampered cookie", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/v1/activity",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: "unauthenticated" });
    const tampered = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: `${owner.cookie}x` },
    });
    expect(tampered.statusCode).toBe(401);
  });

  it("ends the session on logout", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: headersOf(owner),
    });
    expect(logout.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: owner.cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("login", () => {
  it("signs in with the right password and refuses a wrong one", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const wrong = await login(app, owner.email, "not-the-password");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: "invalid_credentials" });
    const unknown = await login(app, "nobody@dialwarden.test", owner.password);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: "invalid_credentials" });
    const right = await login(app, owner.email.toUpperCase(), owner.password);
    expect(right.statusCode).toBe(200);
    expect(right.json()).toMatchObject({
      status: "ok",
      user: { role: "owner" },
    });
    expect(() => sessionCookie(right)).not.toThrow();
  });

  it("rate-limits failed attempts per account, the right password included", async () => {
    const clock = manualClock();
    current = await testApp({ now: clock.now });
    const { app } = current;
    const owner = await setupOwner(app);
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i += 1) {
      const res = await login(app, owner.email, "wrong-password-123");
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login(app, owner.email, owner.password);
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json<{ error: string; retryAfter: number }>();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBeGreaterThan(0);

    clock.advance(WINDOW_MS + 1000);
    const allowed = await login(app, owner.email, owner.password);
    expect(allowed.statusCode).toBe(200);
  });

  it("rate-limits failed attempts per client address", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const address = "198.51.100.7";
    for (let i = 0; i < MAX_FAILURES_PER_ADDRESS; i += 1) {
      const email = `nobody${i}@dialwarden.test`;
      await login(app, email, "wrong-password-123", address);
    }
    const blocked = await login(app, owner.email, owner.password, address);
    expect(blocked.statusCode).toBe(429);
    const elsewhere = await login(
      app,
      owner.email,
      owner.password,
      "198.51.100.8",
    );
    expect(elsewhere.statusCode).toBe(200);
  });

  // Threat tests T2 (THE-2134 M1, code review H2): a burst of parallel
  // attempts gets no more tries than one at a time.
  it("counts parallel wrong passwords before any hash check ends", async () => {
    const clock = manualClock();
    current = await testApp({ now: clock.now });
    const { app } = current;
    const owner = await setupOwner(app);
    const address = "203.0.113.9";
    const burst = await Promise.all(
      Array.from({ length: 30 }, () =>
        login(app, owner.email, "wrong-password-123", address),
      ),
    );
    const codes = burst.map((res) => res.statusCode);
    const refused = codes.filter((code) => code === 401);
    expect(refused.length).toBeLessThanOrEqual(MAX_FAILURES_PER_ACCOUNT);
    expect(codes.filter((code) => code === 429)).toHaveLength(
      30 - refused.length,
    );
    const blocked = await login(app, owner.email, owner.password, address);
    expect(blocked.statusCode).toBe(429);

    clock.advance(WINDOW_MS + 1000);
    const later = await login(app, owner.email, owner.password, address);
    expect(later.statusCode).toBe(200);
  });

  it("counts parallel attempts on unknown accounts per address", async () => {
    current = await testApp();
    const { app } = current;
    const address = "203.0.113.11";
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        login(app, `nobody${i}@dialwarden.test`, "wrong-password-1", address),
      ),
    );
    const refused = burst.filter((res) => res.statusCode === 401);
    expect(refused.length).toBeLessThanOrEqual(MAX_FAILURES_PER_ADDRESS);
    const limited = burst.filter((res) => res.statusCode === 429);
    expect(limited).toHaveLength(40 - refused.length);
  });

  // Threat test T5.3 (THE-2134 L1, code review M2): five wrong passwords from
  // one address do not lock the owner out from another one.
  it("does not lock the owner out from another address", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const wrong = "wrong-password-123";
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i += 1) {
      const res = await login(app, owner.email, wrong, "198.51.100.7");
      expect(res.statusCode).toBe(401);
    }
    const there = await login(app, owner.email, owner.password, "198.51.100.7");
    expect(there.statusCode).toBe(429);
    const here = await login(app, owner.email, owner.password, "198.51.100.8");
    expect(here.statusCode).toBe(200);
  });
});

describe("TOTP", () => {
  it("enrols, accepts each code and each recovery code once, and disables", async () => {
    const clock = manualClock();
    current = await testApp({ now: clock.now });
    const { app } = current;
    const owner = await setupOwner(app);
    const post = (url: string, payload: Record<string, string>) =>
      app.inject({ method: "POST", url, headers: headersOf(owner), payload });

    const badPassword = await post("/api/v1/auth/totp/enrol", {
      password: "not-the-password",
    });
    expect(badPassword.statusCode).toBe(401);
    const enrol = await post("/api/v1/auth/totp/enrol", {
      password: owner.password,
    });
    expect(enrol.statusCode).toBe(200);
    const { secret, otpauthUri } = enrol.json<{
      secret: string;
      otpauthUri: string;
    }>();
    expect(otpauthUri.startsWith("otpauth://totp/")).toBe(true);

    const valid = codeAt(secret, clock.now());
    const badCode = await post("/api/v1/auth/totp/enable", {
      code: otherCode(valid),
    });
    expect(badCode.statusCode).toBe(400);
    const enable = await post("/api/v1/auth/totp/enable", { code: valid });
    expect(enable.statusCode).toBe(200);
    const { recoveryCodes } = enable.json<{ recoveryCodes: string[] }>();
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
    }
    const stored = app.ctx.store.sqlite
      .prepare("SELECT code_hash AS hash FROM recovery_codes")
      .all() as { hash: string }[];
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(recoveryCodes).not.toContain(row.hash);
    }

    // The password alone no longer signs in, and the enabling code is used up.
    const first = await challengeOf(app, owner.email, owner.password);
    const replay = await secondFactor(app, first, { code: valid });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: "invalid_code" });

    clock.advance(30_000);
    const fresh = codeAt(secret, clock.now());
    const signedIn = await secondFactor(app, first, { code: fresh });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toMatchObject({ user: { totpEnabled: true } });
    expect(() => sessionCookie(signedIn)).not.toThrow();

    const second = await challengeOf(app, owner.email, owner.password);
    const reused = await secondFactor(app, second, { code: fresh });
    expect(reused.statusCode).toBe(401);

    const recovery = recoveryCodes[0] ?? "";
    const withRecovery = await secondFactor(app, second, {
      recoveryCode: recovery.toUpperCase(),
    });
    expect(withRecovery.statusCode).toBe(200);
    const third = await challengeOf(app, owner.email, owner.password);
    const usedUp = await secondFactor(app, third, { recoveryCode: recovery });
    expect(usedUp.statusCode).toBe(401);

    clock.advance(30_000);
    const disable = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/disable",
      headers: sessionHeaders(withRecovery),
      payload: {
        password: owner.password,
        code: codeAt(secret, clock.now()),
      },
    });
    expect(disable.statusCode).toBe(204);
    const plain = await login(app, owner.email, owner.password);
    expect(plain.json()).toMatchObject({ status: "ok" });
  });

  it("drops a challenge after five wrong codes and rate-limits the account", async () => {
    const clock = manualClock();
    current = await testApp({ now: clock.now });
    const { app } = current;
    const { owner, secret } = await ownerWithTotp(app, clock);
    clock.advance(30_000);
    const valid = codeAt(secret, clock.now());
    const wrong = { code: otherCode(valid) };
    const challenge = await challengeOf(app, owner.email, owner.password);
    for (let i = 0; i < 5; i += 1) {
      const res = await secondFactor(app, challenge, wrong);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_code" });
    }
    // The challenge is gone, so even the right code is refused now.
    const late = await secondFactor(app, challenge, { code: valid });
    expect(late.statusCode).toBe(401);
    expect(late.json()).toEqual({ error: "challenge_expired" });
    // Five failures also lock the account for the window.
    const again = await login(app, owner.email, owner.password);
    expect(again.statusCode).toBe(429);
  });
});

// Threat tests T6 (THE-2134 L2): turning TOTP on or off ends the other
// sessions, so a session stolen before stays no longer valid.
describe("TOTP changes end the other sessions", () => {
  it("on enable and on disable", async () => {
    const clock = manualClock();
    current = await testApp({ now: clock.now });
    const { app } = current;
    const owner = await setupOwner(app);
    const sessionStatus = (headers: Record<string, string>) =>
      app
        .inject({ method: "GET", url: "/api/v1/auth/session", headers })
        .then((res) => res.statusCode);

    const b = sessionHeaders(await login(app, owner.email, owner.password));
    const enrol = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/enrol",
      headers: headersOf(owner),
      payload: { password: owner.password },
    });
    const { secret } = enrol.json<{ secret: string }>();
    const enable = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/enable",
      headers: headersOf(owner),
      payload: { code: codeAt(secret, clock.now()) },
    });
    expect(enable.statusCode).toBe(200);
    expect(await sessionStatus(b)).toBe(401);
    expect(await sessionStatus(headersOf(owner))).toBe(200);

    clock.advance(30_000);
    const challenge = await challengeOf(app, owner.email, owner.password);
    const signedIn = await secondFactor(app, challenge, {
      code: codeAt(secret, clock.now()),
    });
    expect(signedIn.statusCode).toBe(200);
    const c = sessionHeaders(signedIn);
    clock.advance(30_000);
    const disable = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/disable",
      headers: headersOf(owner),
      payload: { password: owner.password, code: codeAt(secret, clock.now()) },
    });
    expect(disable.statusCode).toBe(204);
    expect(await sessionStatus(c)).toBe(401);
    expect(await sessionStatus(headersOf(owner))).toBe(200);
  });
});

describe("password change", () => {
  it("needs the current password and ends the other sessions", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const other = await login(app, owner.email, owner.password);
    const otherCookie = sessionCookie(other);
    const next = randomPassword();
    const change = (currentPassword: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/password",
        headers: headersOf(owner),
        payload: { currentPassword, newPassword: next },
      });

    expect((await change("not-the-password")).statusCode).toBe(401);
    expect((await change(owner.password)).statusCode).toBe(204);

    const session = (cookie: string) =>
      app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { cookie },
      });
    expect((await session(owner.cookie)).statusCode).toBe(200);
    expect((await session(otherCookie)).statusCode).toBe(401);
    expect((await login(app, owner.email, owner.password)).statusCode).toBe(
      401,
    );
    expect((await login(app, owner.email, next)).statusCode).toBe(200);
  });
});
