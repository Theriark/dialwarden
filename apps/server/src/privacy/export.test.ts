// The own-data export (dev-work-plan P8-A step 7; p8-threat-specs P-01 to
// P-03): a signed-in user downloads their personal data as JSON, and the file
// holds profile, grants, sessions, tokens and change sets of that user only —
// never another person's data and never a credential of any kind.
import { afterEach, describe, expect, it } from "vitest";
import { base32Decode, hotp, totpStep } from "../auth/totp.js";
import type { TestApp } from "../../test/helpers.js";
import {
  call,
  INT_SETTING,
  teamFixture,
  type TeamFixture,
} from "../../test/team.js";

const MARK_A = 88;
const MARK_E = 77;

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

describe("the own-data export (P-01 to P-03)", () => {
  it("P-01 holds the user's data and nobody else's", async () => {
    const t = await fixture();
    const { app, admin, editor, owner } = t;
    const url = `/api/v1/servers/${t.servers.a}/change-sets`;
    const edits = (value: number) => ({
      edits: [{ settingKey: INT_SETTING, value }],
    });
    const byA = await call(app, admin, "POST", url, edits(MARK_A));
    expect(byA.statusCode).toBe(201);
    const byE = await call(app, editor, "POST", url, edits(MARK_E));
    expect(byE.statusCode).toBe(201);
    const response = await call(app, editor, "GET", "/api/v1/me/export");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toContain("attachment");
    const exported = response.json<{
      changeSets: { chips: { settingKey: string | null; to: unknown }[] }[];
    }>();
    const changed = exported.changeSets.flatMap((set) =>
      set.chips.filter((chip) => chip.settingKey === INT_SETTING),
    );
    expect(changed.map((chip) => chip.to)).toEqual([MARK_E]);
    // No other person's data travels with the export.
    expect(response.body).not.toContain(admin.email);
    expect(response.body).not.toContain(owner.email);
    expect(response.body).toContain(editor.email);
  });

  it("P-02 holds no credential of the user or the instance", async () => {
    const t = await fixture();
    const { app, editor } = t;
    // E turns TOTP on and makes an API token, so every kind of credential
    // exists somewhere in the database.
    const enrol = await call(app, editor, "POST", "/api/v1/auth/totp/enrol", {
      password: editor.password,
    });
    expect(enrol.statusCode).toBe(200);
    const { secret } = enrol.json<{ secret: string }>();
    const code = hotp(base32Decode(secret), totpStep(new Date()));
    const enable = await call(app, editor, "POST", "/api/v1/auth/totp/enable", {
      code,
    });
    expect(enable.statusCode).toBe(200);
    const token = await call(app, editor, "POST", "/api/v1/tokens", {
      name: "mine",
      role: "viewer",
    });
    expect(token.statusCode).toBe(201);
    const tokenValue = token.json<{ token: string }>().token;
    // Everything a leak would need, read from the database itself.
    const sqlite = app.ctx.store.sqlite;
    const collect = (query: string, ...params: unknown[]): string[] => {
      const rows: unknown[] = sqlite.prepare(query).all(...params);
      return rows.map((row) => {
        const record = row as Record<string, unknown>;
        return String(record["value"]);
      });
    };
    const userId = editor.userId;
    const secrets = [
      ...collect(
        'SELECT password_hash AS value FROM "users" WHERE id = ?',
        userId,
      ),
      ...collect(
        'SELECT totp_secret_enc AS value FROM "users" WHERE id = ?',
        userId,
      ),
      ...collect(
        'SELECT id AS value FROM "sessions" WHERE user_id = ?',
        userId,
      ),
      ...collect(
        'SELECT csrf_token AS value FROM "sessions" WHERE user_id = ?',
        userId,
      ),
      ...collect(
        'SELECT code_hash AS value FROM "recovery_codes" WHERE user_id = ?',
        userId,
      ),
      ...collect(
        'SELECT token_hash AS value FROM "api_tokens" WHERE user_id = ?',
        userId,
      ),
      ...collect('SELECT token_hash AS value FROM "invitations"'),
      String(app.ctx.config.envLicence),
      secret,
      tokenValue,
    ].filter((value) => value !== "null" && value !== "");
    expect(secrets.length).toBeGreaterThan(8);
    const response = await call(app, editor, "GET", "/api/v1/me/export");
    expect(response.statusCode).toBe(200);
    for (const value of secrets) {
      expect(response.body).not.toContain(value);
    }
  });

  it("P-03 lets only the owner export another person", async () => {
    const t = await fixture();
    const { app, admin, editor, owner } = t;
    const ofA = `/api/v1/users/${admin.userId}/export`;
    const ofO = `/api/v1/users/${owner.userId}/export`;
    const ofE = `/api/v1/users/${editor.userId}/export`;
    const byEditor = await call(app, editor, "GET", ofA);
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toEqual({ error: "forbidden" });
    const byAdmin = await call(app, admin, "GET", ofO);
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toEqual({ error: "cannot_change_owner" });
    const byOwner = await call(app, owner, "GET", ofE);
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.body).toContain(editor.email);
  });
});
