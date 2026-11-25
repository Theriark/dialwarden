// The role matrix (dev-work-plan P8-A tests; p8-threat-specs A-01 and A-02):
// every API route, every role. EXPECTED_ACCESS is the reviewable record of
// who may do what: one policy per route, expanded below into the answer of
// each principal on demo-a (E writes, V reads) and demo-b (no grant for E,
// E2 or V). A route missing from the table, or a table row without a route,
// fails the test. The app runs with the authProbe seam: a request that
// passes every check answers 299 and its handler never runs, so the matrix
// changes nothing and needs no valid body.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshots } from "../db/schema.js";
import { AUTH_PROBE_HEADER } from "../http/guard.js";
import { headersOf, type SignedIn } from "../../test/helpers.js";
import {
  apiOf,
  draft,
  fileText,
  PALWORLD_SETTINGS,
} from "../../test/servers.js";
import {
  call,
  INT_SETTING,
  invite,
  inviteAndAccept,
  teamFixture,
  testEmail,
  type TeamFixture,
} from "../../test/team.js";

/** Who may call a route. Server policies depend on the grant there. */
type Policy =
  | "public"
  | "setupDone"
  | "user"
  | "admin"
  | "owner"
  | "serverRead"
  | "serverWrite"
  | "serverAdmin"
  | "serverOwner";

const EXPECTED_ACCESS: Readonly<Record<string, Policy>> = {
  "GET /api/v1/setup": "public",
  "POST /api/v1/setup": "setupDone",
  "POST /api/v1/setup/import": "setupDone",
  "GET /api/v1/auth/session": "user",
  "POST /api/v1/auth/login": "public",
  "POST /api/v1/auth/login/totp": "public",
  "POST /api/v1/auth/logout": "public",
  "PATCH /api/v1/auth/profile": "user",
  "POST /api/v1/auth/password": "user",
  "POST /api/v1/auth/totp/enrol": "user",
  "POST /api/v1/auth/totp/enable": "user",
  "POST /api/v1/auth/totp/disable": "user",
  "POST /api/v1/auth/password-reset": "public",
  "GET /api/v1/auth/oidc": "public",
  "GET /api/v1/auth/oidc/start": "public",
  "GET /api/v1/auth/oidc/callback": "public",
  "GET /api/v1/openapi.json": "public",
  "GET /api/v1/entitlement": "user",
  "PUT /api/v1/licence": "owner",
  "DELETE /api/v1/licence": "owner",
  "PUT /api/v1/licence/environment": "owner",
  "GET /api/v1/plan/registry": "user",
  "GET /api/v1/plan/editable-servers": "user",
  "PUT /api/v1/plan/editable-servers": "owner",
  "GET /api/v1/activity": "user",
  "GET /api/v1/system/status": "owner",
  "POST /api/v1/system/app-secret/acknowledge": "owner",
  "GET /api/v1/system/backups": "owner",
  "POST /api/v1/system/backups": "owner",
  "POST /api/v1/system/backups/:id/drill": "owner",
  "POST /api/v1/system/backup-export": "owner",
  "GET /api/v1/system/snapshots": "owner",
  "GET /api/v1/games": "user",
  "GET /api/v1/games/:id/settings-meta": "user",
  "GET /api/v1/connectors/ssh-key": "owner",
  "POST /api/v1/connectors/test": "owner",
  "POST /api/v1/connectors/host-keys": "owner",
  "POST /api/v1/connectors/detect": "owner",
  "GET /api/v1/servers": "user",
  "POST /api/v1/servers": "owner",
  "GET /api/v1/servers/:slug": "serverRead",
  "PATCH /api/v1/servers/:slug": "serverOwner",
  "DELETE /api/v1/servers/:slug": "serverOwner",
  "POST /api/v1/servers/:slug/test": "serverOwner",
  "POST /api/v1/servers/:slug/detect": "serverOwner",
  "GET /api/v1/servers/:slug/settings": "serverRead",
  "GET /api/v1/servers/:slug/files/:fileId": "serverAdmin",
  "GET /api/v1/servers/:slug/history": "serverRead",
  "GET /api/v1/servers/:slug/pending": "serverRead",
  "POST /api/v1/servers/:slug/change-sets": "serverWrite",
  "GET /api/v1/change-sets/:id": "serverRead",
  "POST /api/v1/change-sets/:id/apply": "serverWrite",
  "POST /api/v1/snapshots/:id/restore": "serverWrite",
  "GET /api/v1/presets": "user",
  "POST /api/v1/presets": "owner",
  "DELETE /api/v1/presets/:id": "owner",
  "POST /api/v1/presets/:id/apply": "serverWrite",
  "GET /api/v1/servers/:slug/hooks": "serverRead",
  "PUT /api/v1/servers/:slug/hooks": "serverAdmin",
  "POST /api/v1/servers/:slug/hooks/run": "serverWrite",
  "GET /api/v1/servers/:slug/status": "serverRead",
  "GET /api/v1/users": "admin",
  "GET /api/v1/users/:id": "admin",
  "PUT /api/v1/users/:id/role": "admin",
  "PUT /api/v1/users/:id/grants": "admin",
  "DELETE /api/v1/users/:id": "admin",
  "POST /api/v1/users/:id/anonymise": "admin",
  "POST /api/v1/users/:id/password-reset": "admin",
  "GET /api/v1/users/:id/export": "owner",
  "GET /api/v1/me/export": "user",
  "POST /api/v1/invitations": "admin",
  "GET /api/v1/invitations": "admin",
  "DELETE /api/v1/invitations/:id": "admin",
  "POST /api/v1/invitations/accept": "public",
  "GET /api/v1/audit": "admin",
  "GET /api/v1/audit/verify": "admin",
  "GET /api/v1/audit/export.csv": "admin",
  "GET /api/v1/settings/audit": "admin",
  "PUT /api/v1/settings/audit": "admin",
  "GET /api/v1/settings/snapshots": "admin",
  "PUT /api/v1/settings/snapshots": "admin",
  "GET /api/v1/settings/oidc": "owner",
  "PUT /api/v1/settings/oidc": "owner",
  "GET /api/v1/tokens": "user",
  "POST /api/v1/tokens": "user",
  "DELETE /api/v1/tokens/:id": "user",
};

const PRINCIPALS = ["O", "A", "E", "E2", "V", "anon"] as const;
type Who = (typeof PRINCIPALS)[number];

const ALLOWED = 299;

/** The answers of O, A, E, E2, V and anonymous, in that order. */
function expected(policy: Policy, server: "a" | "b"): number[] {
  const ok = ALLOWED;
  const onB = server === "b";
  switch (policy) {
    case "public":
      return [ok, ok, ok, ok, ok, ok];
    case "setupDone":
      return [409, 409, 409, 409, 409, 409];
    case "user":
      return [ok, ok, ok, ok, ok, 401];
    case "admin":
      return [ok, ok, 403, 403, 403, 401];
    case "owner":
      return [ok, 403, 403, 403, 403, 401];
    case "serverRead":
      return onB ? [ok, ok, 404, 404, 404, 401] : [ok, ok, ok, 404, ok, 401];
    case "serverWrite":
      return onB ? [ok, ok, 404, 404, 404, 401] : [ok, ok, ok, 404, 403, 401];
    case "serverAdmin":
      return onB ? [ok, ok, 404, 404, 404, 401] : [ok, ok, 403, 404, 403, 401];
    case "serverOwner":
      return onB
        ? [ok, 403, 404, 404, 404, 401]
        : [ok, 403, 403, 404, 403, 401];
  }
}

const isServerPolicy = (policy: Policy): boolean => policy.startsWith("server");

let fixture: TeamFixture;
let ids: {
  changeSet: { a: string; b: string };
  snapshot: { a: string; b: string };
  preset: string;
};

beforeAll(async () => {
  fixture = await teamFixture({ authProbe: true });
  const { app, owner, servers } = fixture;
  const api = apiOf(app, owner);
  const onA = await draft(api, servers.a, { [INT_SETTING]: 20 });
  const onB = await draft(api, servers.b, { [INT_SETTING]: 21 });
  const snap = (serverId: string): string => {
    const rows = app.ctx.store.db.select().from(snapshots).all();
    const found = rows.find((row) => row.serverId === serverId);
    if (found === undefined) throw new Error(`no snapshot on ${serverId}`);
    return found.id;
  };
  const preset = await api.post("/api/v1/presets", {
    name: "matrix",
    description: "",
    packId: "palworld",
    values: { [INT_SETTING]: 10 },
  });
  ids = {
    changeSet: { a: onA.id, b: onB.id },
    snapshot: { a: snap(servers.a), b: snap(servers.b) },
    preset: preset.json<{ id: string }>().id,
  };
});

afterAll(async () => {
  await fixture.current.close();
});

/** The concrete URL and body of a route on server a or b. */
function concrete(url: string, server: "a" | "b") {
  const onA = server === "a";
  const slug = onA ? fixture.servers.a : fixture.servers.b;
  const changeSet = onA ? ids.changeSet.a : ids.changeSet.b;
  const snapshot = onA ? ids.snapshot.a : ids.snapshot.b;
  const path = url
    .replace(":slug", slug)
    .replace(":fileId", "settings")
    .replace("/games/:id", "/games/palworld")
    .replace("/backups/:id", "/backups/20261121-0330")
    .replace("/users/:id", `/users/${fixture.editor.userId}`)
    .replace("/invitations/:id", `/invitations/${randomUUID()}`)
    .replace("/tokens/:id", `/tokens/${randomUUID()}`)
    .replace("/presets/:id", `/presets/${ids.preset}`)
    .replace("/change-sets/:id", `/change-sets/${changeSet}`)
    .replace("/snapshots/:id", `/snapshots/${snapshot}`);
  const body = url.endsWith("/presets/:id/apply") ? { server: slug } : {};
  return { path, body };
}

function principal(who: Who): SignedIn | null {
  const map = new Map<Who, SignedIn | null>([
    ["O", fixture.owner],
    ["A", fixture.admin],
    ["E", fixture.editor],
    ["E2", fixture.loner],
    ["V", fixture.viewer],
  ]);
  return map.get(who) ?? null;
}

async function probe(
  app: FastifyInstance,
  method: string,
  path: string,
  body: object,
  user: SignedIn | null,
): Promise<number> {
  const headers: Record<string, string> = { [AUTH_PROBE_HEADER]: "1" };
  if (user !== null) Object.assign(headers, headersOf(user));
  const response = await app.inject({
    method: method as "GET",
    url: path,
    headers,
    ...(method === "GET" || method === "DELETE" ? {} : { payload: body }),
  });
  return response.statusCode;
}

describe("role matrix (A-01, A-02)", () => {
  it("lists every API route in EXPECTED_ACCESS and nothing else", () => {
    const routes = fixture.app.ctx.routes
      .filter((r) => r.method !== "HEAD" && r.url.startsWith("/api/v1/"))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(routes).toEqual(Object.keys(EXPECTED_ACCESS).sort());
  });

  it("answers every route for every role as EXPECTED_ACCESS says", async () => {
    const { app } = fixture;
    const actual = new Map<string, number[]>();
    const wanted = new Map<string, number[]>();
    for (const [key, policy] of Object.entries(EXPECTED_ACCESS)) {
      const [method = "GET", url = ""] = key.split(" ");
      const variants = isServerPolicy(policy) ? (["a", "b"] as const) : ["a"];
      for (const server of variants as readonly ("a" | "b")[]) {
        const { path, body } = concrete(url, server);
        const name = `${key} on ${server}`;
        const codes: number[] = [];
        for (const who of PRINCIPALS) {
          codes.push(await probe(app, method, path, body, principal(who)));
        }
        actual.set(name, codes);
        wanted.set(name, expected(policy, server));
      }
    }
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(wanted));
  });

  it("declares config.server on every route about one server (A-02)", () => {
    const missing = fixture.app.ctx.routes
      .filter((r) => r.method !== "HEAD" && r.url.includes(":slug"))
      .filter((r) => r.server === null)
      .map((r) => `${r.method} ${r.url}`);
    expect(missing).toEqual([]);
    const scoped = [
      "GET /api/v1/change-sets/:id",
      "POST /api/v1/change-sets/:id/apply",
      "POST /api/v1/snapshots/:id/restore",
      "POST /api/v1/presets/:id/apply",
    ];
    for (const key of scoped) {
      const route = fixture.app.ctx.routes.find(
        (r) => `${r.method} ${r.url}` === key,
      );
      expect(route?.server, key).not.toBeNull();
    }
  });
});

describe("privilege escalation (A-03 to A-18)", () => {
  /** The change sets on demo-b: its import and the matrix draft. */
  const ON_B = 2;
  const unknown = (slug: string) => `/api/v1/servers/${slug}`;

  /** The answer for an unknown object of the same kind, to compare with. */
  async function answerOf(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
  ): Promise<{ status: number; body: string }> {
    const response = await fixture.app.inject({
      method,
      url,
      headers: headersOf(fixture.editor),
      ...(payload === undefined || method === "GET" || method === "DELETE"
        ? {}
        : { payload }),
    });
    return { status: response.statusCode, body: response.body };
  }

  it("A-03 refuses an editor's writes on an ungranted server", async () => {
    const t = fixture;
    const { editor, servers } = t;
    const b = unknown(servers.b);
    const before = await fileText(servers.rootB, PALWORLD_SETTINGS);
    const writes: [string, "POST" | "PUT", object][] = [
      [
        `${b}/change-sets`,
        "POST",
        { edits: [{ settingKey: INT_SETTING, value: 2 }] },
      ],
      [`${b}/hooks/run`, "POST", { action: "restart" }],
      [`${b}/hooks`, "PUT", { hook: null }],
    ];
    for (const [url, method, payload] of writes) {
      const response = await call(t.app, editor, method, url, payload);
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual({ error: "server_not_found" });
    }
    expect(await fileText(servers.rootB, PALWORLD_SETTINGS)).toBe(before);
    const rows = t.app.ctx.store.sqlite
      .prepare('SELECT count(*) AS n FROM "change_sets" WHERE server_id = ?')
      .get(servers.b) as { n: number };
    expect(rows.n).toBe(ON_B);
  });

  it("A-04 hides an ungranted server from an editor's reads", async () => {
    const t = fixture;
    const { editor, servers } = t;
    const b = unknown(servers.b);
    const paths = [
      "",
      "/settings",
      "/history",
      "/pending",
      "/status",
      "/hooks",
    ];
    for (const path of paths) {
      const response = await call(t.app, editor, "GET", `${b}${path}`);
      expect(response.statusCode, path).toBe(404);
      expect(response.json(), path).toEqual({ error: "server_not_found" });
    }
    const list = await call(t.app, editor, "GET", "/api/v1/servers");
    expect(
      list.json<{ items: { id: string }[] }>().items.map((item) => item.id),
    ).toEqual([servers.a]);
    const activity = await call(
      t.app,
      editor,
      "GET",
      `/api/v1/activity?serverId=${servers.b}`,
    );
    expect(activity.json<{ items: unknown[] }>().items).toEqual([]);
    const editable = await call(
      t.app,
      editor,
      "GET",
      "/api/v1/plan/editable-servers",
    );
    expect(editable.json<{ servers: string[] }>().servers).not.toContain(
      servers.b,
    );
  });

  it("A-05 answers objects of another server as missing", async () => {
    const t = fixture;
    const { servers } = t;
    const changeSet = ids.changeSet.b;
    const snapshot = ids.snapshot.b;
    const reads: ["GET" | "POST", string, object?][] = [
      ["GET", `/api/v1/change-sets/${changeSet}`],
      ["POST", `/api/v1/change-sets/${changeSet}/apply`, { runHooks: "none" }],
      ["POST", `/api/v1/snapshots/${snapshot}/restore`],
    ];
    for (const [method, url, payload] of reads) {
      const mine = await answerOf(method, url, payload);
      const random = await answerOf(
        method,
        url.replace(changeSet, randomUUID()).replace(snapshot, randomUUID()),
        payload,
      );
      expect(mine.status, url).toBe(404);
      expect(mine, url).toEqual(random);
    }
    const rows = t.app.ctx.store.sqlite
      .prepare('SELECT count(*) AS n FROM "change_sets" WHERE server_id = ?')
      .get(servers.b) as { n: number };
    expect(rows.n).toBe(ON_B);
  });

  it("A-06 refuses a preset apply onto an ungranted server", async () => {
    const t = fixture;
    const { editor, servers } = t;
    const response = await call(
      t.app,
      editor,
      "POST",
      `/api/v1/presets/${ids.preset}/apply`,
      { server: servers.b },
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "server_not_found" });
    const rows = t.app.ctx.store.sqlite
      .prepare('SELECT count(*) AS n FROM "change_sets" WHERE server_id = ?')
      .get(servers.b) as { n: number };
    expect(rows.n).toBe(ON_B);
  });

  it("A-07 refuses an apply after the grant went away", async () => {
    const t = fixture;
    const { app, owner, servers } = t;
    const member = await inviteAndAccept(app, owner, "editor", [
      { server: servers.a, level: "write" },
    ]);
    const made = await call(
      app,
      member,
      "POST",
      `/api/v1/servers/${servers.a}/change-sets`,
      { edits: [{ settingKey: INT_SETTING, value: 7 }] },
    );
    expect(made.statusCode).toBe(201);
    const grants = await call(
      app,
      owner,
      "PUT",
      `/api/v1/users/${member.userId}/grants`,
      { servers: [] },
    );
    expect(grants.statusCode).toBe(200);
    const apply = await call(
      app,
      member,
      "POST",
      `/api/v1/change-sets/${made.json<{ id: string }>().id}/apply`,
      {},
    );
    expect(apply.statusCode).toBe(404);
    const settings = await fileText(servers.rootA, PALWORLD_SETTINGS);
    expect(settings).not.toContain("ServerPlayerMaxNum=7");
  });

  it("A-08 lets a viewer change nothing", async () => {
    const t = fixture;
    const { app, viewer } = t;
    const counted = [
      "change_sets",
      "presets",
      "server_hooks",
      "users",
      "invitations",
      "api_tokens",
    ];
    const counts = (): Record<string, number> =>
      Object.fromEntries(
        counted.map((table) => [
          table,
          (
            t.app.ctx.store.sqlite
              .prepare(`SELECT count(*) AS n FROM "${table}"`)
              .all() as { n: number }[]
          )[0]?.n ?? 0,
        ]),
      );
    const before = counts();
    // Routes a user only ever calls for themselves, whatever their role.
    const self = [
      "POST /api/v1/auth/logout",
      "PATCH /api/v1/auth/profile",
      "POST /api/v1/auth/password",
      "POST /api/v1/auth/totp/enrol",
      "POST /api/v1/auth/totp/enable",
      "POST /api/v1/auth/totp/disable",
      "POST /api/v1/tokens",
      "DELETE /api/v1/tokens/:id",
    ];
    const publicRoutes = [
      "/api/v1/setup",
      "/api/v1/auth/login",
      "/api/v1/auth/login/totp",
      "/api/v1/invitations/accept",
      "/api/v1/auth/password-reset",
    ];
    for (const route of app.ctx.routes) {
      const key = `${route.method} ${route.url}`;
      if (route.method === "GET" || route.method === "HEAD") continue;
      if (self.includes(key)) continue;
      if (publicRoutes.some((prefix) => route.url.startsWith(prefix))) {
        continue;
      }
      const { path, body } = concrete(route.url, "b");
      const response = await call(
        app,
        viewer,
        route.method as "GET",
        path,
        body,
      );
      expect([403, 404], key).toContain(response.statusCode);
    }
    expect(counts()).toEqual(before);
  });

  it("A-09 protects the owner from every admin action", async () => {
    const t = fixture;
    const { app, admin, owner } = t;
    const self = `/api/v1/users/${owner.userId}`;
    const before = t.app.ctx.store.sqlite
      .prepare('SELECT * FROM "users" WHERE id = ?')
      .get(owner.userId);
    const calls: ["PUT" | "DELETE" | "POST", string, object?][] = [
      ["PUT", `${self}/role`, { role: "viewer" }],
      ["DELETE", self],
      ["PUT", `${self}/grants`, { servers: [] }],
      ["POST", `${self}/anonymise`],
      ["POST", `${self}/password-reset`],
    ];
    for (const [method, url, payload] of calls) {
      const response = await call(app, admin, method, url, payload);
      expect(response.statusCode, url).toBe(403);
      expect(response.json(), url).toEqual({ error: "cannot_change_owner" });
    }
    const after = t.app.ctx.store.sqlite
      .prepare('SELECT * FROM "users" WHERE id = ?')
      .get(owner.userId);
    expect(after).toEqual(before);
  });

  it("A-10 refuses a role change of yourself", async () => {
    const t = fixture;
    const { app, admin, owner } = t;
    const mine = `/api/v1/users/${admin.userId}/role`;
    const byAdmin = await call(app, admin, "PUT", mine, { role: "owner" });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toEqual({ error: "cannot_change_own_role" });
    const back = await call(app, admin, "PUT", mine, { role: "editor" });
    expect(back.statusCode).toBe(403);
    const byOwner = await call(
      app,
      owner,
      "PUT",
      `/api/v1/users/${owner.userId}/role`,
      { role: "admin" },
    );
    expect(byOwner.statusCode).toBe(403);
    expect(byOwner.json()).toEqual({ error: "cannot_change_own_role" });
    const owners = t.app.ctx.store.sqlite
      .prepare("SELECT count(*) AS n FROM users WHERE role = 'owner'")
      .all() as { n: number }[];
    expect(owners[0]?.n).toBe(1);
  });

  it("A-11 keeps the admin ceiling and lets the owner raise it", async () => {
    const t = fixture;
    const { app, owner, admin } = t;
    const second = await inviteAndAccept(app, owner, "admin");
    const target = await inviteAndAccept(app, owner, "editor");
    const up = await call(
      app,
      admin,
      "PUT",
      `/api/v1/users/${target.userId}/role`,
      { role: "admin" },
    );
    expect(up.statusCode).toBe(403);
    expect(up.json()).toEqual({ error: "role_too_high" });
    const down = await call(
      app,
      admin,
      "PUT",
      `/api/v1/users/${second.userId}/role`,
      { role: "viewer" },
    );
    expect(down.statusCode).toBe(403);
    expect(down.json()).toEqual({ error: "role_too_high" });
    const asOwner = await call(
      app,
      owner,
      "PUT",
      `/api/v1/users/${target.userId}/role`,
      { role: "admin" },
    );
    expect(asOwner.statusCode).toBe(200);
  });

  it("A-12 never assigns the owner role", async () => {
    const t = fixture;
    const { app, owner, admin } = t;
    const response = await call(
      app,
      owner,
      "PUT",
      `/api/v1/users/${admin.userId}/role`,
      { role: "owner" },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation" });
    const owners = t.app.ctx.store.sqlite
      .prepare("SELECT count(*) AS n FROM users WHERE role = 'owner'")
      .all() as { n: number }[];
    expect(owners[0]?.n).toBe(1);
  });

  it("A-13 keeps grant changes to the owner and admins", async () => {
    const t = fixture;
    const { app, editor, viewer, loner } = t;
    const before = t.app.ctx.store.sqlite
      .prepare("SELECT * FROM user_grants ORDER BY id")
      .all();
    const byEditor = await call(
      app,
      editor,
      "PUT",
      `/api/v1/users/${editor.userId}/grants`,
      { servers: [{ server: t.servers.b, level: "write" }] },
    );
    expect(byEditor.statusCode).toBe(403);
    const onLoner = await call(
      app,
      editor,
      "PUT",
      `/api/v1/users/${loner.userId}/grants`,
      { servers: [{ server: t.servers.b, level: "write" }] },
    );
    expect(onLoner.statusCode).toBe(403);
    const byViewer = await call(
      app,
      viewer,
      "PUT",
      `/api/v1/users/${viewer.userId}/grants`,
      { servers: [{ server: t.servers.b, level: "write" }] },
    );
    expect(byViewer.statusCode).toBe(403);
    const after = t.app.ctx.store.sqlite
      .prepare("SELECT * FROM user_grants ORDER BY id")
      .all();
    expect(after).toEqual(before);
  });

  it("A-14 refuses grants on unknown servers and viewers writing", async () => {
    const t = fixture;
    const { app, owner, editor, viewer } = t;
    const unknownServer = await call(
      app,
      owner,
      "PUT",
      `/api/v1/users/${editor.userId}/grants`,
      { servers: [{ server: "demo-zz", level: "write" }] },
    );
    expect(unknownServer.statusCode).toBe(422);
    expect(unknownServer.json()).toEqual({
      error: "unknown_server",
      server: "demo-zz",
    });
    const writeGrant = await call(
      app,
      owner,
      "PUT",
      `/api/v1/users/${viewer.userId}/grants`,
      { servers: [{ server: t.servers.a, level: "write" }] },
    );
    expect(writeGrant.statusCode).toBe(422);
    expect(writeGrant.json()).toMatchObject({ error: "validation" });
  });

  it("A-15 strips mass-assignment fields from the profile", async () => {
    const t = fixture;
    const { app, editor, owner } = t;
    const before = t.app.ctx.store.sqlite
      .prepare('SELECT role, email FROM "users" WHERE id = ?')
      .get(editor.userId);
    const response = await call(app, editor, "PATCH", "/api/v1/auth/profile", {
      name: "E",
      role: "owner",
      id: owner.userId,
      email: "x@dialwarden.test",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: { name: string } }>().user.name).toBe("E");
    const after = t.app.ctx.store.sqlite
      .prepare('SELECT role, email FROM "users" WHERE id = ?')
      .get(editor.userId);
    expect(after).toEqual(before);
    const ownerRow = t.app.ctx.store.sqlite
      .prepare('SELECT * FROM "users" WHERE id = ?')
      .get(owner.userId);
    expect(JSON.stringify(ownerRow)).not.toContain("x@dialwarden.test");
  });

  it("A-16 follows a role down in one session and ends with the user", async () => {
    const t = fixture;
    const { app, owner, servers } = t;
    const member = await inviteAndAccept(app, owner, "editor", [
      { server: servers.a, level: "write" },
    ]);
    const lowered = await call(
      app,
      owner,
      "PUT",
      `/api/v1/users/${member.userId}/role`,
      { role: "viewer" },
    );
    expect(lowered.statusCode).toBe(200);
    const write = await call(
      app,
      member,
      "POST",
      `/api/v1/servers/${servers.a}/change-sets`,
      { edits: [{ settingKey: INT_SETTING, value: 16 }] },
    );
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual({ error: "forbidden" });
    const removed = await call(
      app,
      owner,
      "DELETE",
      `/api/v1/users/${member.userId}`,
    );
    expect(removed.statusCode).toBe(204);
    const session = await call(app, member, "GET", "/api/v1/auth/session");
    expect(session.statusCode).toBe(401);
  });

  it("A-17 answers unknown user ids with user_not_found", async () => {
    const t = fixture;
    const { app, owner } = t;
    const id = randomUUID();
    const role = await call(app, owner, "PUT", `/api/v1/users/${id}/role`, {
      role: "viewer",
    });
    expect(role.statusCode).toBe(404);
    expect(role.json()).toEqual({ error: "user_not_found" });
    const removed = await call(app, owner, "DELETE", `/api/v1/users/${id}`);
    expect(removed.statusCode).toBe(404);
    expect(removed.json()).toEqual({ error: "user_not_found" });
  });

  it("A-18 scopes the activity feed by grant and by event kind", async () => {
    const t = fixture;
    const { app, owner, editor, viewer, admin, servers } = t;
    // Three events: a licence change, an invitation, a change on demo-b.
    await call(app, owner, "PUT", "/api/v1/licence/environment", {
      ignored: false,
    });
    const invited = await invite(app, owner, {
      email: testEmail("a18"),
      role: "viewer",
    });
    expect(invited.statusCode).toBe(201);
    const applied = await call(
      app,
      owner,
      "POST",
      `/api/v1/change-sets/${ids.changeSet.b}/apply`,
      { runHooks: "none" },
    );
    expect(applied.statusCode).toBe(200);
    const scoped = async (user: SignedIn) =>
      (await call(app, user, "GET", "/api/v1/activity")).json<{
        items: { type: string; serverId: string | null }[];
      }>().items;
    for (const user of [editor, viewer]) {
      const items = await scoped(user);
      expect(items.some((row) => row.serverId === servers.b)).toBe(false);
      expect(items.some((row) => row.type === "licence.changed")).toBe(false);
      expect(items.some((row) => row.type === "user.changed")).toBe(false);
    }
    for (const user of [admin, owner]) {
      const items = await scoped(user);
      expect(items.some((row) => row.serverId === servers.b)).toBe(true);
      expect(items.some((row) => row.type === "licence.changed")).toBe(true);
      expect(items.some((row) => row.type === "user.changed")).toBe(true);
    }
  });
});
