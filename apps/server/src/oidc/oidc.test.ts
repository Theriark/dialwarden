// OIDC sign-in against a fake identity provider in the test process (P8-S
// threat specs O-01 to O-23 and O-27 to O-31). The fake provider can forge
// any token, so every refusal is proven with a real exchange. The test-only
// seam BuildOptions.oidcNetwork lets the client reach 127.0.0.1 over http;
// the real network policy is tested in discovery-ssrf.test.ts.
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "../db/schema.js";
import {
  headersOf,
  randomPassword,
  sessionCookie,
  setupOwner,
  type SignedIn,
  type TestApp,
} from "../../test/helpers.js";
import { FakeIdp, type IssueOptions } from "../../test/oidc-idp.js";
import { MAX_PER_ADDRESS, signInNetwork } from "./service.js";
import {
  invite,
  inviteAndAccept,
  paidApp,
  testEmail,
  toFree,
  toPaid,
  type Member,
} from "../../test/team.js";

const BASE_URL = "http://dw.test";
const MAPPING = {
  "dw-admins": "admin",
  "dw-editors": "editor",
  "dw-viewers": "viewer",
};

let current: TestApp;
let app: FastifyInstance;
let idp: FakeIdp;
let owner: SignedIn & { email: string; password: string };
let clock = Date.now();

async function configure(
  body: Record<string, unknown> = {},
  who: SignedIn = owner,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "PUT",
    url: "/api/v1/settings/oidc",
    headers: headersOf(who),
    payload: {
      enabled: true,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      roleMapping: MAPPING,
      allowPrivateNetwork: false,
      ...body,
    },
  });
}

interface Started {
  location: URL;
  state: string;
  cookie: string;
}

async function start(returnTo = "/servers"): Promise<Started> {
  const query = new URLSearchParams({ returnTo }).toString();
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/start?${query}`,
  });
  expect(response.statusCode, response.body).toBe(302);
  const location = new URL(String(response.headers.location));
  const found = response.cookies.find((cookie) => cookie.name === "dw_oidc");
  if (found === undefined) throw new Error("no transaction cookie");
  return {
    location,
    state: location.searchParams.get("state") ?? "",
    cookie: `dw_oidc=${found.value}`,
  };
}

function callback(
  query: Record<string, string>,
  cookie: string | null,
  extra: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const search = new URLSearchParams(query).toString();
  const headers: Record<string, string> = { ...extra };
  if (cookie !== null) {
    headers.cookie =
      extra.cookie === undefined ? cookie : `${cookie}; ${extra.cookie}`;
  }
  return app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/callback?${search}`,
    headers,
  });
}

/** A whole sign-in with the token the options describe. */
async function signIn(
  options: IssueOptions = {},
  extra: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const started = await start();
  const code = idp.code(started.location, options);
  return callback({ code, state: started.state }, started.cookie, extra);
}

function userCount(): number {
  return app.ctx.store.db.select().from(users).all().length;
}

function sessionOf(response: LightMyRequestResponse): string {
  return sessionCookie(response);
}

/** A local member: invitations work only while OIDC is off (L1). */
async function member(role: string): Promise<Member> {
  expect((await configure({ enabled: false })).statusCode).toBe(200);
  const made = await inviteAndAccept(app, owner, role);
  const again = await configure();
  expect(again.statusCode, again.body).toBe(200);
  return made;
}

beforeEach(async () => {
  clock = Date.now();
  idp = await new FakeIdp().start();
  current = await paidApp({
    extraEnv: { BASE_URL },
    oidcNetwork: { allowLoopback: true, allowHttp: true },
    now: () => new Date(clock),
  });
  app = current.app;
  owner = await setupOwner(app);
  const saved = await configure();
  expect(saved.statusCode, saved.body).toBe(200);
});

afterEach(async () => {
  await current.close();
  await idp.stop();
});

describe("OIDC sign-in, the happy path", () => {
  it("signs a mapped user in with a fresh session and returns to the page", async () => {
    const response = await signIn();
    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBe("/servers");
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: sessionOf(response) },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json<{ user: { role: string } }>().user.role).toBe("editor");
  });

  it("O-07 sends S256 PKCE and the provider sees the matching verifier", async () => {
    const started = await start();
    expect(started.location.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(started.location.searchParams.get("nonce")).not.toBeNull();
    const code = idp.code(started.location);
    const response = await callback(
      { code, state: started.state },
      started.cookie,
    );
    expect(response.statusCode, response.body).toBe(302);
  });

  it("O-23 builds redirect_uri from BASE_URL, never from the Host header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/start",
      headers: { host: "evil.example" },
    });
    const location = new URL(String(response.headers.location));
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/api/v1/auth/oidc/callback`,
    );
  });
});

describe("OIDC state and transaction (O-01 to O-05)", () => {
  it("O-01 refuses a callback without state", async () => {
    const started = await start();
    const code = idp.code(started.location);
    const response = await callback({ code }, started.cookie);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "oidc_state_invalid" });
    expect(response.cookies.find((c) => c.name === "dw_session")).toBe(
      undefined,
    );
  });

  it("O-02 refuses the state of another browser", async () => {
    const browserA = await start();
    const browserB = await start();
    const code = idp.code(browserB.location);
    const response = await callback(
      { code, state: browserB.state },
      browserA.cookie,
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "oidc_state_invalid" });
  });

  it("O-03 refuses a valid state without the transaction cookie", async () => {
    const started = await start();
    const code = idp.code(started.location);
    const response = await callback({ code, state: started.state }, null);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "oidc_state_invalid" });
  });

  it("O-04 refuses a replayed callback; one token request only", async () => {
    const started = await start();
    const code = idp.code(started.location);
    const query = { code, state: started.state };
    const first = await callback(query, started.cookie);
    expect(first.statusCode).toBe(302);
    const second = await callback(query, started.cookie);
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ error: "oidc_state_invalid" });
    expect(idp.tokenRequests).toBe(1);
  });

  it("O-05 refuses a sign-in started 11 minutes ago", async () => {
    const started = await start();
    const code = idp.code(started.location);
    clock += 11 * 60 * 1000;
    const response = await callback(
      { code, state: started.state },
      started.cookie,
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "oidc_state_invalid" });
  });
});

describe("OIDC token checks (O-06 to O-15)", () => {
  const refused = async (options: IssueOptions) => {
    const response = await signIn(options);
    expect(response.statusCode, JSON.stringify(options)).toBe(401);
    expect(response.json()).toMatchObject({ error: "oidc_token_invalid" });
    expect(response.cookies.find((c) => c.name === "dw_session")).toBe(
      undefined,
    );
  };

  it("O-06 refuses a missing or another nonce", async () => {
    await refused({ claims: { nonce: undefined } });
    await refused({ claims: { nonce: "another-nonce" } });
  });

  it("O-07 fails when the provider refuses the verifier", async () => {
    const started = await start();
    const code = idp.code(started.location);
    // The provider sees another challenge than the one this flow made.
    const forged = new URL(started.location);
    forged.searchParams.set("code_challenge", "not-the-challenge");
    const other = idp.code(forged);
    const response = await callback(
      { code: other, state: started.state },
      started.cookie,
    );
    expect(code).not.toBe(other);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "oidc_token_invalid" });
  });

  it("O-09 refuses another iss claim", async () => {
    await refused({ claims: { iss: "https://other.example" } });
  });

  it("O-10 refuses another audience, and several without our azp", async () => {
    await refused({ claims: { aud: "other-client" } });
    await refused({
      claims: { aud: ["dialwarden", "other"], azp: "other" },
    });
  });

  it("O-11 refuses an expired token and an iat far in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    await refused({ claims: { exp: now - 120 } });
    await refused({ claims: { iat: now + 600 } });
  });

  it("O-12 refuses alg none", async () => {
    await refused({ signing: "none" });
  });

  it("O-13 refuses HS256 key confusion and HS256 with the client secret", async () => {
    await refused({ signing: "hs256-public-key" });
    await refused({ signing: "hs256-client-secret" });
  });

  it("O-14 ignores keys named in the token header", async () => {
    await refused({ signing: "header-key" });
    expect(idp.attackerRequests).toBe(0);
  });

  it("O-15 refuses a signature by an unknown key", async () => {
    await refused({ signing: "unknown-key" });
  });
});

describe("OIDC roles and accounts (O-16 to O-21)", () => {
  it("O-16 and O-17 refuse no groups and unknown groups", async () => {
    const before = userCount();
    for (const groups of [undefined, ["nobody"]]) {
      const response = await signIn({ claims: { groups } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "oidc_no_role" });
    }
    expect(userCount()).toBe(before);
  });

  it("O-18 refuses a mapping to owner, and ignores one stored anyway", async () => {
    const response = await configure({ roleMapping: { "dw-owners": "owner" } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: "invalid_role_mapping" });
    const stored = app.ctx.settings.get("oidc.settings") as object;
    app.ctx.settings.set("oidc.settings", {
      ...stored,
      roleMapping: { "dw-owners": "owner" },
    });
    const login = await signIn({ claims: { groups: ["dw-owners"] } });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ error: "oidc_no_role" });
    const owners = app.ctx.store.db
      .select()
      .from(users)
      .all()
      .filter((row) => row.role === "owner");
    expect(owners).toHaveLength(1);
  });

  it("O-19 maps the highest group, follows changes, and ends sessions", async () => {
    const first = await signIn({
      claims: { groups: ["dw-viewers", "dw-admins"] },
    });
    expect(first.statusCode).toBe(302);
    const cookie = sessionOf(first);
    const row = () =>
      app.ctx.store.db
        .select()
        .from(users)
        .all()
        .find((item) => item.oidcSubject === "sso-user-1");
    expect(row()?.role).toBe("admin");
    const second = await signIn({ claims: { groups: ["dw-viewers"] } });
    expect(second.statusCode).toBe(302);
    expect(row()?.role).toBe("viewer");
    const third = await signIn({ claims: { groups: ["other"] } });
    expect(third.statusCode).toBe(403);
    for (const old of [cookie, sessionOf(second)]) {
      const session = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { cookie: old },
      });
      expect(session.statusCode).toBe(401);
    }
  });

  it("O-20 never links a new identity to a local account by e-mail", async () => {
    const admin = await member("admin");
    for (const email of [owner.email, admin.email]) {
      const response = await signIn({
        claims: { sub: `new-${email}`, email, email_verified: true },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "oidc_email_conflict" });
      expect(response.cookies.find((c) => c.name === "dw_session")).toBe(
        undefined,
      );
    }
  });

  it("O-21 keys the identity on issuer plus subject", async () => {
    const first = await signIn();
    expect(first.statusCode).toBe(302);
    // A second provider with the same subject is another identity: the
    // e-mail is taken by the first account, so it gets the conflict.
    const other = await new FakeIdp().start();
    try {
      const previous = idp;
      idp = other;
      expect((await configure()).statusCode).toBe(200);
      const response = await signIn();
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "oidc_email_conflict" });
      idp = previous;
    } finally {
      await other.stop();
    }
  });
});

describe("OIDC redirects, settings and plans", () => {
  it("O-22 returns only to a path on this site", async () => {
    const attempts = [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/%2F%2Fevil.example",
      "javascript:alert(1)",
      "/%0d%0aSet-Cookie:x",
    ];
    for (const returnTo of attempts) {
      const started = await start(returnTo);
      const code = idp.code(started.location);
      const response = await callback(
        { code, state: started.state, returnTo: "https://evil.example" },
        started.cookie,
      );
      expect(response.statusCode, returnTo).toBe(302);
      expect(response.headers.location, returnTo).toBe("/");
    }
  });

  it("O-08 refuses an issuer the discovery document does not name", async () => {
    idp.discoveryOverride = { issuer: "https://other.example" };
    const response = await configure({ clientSecret: undefined });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: "oidc_issuer_mismatch" });
  });

  it("O-27 only the owner configures OIDC; the secret is never shown", async () => {
    const admin = await member("admin");
    const editor = await member("editor");
    const viewer = await member("viewer");
    for (const who of [admin, editor, viewer]) {
      const response = await configure({}, who);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "forbidden" });
    }
    const view = await app.inject({
      method: "GET",
      url: "/api/v1/settings/oidc",
      headers: headersOf(owner),
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ hasClientSecret: true });
    expect(view.body).not.toContain(idp.clientSecret);
    const stored = JSON.stringify(app.ctx.settings.get("oidc.settings"));
    expect(stored).not.toContain(idp.clientSecret);
  });

  it("O-28 keeps the owner's local login; others need SSO", async () => {
    const admin = await member("admin");
    const login = (email: string, password: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password },
      });
    expect((await login(owner.email, owner.password)).statusCode).toBe(200);
    for (const [email, password] of [
      [admin.email, admin.password],
      ["nobody@dialwarden.test", randomPassword()],
    ] as const) {
      const response = await login(email, password);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "sso_required" });
      expect(response.cookies.find((c) => c.name === "dw_session")).toBe(
        undefined,
      );
    }
  });

  it("O-29 an OIDC account has no usable password", async () => {
    const response = await signIn();
    expect(response.statusCode).toBe(302);
    await configure({ enabled: false });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "sso-user@dialwarden.test", password: "anything-12" },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json()).toMatchObject({ error: "invalid_credentials" });
  });

  it("O-30 answers the C1 402 on Free; the owner still signs in", async () => {
    await toFree(app, owner);
    const body = { error: "payment_required", plan: "free", feature: "oidc" };
    const startFree = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/start",
    });
    expect(startFree.statusCode).toBe(402);
    expect(startFree.json()).toEqual(body);
    const back = await callback({ code: "x", state: "y" }, null);
    expect(back.statusCode).toBe(402);
    expect(back.json()).toEqual(body);
    const put = await configure();
    expect(put.statusCode).toBe(402);
    expect(put.json()).toEqual(body);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: owner.email, password: owner.password },
    });
    expect(login.statusCode).toBe(200);
  });

  it("O-31 a callback never keeps another user's session", async () => {
    const response = await signIn({}, { cookie: owner.cookie });
    expect(response.statusCode).toBe(302);
    expect(sessionOf(response)).not.toBe(owner.cookie);
    const old = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: owner.cookie },
    });
    expect(old.statusCode).toBe(401);
  });
});

describe("OIDC plans, local paths and limits (review of PR 29)", () => {
  const loginOf = (who: Member) =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: who.email, password: who.password },
    });
  const loginFlag = async () => {
    const answer = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc",
    });
    return answer.json<{ enabled: boolean }>().enabled;
  };
  const noSession = (response: LightMyRequestResponse) =>
    response.cookies.find((c) => c.name === "dw_session");

  it("F-04 lifts sso_required for a non-owner on Free and restores it on Paid", async () => {
    const admin = await member("admin");
    const before = await loginOf(admin);
    expect(before.statusCode).toBe(403);
    expect(before.json()).toMatchObject({ error: "sso_required" });
    expect(await loginFlag()).toBe(true);
    await toFree(app, owner);
    const free = await loginOf(admin);
    expect(free.statusCode, free.body).toBe(200);
    expect(await loginFlag()).toBe(false);
    await toPaid(app, owner);
    const paid = await loginOf(admin);
    expect(paid.statusCode).toBe(403);
    expect(paid.json()).toMatchObject({ error: "sso_required" });
    expect(await loginFlag()).toBe(true);
  });

  it("L1 makes and accepts no invitation while OIDC is on", async () => {
    const email = testEmail("late");
    const made = await invite(app, owner, { email, role: "viewer" });
    expect(made.statusCode).toBe(409);
    expect(made.json()).toMatchObject({ error: "oidc_active" });
    expect((await configure({ enabled: false })).statusCode).toBe(200);
    const open = await invite(app, owner, { email, role: "viewer" });
    expect(open.statusCode).toBe(201);
    const token = open.json<{ token: string }>().token;
    expect((await configure()).statusCode).toBe(200);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token, name: "Late", password: randomPassword() },
    });
    expect(accepted.statusCode).toBe(403);
    expect(accepted.json()).toMatchObject({ error: "sso_required" });
    expect(noSession(accepted)).toBe(undefined);
  });

  it("L1 a reset use while OIDC is on sets the password without a session", async () => {
    const admin = await member("admin");
    const made = await app.inject({
      method: "POST",
      url: `/api/v1/users/${admin.userId}/password-reset`,
      headers: headersOf(owner),
    });
    expect(made.statusCode, made.body).toBe(201);
    const token = made.json<{ token: string }>().token;
    const password = randomPassword();
    const used = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token, password },
    });
    expect(used.statusCode, used.body).toBe(204);
    expect(noSession(used)).toBe(undefined);
    const login = await loginOf({ ...admin, password });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ error: "sso_required" });
  });

  it("F7 lets the owner switch OIDC off while the provider is down", async () => {
    idp.discoveryOverride = { issuer: "https://other.example" };
    expect((await configure()).statusCode).toBe(422);
    const off = await configure({ enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, configured: true });
    expect(await loginFlag()).toBe(false);
  });

  it("L6 refuses a malformed or non-https authorization endpoint", async () => {
    for (const value of ["not a url", "ftp://idp.example/authorize"]) {
      idp.discoveryOverride = { authorization_endpoint: value };
      const response = await configure();
      expect(response.statusCode, value).toBe(422);
      expect(response.json(), value).toMatchObject({
        error: "oidc_url_refused",
      });
    }
  });

  it("L8 an empty client secret clears the stored one", async () => {
    const cleared = await configure({ clientSecret: "" });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ hasClientSecret: false });
    const kept = await configure({ clientSecret: undefined });
    expect(kept.json()).toMatchObject({ hasClientSecret: false });
  });

  it("L5 a flood of start requests ends no other address's sign-in", async () => {
    const started = await start();
    const flood: LightMyRequestResponse[] = [];
    for (let n = 0; n < MAX_PER_ADDRESS + 5; n += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oidc/start",
        remoteAddress: "203.0.113.9",
      });
      expect(response.statusCode).toBe(302);
      flood.push(response);
    }
    const code = idp.code(started.location);
    const done = await callback({ code, state: started.state }, started.cookie);
    expect(done.statusCode, done.body).toBe(302);
    // The flooding address lost its own oldest sign-ins.
    const first = flood[0];
    if (first === undefined) throw new Error("no flood response");
    const location = new URL(String(first.headers.location));
    const cookie = first.cookies.find((item) => item.name === "dw_oidc");
    const state = location.searchParams.get("state") ?? "";
    const stale = await callback(
      { code: idp.code(location), state },
      `dw_oidc=${cookie?.value ?? ""}`,
    );
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: "oidc_state_invalid" });
  });

  /** A start from one address: the response, its state and its cookie. */
  const startFrom = async (remoteAddress: string): Promise<Started> => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/start",
      remoteAddress,
    });
    expect(response.statusCode, remoteAddress).toBe(302);
    const location = new URL(String(response.headers.location));
    const found = response.cookies.find((item) => item.name === "dw_oidc");
    return {
      location,
      state: location.searchParams.get("state") ?? "",
      cookie: `dw_oidc=${found?.value ?? ""}`,
    };
  };
  const finish = (started: Started) =>
    callback(
      { code: idp.code(started.location), state: started.state },
      started.cookie,
    );

  it("L5 keeps exactly MAX_PER_ADDRESS open sign-ins per address", async () => {
    const flood: Started[] = [];
    for (let n = 0; n < MAX_PER_ADDRESS; n += 1) {
      flood.push(await startFrom("203.0.113.9"));
    }
    const first = flood[0];
    const second = flood[1];
    if (first === undefined || second === undefined) throw new Error("none");
    // One more start drops the oldest only.
    await startFrom("203.0.113.9");
    const stale = await finish(first);
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: "oidc_state_invalid" });
    const kept = await finish(second);
    expect(kept.statusCode, kept.body).toBe(302);
  });

  it("B1 counts an IPv6 client by its /48, so one /64 cannot fill the store", async () => {
    const started = await start();
    // 150 addresses over many /64s of one /48: more than the store holds
    // when every address counted alone.
    const flood: Started[] = [];
    for (let n = 1; n <= 150; n += 1) {
      const address = `2001:db8:abcd:${n.toString(16)}::${n.toString(16)}`;
      flood.push(await startFrom(address));
    }
    // Only the last MAX_PER_ADDRESS of the /48 are kept.
    const oldest = flood[0];
    const newest = flood.at(-1);
    if (oldest === undefined || newest === undefined) throw new Error("none");
    const stale = await finish(oldest);
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: "oidc_state_invalid" });
    // A sign-in of another network, started before and after, completes.
    const done = await finish(started);
    expect(done.statusCode, done.body).toBe(302);
    const later = await finish(await startFrom("2001:db8:beef::1"));
    expect(later.statusCode, later.body).toBe(302);
    const last = await finish(newest);
    expect(last.statusCode, last.body).toBe(302);
  });

  it("B1 names the network a start counts against", () => {
    expect(signInNetwork("2001:db8:abcd:12:3456::9")).toBe("2001:db8:abcd::");
    expect(signInNetwork("2001:db8:abcd:ffff::1")).toBe("2001:db8:abcd::");
    expect(signInNetwork("2001:db8:abce::1")).toBe("2001:db8:abce::");
    expect(signInNetwork("203.0.113.9")).toBe("203.0.113.9");
    expect(signInNetwork("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
    expect(signInNetwork("fe80::1%eth0")).toBe("fe80::");
  });

  /** An OIDC admin with an API token and a reset link it made for an editor. */
  const ssoAdminWithLinks = async () => {
    const editor = await member("editor");
    const first = await signIn({ claims: { groups: ["dw-admins"] } });
    expect(first.statusCode, first.body).toBe(302);
    const cookie = sessionOf(first);
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie },
    });
    const body = session.json<{ csrfToken: string; user: { id: string } }>();
    const admin = { cookie, csrf: body.csrfToken, userId: body.user.id };
    const made = await app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: headersOf(admin),
      payload: { name: "sso-ci", role: "viewer" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const link = await app.inject({
      method: "POST",
      url: `/api/v1/users/${editor.userId}/password-reset`,
      headers: headersOf(admin),
    });
    expect(link.statusCode, link.body).toBe(201);
    return {
      apiToken: made.json<{ token: string }>().token,
      resetToken: link.json<{ token: string }>().token,
    };
  };
  const useReset = (token: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token, password: randomPassword() },
    });

  it("L2 and N1 a refused sign-in ends the tokens and reset links of the account", async () => {
    const { apiToken, resetToken } = await ssoAdminWithLinks();
    const refused = await signIn({ claims: { groups: ["other"] } });
    expect(refused.statusCode).toBe(403);
    const call = await app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: { authorization: `Bearer ${apiToken}` },
    });
    expect(call.statusCode).toBe(401);
    const used = await useReset(resetToken);
    expect(used.statusCode).toBe(410);
    expect(used.json()).toEqual({ error: "reset_invalid" });
  });

  it("N1 a role change by the group mapping ends the reset links it made", async () => {
    const { resetToken } = await ssoAdminWithLinks();
    const lower = await signIn({ claims: { groups: ["dw-viewers"] } });
    expect(lower.statusCode).toBe(302);
    const used = await useReset(resetToken);
    expect(used.statusCode).toBe(410);
    expect(used.json()).toEqual({ error: "reset_invalid" });
  });

  it("L6 keeps an unverified e-mail claim out of the account", async () => {
    const response = await signIn({
      claims: {
        sub: "unverified-1",
        email: "colleague@dialwarden.test",
        email_verified: false,
      },
    });
    expect(response.statusCode, response.body).toBe(302);
    const row = app.ctx.store.db
      .select()
      .from(users)
      .all()
      .find((item) => item.oidcSubject === "unverified-1");
    expect(row?.email).toMatch(/@sso\.invalid$/);
  });
});

describe("OIDC with BASE_URL unset (O-23)", () => {
  it("refuses the settings with 409 base_url_required", async () => {
    const plain = await paidApp({
      oidcNetwork: { allowLoopback: true, allowHttp: true },
    });
    try {
      const first = await setupOwner(plain.app);
      const response = await plain.app.inject({
        method: "PUT",
        url: "/api/v1/settings/oidc",
        headers: headersOf(first),
        payload: {
          enabled: true,
          issuer: idp.issuer,
          clientId: idp.clientId,
          roleMapping: MAPPING,
          allowPrivateNetwork: false,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "base_url_required" });
    } finally {
      await plain.close();
    }
  });
});
