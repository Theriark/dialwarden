// API tokens (dev-work-plan P8-A step 6; p8-threat-specs T-01 to T-13): the
// value is shown once and only its hash is stored, a token acts with a role
// no higher than its creator's (now, not only when it was made), it never
// reaches an identity route (D15), a bad, revoked or erased token answers
// 401, and on the Free fallback tokens stop and come back after a switch to
// Paid. The tests share one fixture and run in order.
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokens, auditEvents } from "../db/schema.js";
import type { RouteInfo } from "../http/context.js";
import { tokenAllowed } from "../http/guard.js";
import { setupOwner, type SignedIn } from "../../test/helpers.js";
import {
  call,
  INT_SETTING,
  inviteAndAccept,
  paidApp,
  teamFixture,
  toFree,
  toPaid,
  type TeamFixture,
} from "../../test/team.js";
import {
  MAX_TOKENS_PER_USER,
  TOKEN_PREFIX,
  TOKEN_VALUE,
} from "./api-access.js";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

let fixture: TeamFixture;

beforeAll(async () => {
  fixture = await teamFixture();
});

afterAll(async () => {
  await fixture.current.close();
});

interface MadeToken {
  id: string;
  token: string;
  prefix: string;
  role: string;
}

/** POST /api/v1/tokens with a session; the whole response. */
function create(
  user: SignedIn,
  role: string,
  name = role,
): Promise<LightMyRequestResponse> {
  return call(fixture.app, user, "POST", "/api/v1/tokens", { name, role });
}

async function makeToken(user: SignedIn, role: string): Promise<MadeToken> {
  const response = await create(user, role);
  if (response.statusCode !== 201) {
    throw new Error(`token: ${response.statusCode} ${response.body}`);
  }
  return response.json<MadeToken>();
}

/** A request with only the Authorization header (no cookie, no CSRF). */
function bearer(
  token: string,
  method: Method,
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> {
  const headers = { authorization: `Bearer ${token}` };
  if (payload === undefined) {
    return fixture.app.inject({ method, url, headers });
  }
  return fixture.app.inject({ method, url, headers, payload });
}

const editsOf = (value: number) => ({
  edits: [{ settingKey: INT_SETTING, value }],
});

const changeSetsOf = (slug: string) => `/api/v1/servers/${slug}/change-sets`;

const tokenUrl = (id: string) => `/api/v1/tokens/${id}`;

/** An API route no token may call. */
const deniedRoute = (route: RouteInfo): boolean =>
  route.url.startsWith("/api/v1/") &&
  route.method !== "HEAD" &&
  !tokenAllowed(route.url, route.tokens);

describe("API tokens", () => {
  it("T-02 stores the token in no text column of any table", async () => {
    const made = await makeToken(fixture.owner, "viewer");
    const sqlite = fixture.app.ctx.store.sqlite;
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(5);
    for (const { name } of tables) {
      const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows), name).not.toContain(made.token);
      expect(JSON.stringify(rows), name).not.toContain(
        made.token.slice(TOKEN_PREFIX.length),
      );
    }
  });
  it("shows the value once and stores only its SHA-256", async () => {
    const response = await create(fixture.owner, "admin", "ci");
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const made = response.json<MadeToken>();
    expect(made.token).toMatch(TOKEN_VALUE);
    expect(made.prefix).toBe(made.token.slice(0, 9));
    const { app, owner } = fixture;
    const list = await call(app, owner, "GET", "/api/v1/tokens");
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(made.token);
    expect(list.json<{ items: MadeToken[] }>().items).toEqual([
      expect.objectContaining({ id: made.id, role: "admin", lastUsedAt: null }),
    ]);
    const rows = fixture.app.ctx.store.db.select().from(apiTokens).all();
    expect(JSON.stringify(rows)).not.toContain(made.token);
    const hash = createHash("sha256").update(made.token).digest("hex");
    expect(rows.map((row) => row.tokenHash)).toContain(hash);
  });

  it("refuses a role above the creator's", async () => {
    const { editor, viewer, owner } = fixture;
    const tooHigh = await create(editor, "admin");
    expect(tooHigh.statusCode).toBe(403);
    expect(tooHigh.json()).toMatchObject({ error: "role_too_high" });
    expect((await create(viewer, "editor")).statusCode).toBe(403);
    expect((await create(owner, "owner")).statusCode).toBe(400);
    expect((await create(viewer, "viewer")).statusCode).toBe(201);
  });

  it("acts with the token's role on the creator's grants", async () => {
    const { servers } = fixture;
    const reader = await makeToken(fixture.editor, "viewer");
    const writer = await makeToken(fixture.editor, "editor");
    const settings = `/api/v1/servers/${servers.a}/settings`;
    expect((await bearer(reader.token, "GET", settings)).statusCode).toBe(200);
    const refused = await bearer(
      reader.token,
      "POST",
      changeSetsOf(servers.a),
      editsOf(11),
    );
    expect(refused.statusCode).toBe(403);
    // No cookie and no CSRF header: a bearer token is not ambient.
    const made = await bearer(
      writer.token,
      "POST",
      changeSetsOf(servers.a),
      editsOf(12),
    );
    expect(made.statusCode).toBe(201);
    const ungranted = await bearer(
      writer.token,
      "POST",
      changeSetsOf(servers.b),
      editsOf(13),
    );
    expect(ungranted.statusCode).toBe(404);
    expect(ungranted.json()).toMatchObject({ error: "server_not_found" });
  });

  it("cannot reach an owner route with an admin token", async () => {
    const admin = await makeToken(fixture.owner, "admin");
    const response = await bearer(admin.token, "POST", "/api/v1/servers", {});
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "forbidden" });
    const audit = await bearer(admin.token, "GET", "/api/v1/audit");
    expect(audit.statusCode).toBe(200);
  });

  it("never reaches an identity route (D15)", async () => {
    const admin = await makeToken(fixture.owner, "admin");
    const denied = fixture.app.ctx.routes.filter(deniedRoute);
    const urls = denied.map((route) => `${route.method} ${route.url}`);
    expect(urls).toEqual(
      expect.arrayContaining([
        "GET /api/v1/auth/session",
        "POST /api/v1/auth/password",
        "POST /api/v1/tokens",
        "DELETE /api/v1/tokens/:id",
        "GET /api/v1/users",
        "POST /api/v1/invitations",
        "GET /api/v1/me/export",
        "PUT /api/v1/licence",
      ]),
    );
    for (const route of denied) {
      const url = route.url
        .replace(":id", randomUUID())
        .replace(":slug", fixture.servers.a);
      const method = route.method as Method;
      const payload = method === "GET" || method === "DELETE" ? undefined : {};
      const response = await bearer(admin.token, method, url, payload);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: "token_not_allowed" });
    }
  });

  it("answers 401 for a malformed, unknown or revoked token", async () => {
    const url = "/api/v1/servers";
    const malformed = await bearer("nope", "GET", url);
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json()).toMatchObject({ error: "invalid_token" });
    const unknown = `dw_${"A".repeat(43)}`;
    expect((await bearer(unknown, "GET", url)).statusCode).toBe(401);
    const basic = await fixture.app.inject({
      method: "GET",
      url,
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(basic.statusCode).toBe(401);
    const made = await makeToken(fixture.editor, "editor");
    expect((await bearer(made.token, "GET", url)).statusCode).toBe(200);
    const { app, editor } = fixture;
    const revoke = await call(app, editor, "DELETE", tokenUrl(made.id));
    expect(revoke.statusCode).toBe(204);
    expect((await bearer(made.token, "GET", url)).statusCode).toBe(401);
  });

  it("lets only the creator or a manager revoke a token", async () => {
    const { app, admin, editor, viewer, owner } = fixture;
    const mine = await makeToken(editor, "editor");
    const owners = await makeToken(owner, "viewer");
    const byViewer = await call(app, viewer, "DELETE", tokenUrl(mine.id));
    expect(byViewer.statusCode).toBe(404);
    expect(byViewer.json()).toMatchObject({ error: "token_not_found" });
    const ofOwner = await call(app, admin, "DELETE", tokenUrl(owners.id));
    expect(ofOwner.statusCode).toBe(404);
    const byAdmin = await call(app, admin, "DELETE", tokenUrl(mine.id));
    expect(byAdmin.statusCode).toBe(204);
    // T-05: the owner may revoke any token.
    const ofEditor = await makeToken(editor, "editor");
    const byOwner = await call(app, owner, "DELETE", tokenUrl(ofEditor.id));
    expect(byOwner.statusCode).toBe(204);
  });

  it("names the token id in the audit log, never the value", async () => {
    const made = await makeToken(fixture.editor, "editor");
    const response = await bearer(
      made.token,
      "POST",
      changeSetsOf(fixture.servers.a),
      editsOf(14),
    );
    expect(response.statusCode).toBe(201);
    const rows = fixture.app.ctx.store.db.select().from(auditEvents).all();
    expect(JSON.stringify(rows)).not.toContain(made.token);
    const own = rows.filter((row) => row.data.includes(made.id));
    expect(own).toHaveLength(1);
    expect(own[0]?.actorId).toBe(fixture.editor.userId);
  });

  it("stops on the Free fallback and works again on Paid", async () => {
    const { app, owner, editor } = fixture;
    const made = await makeToken(editor, "editor");
    await toFree(app, owner);
    const refused = await bearer(made.token, "GET", "/api/v1/servers");
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toEqual({
      error: "payment_required",
      plan: "free",
      feature: "apiTokens",
    });
    expect((await create(editor, "viewer")).statusCode).toBe(402);
    const list = await call(app, editor, "GET", "/api/v1/tokens");
    expect(list.statusCode).toBe(200);
    await toPaid(app, owner);
    const back = await bearer(made.token, "GET", "/api/v1/servers");
    expect(back.statusCode).toBe(200);
  });

  it("ends with an anonymised user", async () => {
    const { app, owner, viewer } = fixture;
    const made = await makeToken(viewer, "viewer");
    const url = `/api/v1/users/${viewer.userId}/anonymise`;
    expect((await call(app, owner, "POST", url)).statusCode).toBe(200);
    const after = await bearer(made.token, "GET", "/api/v1/servers");
    expect(after.statusCode).toBe(401);
  });

  it("follows the creator's role down after a role change", async () => {
    const { app, owner, admin, servers } = fixture;
    const made = await makeToken(admin, "admin");
    const onB = `/api/v1/servers/${servers.b}`;
    const audit = "/api/v1/audit";
    expect((await bearer(made.token, "GET", onB)).statusCode).toBe(200);
    expect((await bearer(made.token, "GET", audit)).statusCode).toBe(200);
    const roleUrl = `/api/v1/users/${admin.userId}/role`;
    const role = { role: "viewer" };
    expect((await call(app, owner, "PUT", roleUrl, role)).statusCode).toBe(200);
    expect((await bearer(made.token, "GET", onB)).statusCode).toBe(404);
    const refused = await bearer(made.token, "GET", audit);
    expect(refused.statusCode).toBe(403);
  });

  it("T-06 follows the creator's grants down on every request", async () => {
    const { app, owner, servers } = fixture;
    // A fresh admin: the fixture admin was demoted by the test before.
    const admin = await inviteAndAccept(app, owner, "admin");
    const made = await makeToken(admin, "admin");
    const hooks = `/api/v1/servers/${servers.a}/hooks`;
    const urlA = changeSetsOf(servers.a);
    const urlB = changeSetsOf(servers.b);
    expect((await bearer(made.token, "PUT", hooks, {})).statusCode).toBe(200);
    const written = await bearer(made.token, "POST", urlA, editsOf(21));
    expect(written.statusCode).toBe(201);
    const grants = `/api/v1/users/${admin.userId}/grants`;
    const roleUrl = `/api/v1/users/${admin.userId}/role`;
    expect(
      (await call(app, owner, "PUT", roleUrl, { role: "editor" })).statusCode,
    ).toBe(200);
    expect(
      (await call(app, owner, "PUT", grants, { servers: [] })).statusCode,
    ).toBe(200);
    expect((await bearer(made.token, "PUT", hooks, {})).statusCode).toBe(403);
    const onB = await bearer(made.token, "POST", urlB, editsOf(22));
    expect(onB.statusCode).toBe(404);
    expect(onB.json()).toMatchObject({ error: "server_not_found" });
    const grant = { servers: [{ server: servers.a, level: "write" }] };
    expect((await call(app, owner, "PUT", grants, grant)).statusCode).toBe(200);
    const again = await bearer(made.token, "POST", urlA, editsOf(23));
    expect(again.statusCode).toBe(201);
    expect(
      (await call(app, owner, "PUT", roleUrl, { role: "viewer" })).statusCode,
    ).toBe(200);
    const last = await bearer(made.token, "POST", urlA, editsOf(24));
    expect(last.statusCode).toBe(403);
  });

  it("T-08 answers 402 on Free before any lookup, for any value", async () => {
    const { app, editor } = fixture;
    const made = await makeToken(editor, "viewer");
    await toFree(app, fixture.owner);
    const refused = await bearer(made.token, "GET", "/api/v1/servers");
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toEqual({
      error: "payment_required",
      plan: "free",
      feature: "apiTokens",
    });
    const random = await bearer(
      `dw_${"z".repeat(43)}`,
      "GET",
      "/api/v1/servers",
    );
    expect(random.statusCode).toBe(402);
    expect(random.json()).toEqual({
      error: "payment_required",
      plan: "free",
      feature: "apiTokens",
    });
    await toPaid(app, fixture.owner);
  });

  it("T-10 refuses a token together with a session cookie", async () => {
    const made = await makeToken(fixture.editor, "editor");
    const headers = {
      authorization: `Bearer ${made.token}`,
      cookie: fixture.editor.cookie,
      "x-csrf-token": fixture.editor.csrf,
    };
    const response = await fixture.app.inject({
      method: "POST",
      url: changeSetsOf(fixture.servers.a),
      headers,
      payload: editsOf(25),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "ambiguous_credentials" });
    const alone = await bearer(
      made.token,
      "POST",
      changeSetsOf(fixture.servers.a),
      editsOf(26),
    );
    expect(alone.statusCode).toBe(201);
  });

  it("T-11 never reads a token from the query string", async () => {
    const made = await makeToken(fixture.editor, "viewer");
    const response = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/servers?token=${made.token}&access_token=${made.token}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("T-12 answers 401 for a malformed Authorization header", async () => {
    const { app } = fixture;
    const url = "/api/v1/servers";
    const headers = [
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: `Bearer  ${"a".repeat(41)}` },
      { authorization: "Basic dXNlcjpwYXNz" },
      { authorization: `Bearer ${"a".repeat(10 * 1024)}` },
    ];
    for (const header of headers) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: header,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_token" });
    }
  });

  it("T-13 gives every token the product prefix and random bytes", async () => {
    const { editor, loner } = fixture;
    const values = new Set<string>();
    for (const user of [editor, loner]) {
      for (let index = 0; index < MAX_TOKENS_PER_USER; index += 1) {
        const made = await makeToken(user, "viewer", `many-${index}`);
        expect(made.token).toMatch(TOKEN_VALUE);
        values.add(made.token);
      }
    }
    expect(values.size).toBe(2 * MAX_TOKENS_PER_USER);
    const limit = await create(fixture.editor, "viewer", "over");
    expect(limit.statusCode).toBe(409);
  });

  it("T-07 ends with a deleted creator", async () => {
    const { app, owner, loner } = fixture;
    const made = await makeToken(loner, "viewer");
    const url = `/api/v1/users/${loner.userId}`;
    expect((await call(app, owner, "DELETE", url)).statusCode).toBe(204);
    expect(
      (await bearer(made.token, "GET", "/api/v1/servers")).statusCode,
    ).toBe(401);
  });

  it("T-03 never writes the token to the log stream", async () => {
    const lines: string[] = [];
    const current = await paidApp({
      logStream: new Writable({
        write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
          lines.push(String(chunk));
          done();
        },
      }),
      extraEnv: { LOG_LEVEL: "info" },
      extend: (app) => {
        app.get("/api/v1/test/boom", { config: { auth: "user" } }, async () => {
          throw new Error("boom");
        });
      },
    });
    try {
      const owner = await setupOwner(current.app);
      const response = await call(
        current.app,
        owner,
        "POST",
        "/api/v1/tokens",
        { name: "logged", role: "viewer" },
      );
      expect(response.statusCode).toBe(201);
      const { token } = response.json<{ token: string }>();
      const get = (value: string, url: string) =>
        current.app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${value}` },
        });
      const codes = [
        await get(token, "/api/v1/servers"),
        await get("dw_broken", "/api/v1/servers"),
        await get(token, "/api/v1/test/boom"),
      ];
      expect(codes.map((item) => item.statusCode)).toEqual([200, 401, 500]);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(token);
      }
      const audit = current.app.ctx.store.sqlite
        .prepare('SELECT * FROM "audit_events"')
        .all();
      expect(JSON.stringify(audit)).not.toContain(token);
    } finally {
      await current.close();
    }
  });
});
