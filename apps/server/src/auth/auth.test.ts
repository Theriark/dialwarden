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
      payload: { email: "owner@dialwarden.test", password: "short-pw", name: "O" },
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
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/activity" });
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
    expect(right.json()).toMatchObject({ status: "ok", user: { role: "owner" } });
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

  it("drops a challenge after too many wrong codes", async () => {
    const clock = manualClock();
    current = await testApp({ now: clock.now });
    const { app } = current;
    const owner = await setupOwner(app);
    const enrol = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/enrol",
      headers: headersOf(owner),
      payload: { password: owner.password },
    });
    const { secret } = enrol.json<{ secret: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/enable",
      headers: headersOf(owner),
      payload: { code: codeAt(secret, clock.now()) },
    });
    clock.advance(30_000);
    const valid = codeAt(secret, clock.now());
    const challenge = await challengeOf(app, owner.email, owner.password);
    for (let i = 0; i < 4; i += 1) {
      const res = await secondFactor(app, challenge, { code: otherCode(valid) });
      expect(res.statusCode).toBe(401);
    }
    const fifth = await secondFactor(app, challenge, { code: otherCode(valid) });
    expect(fifth.statusCode).toBe(429);
    clock.advance(WINDOW_MS + 1000);
    const late = await secondFactor(app, challenge, { code: valid });
    expect(late.statusCode).toBe(401);
    expect(late.json()).toEqual({ error: "challenge_expired" });
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
