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
import { inviteAndAccept, paidApp, toFree } from "../../test/team.js";

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
    const admin = await inviteAndAccept(app, owner, "admin");
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
    const admin = await inviteAndAccept(app, owner, "admin");
    const editor = await inviteAndAccept(app, owner, "editor");
    const viewer = await inviteAndAccept(app, owner, "viewer");
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
    const admin = await inviteAndAccept(app, owner, "admin");
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
