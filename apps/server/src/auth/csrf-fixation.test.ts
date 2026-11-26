// Sessions and CSRF on the sign-in paths (p8-threat-specs S-01 to S-07):
// a new sign-in never keeps an old session, an invalid cookie counts as no
// session, cross-site content types never reach the handlers, a state change
// needs the CSRF token of the very session it rides on, the cookie carries
// the D17 attributes, account changes end every session, and no CORS header
// is ever sent.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  headersOf,
  ownerCredentials,
  setupHeaders,
  type SignedIn,
  type TestApp,
} from "../../test/helpers.js";
import {
  call,
  inviteAndAccept,
  paidApp,
  signIn,
  teamFixture,
  type TeamFixture,
} from "../../test/team.js";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function fixture(): Promise<TeamFixture> {
  const made = await teamFixture();
  current = made.current;
  return made;
}

/** The owner of an https app: its cookie is named with the __Host- prefix. */
async function httpsOwner(
  app: FastifyInstance,
): Promise<SignedIn & { email: string; password: string }> {
  const credentials = ownerCredentials();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    headers: setupHeaders(app),
    payload: { ...credentials, name: "Owner" },
  });
  if (response.statusCode !== 201) {
    throw new Error(`setup: ${response.statusCode} ${response.body}`);
  }
  const found = response.cookies.find(
    (cookie) => cookie.name === "__Host-dw_session",
  );
  if (found === undefined) {
    throw new Error("no __Host cookie in the setup response");
  }
  const body = response.json<{ csrfToken: string; user: { id: string } }>();
  return {
    ...credentials,
    cookie: `__Host-dw_session=${found.value}`,
    csrf: body.csrfToken,
    userId: body.user.id,
  };
}

/** The raw set-cookie header lines of a response, joined for scanning. */
const setCookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"] ?? []);

const LOGIN = "/api/v1/auth/login";

describe("sessions and CSRF on sign-in (S-01 to S-07)", () => {
  it("S-01 destroys the session a login rides on", async () => {
    const t = await fixture();
    const { app, owner } = t;
    // A session of the attacker (any other user) the victim's browser holds.
    const attacker = t.viewer;
    const response = await app.inject({
      method: "POST",
      url: LOGIN,
      headers: {
        cookie: attacker.cookie,
        "x-csrf-token": attacker.csrf,
      },
      payload: { email: owner.email, password: owner.password },
    });
    expect(response.statusCode).toBe(200);
    const fresh = setCookie(response);
    const gone = attacker.cookie.split("=")[1] ?? "";
    expect(fresh).not.toContain(gone);
    const old = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: attacker.cookie },
    });
    expect(old.statusCode).toBe(401);
  });

  it("S-02 lets an invalid cookie pass as no session", async () => {
    const t = await fixture();
    const { app, owner } = t;
    const forged = await app.inject({
      method: "POST",
      url: LOGIN,
      headers: { cookie: "dw_session=abc" },
      payload: { email: owner.email, password: owner.password },
    });
    expect(forged.statusCode).toBe(200);
    // A signed cookie of a session that was destroyed counts as no session
    // too, so the login needs no CSRF header.
    const thrown = await signIn(app, owner.email, owner.password);
    const gone = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: headersOf(thrown),
    });
    expect(gone.statusCode).toBe(204);
    const again = await app.inject({
      method: "POST",
      url: LOGIN,
      headers: { cookie: thrown.cookie },
      payload: { email: owner.email, password: owner.password },
    });
    expect(again.statusCode).toBe(200);
  });

  it("S-03 refuses cross-site content types on the sign-in routes", async () => {
    const t = await fixture();
    const { app, owner } = t;
    const form = "email=owner%40dialwarden.test&password=whatever-long";
    const asForm = await app.inject({
      method: "POST",
      url: LOGIN,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form,
    });
    expect(asForm.statusCode).toBe(415);
    expect(asForm.json()).toMatchObject({
      error: "fst_err_ctp_invalid_media_type",
    });
    expect(setCookie(asForm)).toBe("");
    const asText = await app.inject({
      method: "POST",
      url: LOGIN,
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({ email: owner.email, password: owner.password }),
    });
    expect(asText.statusCode).toBe(400);
    expect(setCookie(asText)).toBe("");
    for (const headers of [
      { "content-type": "application/x-www-form-urlencoded" },
      { "content-type": "text/plain" },
    ]) {
      const totp = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login/totp",
        headers,
        payload: "challenge=abc&code=123456",
      });
      expect(totp.statusCode).toBeGreaterThanOrEqual(400);
      expect(totp.statusCode).toBeLessThan(500);
      expect(setCookie(totp)).toBe("");
    }
  });

  it("S-04 checks the CSRF token of the acting session on role changes", async () => {
    const t = await fixture();
    const { app, owner, editor } = t;
    const roleUrl = `/api/v1/users/${editor.userId}/role`;
    const body = { role: "viewer" };
    const other = await signIn(app, owner.email, owner.password);
    const missing = await app.inject({
      method: "PUT",
      url: roleUrl,
      headers: { cookie: owner.cookie },
      payload: body,
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: "csrf" });
    const foreign = await app.inject({
      method: "PUT",
      url: roleUrl,
      headers: {
        cookie: owner.cookie,
        "x-csrf-token": other.csrf,
      },
      payload: body,
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ error: "csrf" });
    const read = await app.inject({
      method: "GET",
      url: `${roleUrl}?role=admin`,
      headers: { cookie: owner.cookie },
    });
    expect(read.statusCode).toBe(404);
    const grants = await app.inject({
      method: "PUT",
      url: `/api/v1/users/${editor.userId}/grants`,
      headers: { cookie: owner.cookie },
      payload: { servers: [] },
    });
    expect(grants.statusCode).toBe(403);
    expect(grants.json()).toEqual({ error: "csrf" });
    const stored = app.ctx.store.sqlite
      .prepare('SELECT role AS value FROM "users" WHERE id = ?')
      .get(editor.userId) as { value: string };
    expect(stored.value).toBe("editor");
  });

  it("S-05 sets the D17 cookie attributes on every sign-in", async () => {
    current = await paidApp({
      extraEnv: { BASE_URL: "https://dw.example" },
    });
    const app = current.app;
    const owner = await httpsOwner(app);
    expect(owner.cookie).toContain("__Host-dw_session=");
    // A login sets the same cookie shape as the setup did.
    const login = await app.inject({
      method: "POST",
      url: LOGIN,
      payload: { email: owner.email, password: owner.password },
    });
    expect(login.statusCode).toBe(200);
    const attributes = [
      "__Host-dw_session=",
      "HttpOnly",
      "SameSite=Strict",
      "Secure",
      "Path=/",
    ];
    for (const attribute of attributes) {
      expect(setCookie(login)).toContain(attribute);
    }
    // An invitation accept sets the same cookie shape.
    const invite = await call(app, owner, "POST", "/api/v1/invitations", {
      email: "s05@dialwarden.test",
      role: "viewer",
    });
    expect(invite.statusCode).toBe(201);
    const token = invite.json<{ token: string }>().token;
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: {
        token,
        name: "s05",
        password: "s05-password-135790",
      },
    });
    expect(accepted.statusCode).toBe(201);
    for (const attribute of attributes) {
      expect(setCookie(accepted)).toContain(attribute);
    }
    // A reset-link use signs the user in with the same cookie shape.
    const userId = accepted.json<{ user: { id: string } }>().user.id;
    const reset = await call(
      app,
      owner,
      "POST",
      `/api/v1/users/${userId}/password-reset`,
    );
    expect(reset.statusCode).toBe(201);
    const used = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: {
        token: reset.json<{ token: string }>().token,
        password: "s05-password-246810",
      },
    });
    expect(used.statusCode).toBe(200);
    for (const attribute of attributes) {
      expect(setCookie(used)).toContain(attribute);
    }
  });

  it("S-05b names the plain cookie without https", async () => {
    const t = await fixture();
    const { app, owner } = t;
    const response = await app.inject({
      method: "POST",
      url: LOGIN,
      payload: { email: owner.email, password: owner.password },
    });
    expect(setCookie(response)).toContain("dw_session=");
    expect(setCookie(response)).not.toContain("__Host-");
    expect(setCookie(response)).not.toContain("Secure");
  });

  it("S-06 ends every session when the account changes", async () => {
    const t = await fixture();
    const { app, owner } = t;
    // A password-reset use ends every earlier session of the user.
    const member = await inviteAndAccept(app, owner, "editor");
    const second = await signIn(app, member.email, member.password);
    const reset = await call(
      app,
      owner,
      "POST",
      `/api/v1/users/${member.userId}/password-reset`,
    );
    expect(reset.statusCode).toBe(201);
    const used = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: {
        token: reset.json<{ token: string }>().token,
        password: "s06-password-135790",
      },
    });
    expect(used.statusCode).toBe(200);
    for (const session of [member, second]) {
      const response = await call(app, session, "GET", "/api/v1/auth/session");
      expect(response.statusCode).toBe(401);
    }
    // Anonymising and deleting end the sessions too.
    const anonymised = await inviteAndAccept(app, owner, "viewer");
    expect(
      (
        await call(
          app,
          owner,
          "POST",
          `/api/v1/users/${anonymised.userId}/anonymise`,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call(app, anonymised, "GET", "/api/v1/auth/session")).statusCode,
    ).toBe(401);
    const deleted = await inviteAndAccept(app, owner, "viewer");
    expect(
      (await call(app, owner, "DELETE", `/api/v1/users/${deleted.userId}`))
        .statusCode,
    ).toBe(204);
    expect(
      (await call(app, deleted, "GET", "/api/v1/auth/session")).statusCode,
    ).toBe(401);
  });

  // P10-A G5.4: driven by the route list, so a new state-changing route
  // cannot skip the check.
  it("G5.4 refuses every non-GET API route with a session and no CSRF header", async () => {
    const t = await fixture();
    const { app, owner, servers } = t;
    const routes = app.ctx.routes.filter(
      (route) =>
        route.url.startsWith("/api/v1/") &&
        !["GET", "HEAD", "OPTIONS"].includes(route.method),
    );
    expect(routes.length).toBeGreaterThan(40);
    const answers = new Map<string, string>();
    for (const route of routes) {
      const url = route.url
        .replace(":slug", servers.a)
        .replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");
      const response = await app.inject({
        method: route.method as "POST",
        url,
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        payload: "{}",
      });
      answers.set(
        `${route.method} ${route.url}`,
        `${String(response.statusCode)} ${response.body}`,
      );
    }
    const wrong = [...answers].filter(
      ([, answer]) => answer !== '403 {"error":"csrf"}',
    );
    expect(wrong).toEqual([]);
    const session = await call(app, owner, "GET", "/api/v1/auth/session");
    expect(session.statusCode).toBe(200);
  });

  it("S-07 answers no CORS header", async () => {
    const t = await fixture();
    const { app, editor } = t;
    const response = await app.inject({
      method: "OPTIONS",
      url: `/api/v1/users/${editor.userId}/role`,
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "PUT",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
