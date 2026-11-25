// Erasing a person (dev-work-plan P8-A step 7; p8-threat-specs P-04 to P-06,
// D7 and D24): anonymising or deleting a user removes the e-mail address and
// the name from every table, keeps the history rows under the erased-user
// label, ends every session and token, and never breaks the audit chain. The
// owner cannot be erased or anonymised.
import { afterEach, describe, expect, it } from "vitest";
import type { TestApp } from "../../test/helpers.js";
import {
  call,
  INT_SETTING,
  inviteAndAccept,
  signIn,
  teamFixture,
  type Member,
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

/** A fresh editor with a name and address no other row can hold. */
async function markedEditor(t: TeamFixture, label: string): Promise<Member> {
  const name = `${label}-${Date.now().toString(36)}`;
  return inviteAndAccept(
    t.app,
    t.owner,
    "editor",
    [{ server: t.servers.a, level: "write" }],
    name,
  );
}

/** Every text column of every table, as one searchable text. */
function everyRow(t: TeamFixture): string {
  const sqlite = t.app.ctx.store.sqlite;
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return tables
    .map(({ name }) =>
      JSON.stringify(sqlite.prepare(`SELECT * FROM "${name}"`).all()),
    )
    .join("\n");
}

/** The audit chain still verifies after the erasure. */
async function chainValid(t: TeamFixture): Promise<void> {
  const response = await call(t.app, t.owner, "GET", "/api/v1/audit/verify");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ valid: true });
}

describe("erasing a person (P-04 to P-06)", () => {
  it("P-04 anonymising removes the person everywhere", async () => {
    const t = await fixture();
    const { app, owner, servers } = t;
    const member = await markedEditor(t, "erase-me");
    const signed = await signIn(app, member.email, member.password);
    const token = await call(app, member, "POST", "/api/v1/tokens", {
      name: "gone",
      role: "viewer",
    });
    expect(token.statusCode).toBe(201);
    const tokenValue = token.json<{ token: string }>().token;
    const made = await call(
      app,
      member,
      "POST",
      `/api/v1/servers/${servers.a}/change-sets`,
      { edits: [{ settingKey: INT_SETTING, value: 44 }] },
    );
    expect(made.statusCode).toBe(201);
    const applied = await call(
      app,
      member,
      "POST",
      `/api/v1/change-sets/${made.json<{ id: string }>().id}/apply`,
      {},
    );
    expect(applied.statusCode).toBe(200);
    const erased = await call(
      app,
      owner,
      "POST",
      `/api/v1/users/${member.userId}/anonymise`,
    );
    expect(erased.statusCode).toBe(200);
    const rows = everyRow(t);
    expect(rows).not.toContain(member.email);
    expect(rows).not.toContain(member.name);
    // Every session and token of the person ends.
    const old = await call(app, signed, "GET", "/api/v1/auth/session");
    expect(old.statusCode).toBe(401);
    const bearer = await app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: { authorization: `Bearer ${tokenValue}` },
    });
    expect(bearer.statusCode).toBe(401);
    // The history keeps the row under the erased-user label, and the chain
    // still verifies.
    const history = await call(
      app,
      owner,
      "GET",
      `/api/v1/servers/${servers.a}/history`,
    );
    expect(history.body).toContain("Erased user");
    await chainValid(t);
  });

  it("P-05 deleting removes the person and keeps the history", async () => {
    const t = await fixture();
    const { app, owner, servers } = t;
    const member = await markedEditor(t, "delete-me");
    const made = await call(
      app,
      member,
      "POST",
      `/api/v1/servers/${servers.a}/change-sets`,
      { edits: [{ settingKey: INT_SETTING, value: 45 }] },
    );
    expect(made.statusCode).toBe(201);
    const applied = await call(
      app,
      member,
      "POST",
      `/api/v1/change-sets/${made.json<{ id: string }>().id}/apply`,
      {},
    );
    expect(applied.statusCode).toBe(200);
    const removed = await call(
      app,
      owner,
      "DELETE",
      `/api/v1/users/${member.userId}`,
    );
    expect(removed.statusCode).toBe(204);
    const rows = everyRow(t);
    expect(rows).not.toContain(member.email);
    expect(rows).not.toContain(member.name);
    const history = await call(
      app,
      owner,
      "GET",
      `/api/v1/servers/${servers.a}/history`,
    );
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain("Erased user");
    const sqlite = app.ctx.store.sqlite;
    const check = sqlite.prepare("PRAGMA foreign_key_check").all();
    expect(check).toEqual([]);
    await chainValid(t);
  });

  it("P-06 protects the owner from both controls", async () => {
    const t = await fixture();
    const { app, owner, admin } = t;
    const self = `/api/v1/users/${owner.userId}`;
    const ownDelete = await call(app, owner, "DELETE", self);
    expect(ownDelete.statusCode).toBe(409);
    expect(ownDelete.json()).toEqual({ error: "owner_required" });
    const ownAnonymise = await call(app, owner, "POST", `${self}/anonymise`);
    expect(ownAnonymise.statusCode).toBe(409);
    const byAdmin = await call(app, admin, "DELETE", self);
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toEqual({ error: "cannot_change_owner" });
    const anonymise = await call(app, admin, "POST", `${self}/anonymise`);
    expect(anonymise.statusCode).toBe(403);
    expect(anonymise.json()).toEqual({ error: "cannot_change_owner" });
  });
});
