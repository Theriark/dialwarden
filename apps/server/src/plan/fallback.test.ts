// The Free fallback (dev-work-plan P8-A step 8; p8-threat-specs F-01 to
// F-07): when the licence is removed or the owner switches to Free, every
// user but the owner acts as a viewer, roles and grants stay stored, audit
// recording never stops, API tokens stop working, and a switch back to Paid
// restores everything at once. The owner keeps working under the P4 rules.
import { afterEach, describe, expect, it } from "vitest";
import type { TestApp } from "../../test/helpers.js";
import {
  call,
  INT_SETTING,
  inviteAndAccept,
  teamFixture,
  toFree,
  toPaid,
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

const editsOf = (value: number) => ({
  edits: [{ settingKey: INT_SETTING, value }],
});

describe("the Free fallback (F-01 to F-06)", () => {
  it("F-01 demotes every user but the owner to viewer", async () => {
    const t = await fixture();
    const { app, owner, admin, editor, servers } = t;
    const url = `/api/v1/servers/${servers.a}/change-sets`;
    await toFree(app, owner);
    // Both write as admins or editors before; on Free they read only.
    const byAdmin = await call(app, admin, "POST", url, editsOf(30));
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toEqual({ error: "forbidden" });
    const byEditor = await call(app, editor, "POST", url, editsOf(31));
    expect(byEditor.statusCode).toBe(403);
    // Role changes are Paid (team.roles) on Free, even for the owner.
    const role = await call(
      app,
      owner,
      "PUT",
      `/api/v1/users/${editor.userId}/role`,
      { role: "editor" },
    );
    expect(role.statusCode).toBe(402);
    expect(role.json()).toEqual({
      error: "payment_required",
      plan: "free",
      feature: "team.roles",
    });
    // The session shows the effective role; the stored role is unchanged.
    const session = await call(app, editor, "GET", "/api/v1/auth/session");
    expect(session.statusCode).toBe(200);
    expect(session.json<{ user: { role: string } }>().user.role).toBe(
      "viewer",
    );
    const stored = app.ctx.store.sqlite
      .prepare('SELECT role AS value FROM "users" WHERE id = ?')
      .get(editor.userId) as { value: string };
    expect(stored.value).toBe("editor");
    // A switch back restores the same sessions at once.
    await toPaid(app, owner);
    const again = await call(app, editor, "POST", url, editsOf(32));
    expect(again.statusCode).toBe(201);
  });

  it("F-02 keeps the owner working under the P4 rules", async () => {
    const t = await fixture();
    const { app, owner, servers } = t;
    await toFree(app, owner);
    // Nothing was edited yet, so the owner picks their editable server.
    const chosen = await call(
      app,
      owner,
      "PUT",
      "/api/v1/plan/editable-servers",
      { servers: [servers.a] },
    );
    expect(chosen.statusCode).toBe(200);
    const editable = await call(
      app,
      owner,
      "POST",
      `/api/v1/servers/${servers.a}/change-sets`,
      editsOf(33),
    );
    expect(editable.statusCode).toBe(201);
    // A server beyond the editable ones answers the P4 limit.
    const refused = await call(
      app,
      owner,
      "POST",
      `/api/v1/servers/${servers.b}/change-sets`,
      editsOf(34),
    );
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({
      error: "payment_required",
      limit: "servers",
    });
  });

  it("F-03 shows a demoted user only their granted servers", async () => {
    const t = await fixture();
    const { app, editor, viewer } = t;
    await toFree(app, t.owner);
    for (const user of [editor, viewer]) {
      const response = await call(app, user, "GET", "/api/v1/servers");
      expect(response.statusCode).toBe(200);
      const items = response.json<{ items: { id: string }[] }>().items;
      expect(items.map((item) => item.id)).toEqual([t.servers.a]);
    }
  });

  it("F-05 keeps the audit log recorded and readable on Free", async () => {
    const t = await fixture();
    const { app, owner, editor } = t;
    await toFree(app, owner);
    const list = await call(app, owner, "GET", "/api/v1/audit");
    expect(list.statusCode).toBe(200);
    const verify = await call(app, owner, "GET", "/api/v1/audit/verify");
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ valid: true });
    // Recording never stops: the refused sign-in below writes a row and the
    // chain stays valid.
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: editor.email, password: "wrong-password" },
    });
    const after = await call(app, owner, "GET", "/api/v1/audit/verify");
    expect(after.json()).toMatchObject({ valid: true });
    const exportRefused = await call(
      app,
      owner,
      "GET",
      "/api/v1/audit/export.csv",
    );
    expect(exportRefused.statusCode).toBe(402);
    expect(exportRefused.json()).toEqual({
      error: "payment_required",
      plan: "free",
      feature: "audit",
    });
  });

  it("F-06 stops API tokens on Free (T-08) and F-07 reset links", async () => {
    const t = await fixture();
    const { app, owner, editor } = t;
    const token = await call(app, editor, "POST", "/api/v1/tokens", {
      name: "fallback",
      role: "viewer",
    });
    expect(token.statusCode).toBe(201);
    const value = token.json<{ token: string }>().token;
    await toFree(app, owner);
    const refused = await app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: { authorization: `Bearer ${value}` },
    });
    expect(refused.statusCode).toBe(402);
    // F-07: an owner-made reset link works on Free and is single use.
    const reset = await call(
      app,
      owner,
      "POST",
      `/api/v1/users/${editor.userId}/password-reset`,
    );
    expect(reset.statusCode).toBe(201);
    const link = reset.json<{ token: string; link: string }>();
    expect(link.link).toContain("#");
    const used = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token: link.token, password: "fallback-730141-new" },
    });
    expect(used.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token: link.token, password: "fallback-730141-two" },
    });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual({ error: "reset_invalid" });
    // Every earlier session of the user ended with the reset.
    const session = await call(app, editor, "GET", "/api/v1/auth/session");
    expect(session.statusCode).toBe(401);
  });
});
