// Invitation links (dev-work-plan P8-A step 2; p8-threat-specs I-01 to
// I-16): single use, 72 hours, only the hash stored, the value never in a
// URL the server sees, one 410 for every refusal, the users limit on Free.
import { createHash, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { invitations, users } from "../db/schema.js";
import {
  headersOf,
  randomPassword,
  sessionCookie,
  setupOwner,
  type TestApp,
} from "../../test/helpers.js";
import {
  accept,
  call,
  invite,
  inviteAndAccept,
  paidApp,
  teamFixture,
  testEmail,
  toFree,
  toPaid,
  type TeamFixture,
} from "../../test/team.js";
import { INVITATION_TTL_MS } from "./service.js";

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

/** A log stream the test can read. */
function logSink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
      chunks.push(chunk.toString("utf8"));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

const userCount = (t: TeamFixture): number =>
  t.app.ctx.store.db.select().from(users).all().length;

async function newInvitation(
  t: TeamFixture,
  role = "editor",
): Promise<{ token: string; id: string; email: string }> {
  const email = testEmail("invitee");
  const made = await invite(t.app, t.owner, { email, role });
  expect(made.statusCode).toBe(201);
  const body = made.json<{ token: string; id: string }>();
  return { ...body, email };
}

const acceptBody = (token: string, name = "Invitee") => ({
  token,
  name,
  password: randomPassword(),
});

describe("invitations (I-01 to I-16)", () => {
  it("I-01 works once; a second accept is 410", async () => {
    const t = await fixture();
    const { token } = await newInvitation(t);
    const before = userCount(t);
    const first = await accept(t.app, acceptBody(token));
    expect(first.statusCode).toBe(201);
    expect(sessionCookie(first)).toMatch(/^dw_session=/);
    const second = await accept(t.app, acceptBody(token, "Other"));
    expect(second.statusCode).toBe(410);
    expect(second.json()).toEqual({ error: "invitation_invalid" });
    expect(userCount(t)).toBe(before + 1);
  });

  it("I-02 lets exactly one of ten parallel accepts through", async () => {
    const t = await fixture();
    const { token } = await newInvitation(t);
    const before = userCount(t);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        accept(t.app, acceptBody(token, `Racer ${String(n)}`)),
      ),
    );
    const codes = answers.map((answer) => answer.statusCode).sort();
    expect(codes).toEqual([201, 410, 410, 410, 410, 410, 410, 410, 410, 410]);
    expect(userCount(t)).toBe(before + 1);
  });

  it("I-03 expires at 72 hours", async () => {
    let now = new Date("2026-12-01T10:00:00Z");
    const app = await paidApp({ now: () => now });
    current = app;
    const owner = await setupOwner(app.app);
    const make = async () => {
      const email = testEmail("clock");
      const made = await invite(app.app, owner, { email, role: "viewer" });
      return made.json<{ token: string }>().token;
    };
    const first = await make();
    const second = await make();
    const third = await make();
    const t0 = now.getTime();
    now = new Date(t0 + INVITATION_TTL_MS - 1000);
    expect((await accept(app.app, acceptBody(second))).statusCode).toBe(201);
    now = new Date(t0 + INVITATION_TTL_MS);
    expect((await accept(app.app, acceptBody(first))).statusCode).toBe(410);
    now = new Date(t0 + INVITATION_TTL_MS + 1000);
    expect((await accept(app.app, acceptBody(third))).statusCode).toBe(410);
  });

  it("I-04 refuses guesses alike and rate-limits them per address", async () => {
    const t = await fixture();
    const { token } = await newInvitation(t);
    const near = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(32);
    const nearAnswer = await accept(t.app, acceptBody(near));
    expect(nearAnswer.statusCode).toBe(410);
    expect(nearAnswer.json()).toEqual({ error: "invitation_invalid" });
    const codes: number[] = [];
    for (let n = 0; n < 30; n += 1) {
      const guess = randomBytes(32).toString("base64url");
      codes.push((await accept(t.app, acceptBody(guess))).statusCode);
    }
    expect(codes.slice(0, 19).every((code) => code === 410)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("I-05 answers unknown, used, expired and revoked the same", async () => {
    let now = new Date("2026-12-01T10:00:00Z");
    const app = await paidApp({ now: () => now });
    current = app;
    const owner = await setupOwner(app.app);
    const make = async () => {
      const email = testEmail("same");
      const made = await invite(app.app, owner, { email, role: "viewer" });
      return made.json<{ token: string; id: string }>();
    };
    const used = await make();
    const expired = await make();
    const revoked = await make();
    expect((await accept(app.app, acceptBody(used.token))).statusCode).toBe(
      201,
    );
    const gone = await call(
      app.app,
      owner,
      "DELETE",
      `/api/v1/invitations/${revoked.id}`,
    );
    expect(gone.statusCode).toBe(204);
    now = new Date(now.getTime() + INVITATION_TTL_MS + 1000);
    const tokens = [randomBytes(32).toString("base64url"), used.token];
    tokens.push(expired.token, revoked.token);
    for (const token of tokens) {
      const answer = await accept(app.app, acceptBody(token));
      expect(answer.statusCode).toBe(410);
      expect(answer.json()).toEqual({ error: "invitation_invalid" });
    }
  });

  it("I-06 stores only the hash and never logs or lists the value", async () => {
    const log = logSink();
    const app = await paidApp({
      logStream: log.stream,
      extraEnv: { LOG_LEVEL: "info" },
    });
    current = app;
    const owner = await setupOwner(app.app);
    const email = testEmail("hash");
    const made = await invite(app.app, owner, { email, role: "editor" });
    const token = made.json<{ token: string }>().token;
    const rows = app.app.ctx.store.db.select().from(invitations).all();
    expect(JSON.stringify(rows)).not.toContain(token);
    const hash = createHash("sha256").update(token).digest("hex");
    expect(rows.map((row) => row.tokenHash)).toContain(hash);
    const list = await call(app.app, owner, "GET", "/api/v1/invitations");
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    await accept(app.app, acceptBody(token));
    expect(log.text()).not.toContain(token);
  });

  it("I-07 takes the value only from the body; the link uses BASE_URL", async () => {
    const app = await paidApp({
      extraEnv: { BASE_URL: "http://dw.example.test" },
    });
    current = app;
    const owner = await setupOwner(app.app);
    const made = await app.app.inject({
      method: "POST",
      url: "/api/v1/invitations",
      headers: { ...headersOf(owner), host: "evil.example" },
      payload: { email: testEmail("link"), role: "viewer" },
    });
    const body = made.json<{ token: string; link: string }>();
    expect(body.link).toBe(`http://dw.example.test/invite#${body.token}`);
    const inQuery = await app.app.inject({
      method: "POST",
      url: `/api/v1/invitations/accept?token=${body.token}`,
      payload: { name: "Q", password: randomPassword() },
    });
    expect(inQuery.statusCode).toBe(400);
    expect(inQuery.json()).toMatchObject({ error: "validation" });
  });

  it("I-08 refuses a role above the inviter", async () => {
    const t = await fixture();
    const asAdmin = (role: string) =>
      invite(t.app, t.admin, { email: testEmail("up"), role });
    const admin = await asAdmin("admin");
    expect(admin.statusCode).toBe(403);
    expect(admin.json()).toEqual({ error: "role_too_high" });
    expect((await asAdmin("owner")).statusCode).toBe(400);
    const body = { email: testEmail("e"), role: "viewer" };
    expect((await invite(t.app, t.editor, body)).statusCode).toBe(403);
    expect((await invite(t.app, t.viewer, body)).statusCode).toBe(403);
  });

  it("I-09 re-checks the inviter at the accept", async () => {
    const t = await fixture();
    const email = testEmail("late");
    const made = await invite(t.app, t.admin, { email, role: "editor" });
    expect(made.statusCode).toBe(201);
    const token = made.json<{ token: string }>().token;
    const demote = await call(
      t.app,
      t.owner,
      "PUT",
      `/api/v1/users/${t.admin.userId}/role`,
      { role: "viewer" },
    );
    expect(demote.statusCode).toBe(200);
    const before = userCount(t);
    expect((await accept(t.app, acceptBody(token))).statusCode).toBe(410);
    expect(userCount(t)).toBe(before);
  });

  it("I-09 refuses the accept after the inviter was deleted", async () => {
    const t = await fixture();
    const email = testEmail("orphan");
    const made = await invite(t.app, t.admin, { email, role: "viewer" });
    const token = made.json<{ token: string }>().token;
    const removed = await call(
      t.app,
      t.owner,
      "DELETE",
      `/api/v1/users/${t.admin.userId}`,
    );
    expect(removed.statusCode).toBe(204);
    expect((await accept(t.app, acceptBody(token))).statusCode).toBe(410);
  });

  it("I-10 refuses grants on unknown servers", async () => {
    const t = await fixture();
    const before = t.app.ctx.store.db.select().from(invitations).all().length;
    const made = await invite(t.app, t.admin, {
      email: testEmail("grant"),
      role: "editor",
      grants: [{ server: "demo-zz", level: "write" }],
    });
    expect(made.statusCode).toBe(422);
    expect(made.json()).toMatchObject({ error: "unknown_server" });
    const after = t.app.ctx.store.db.select().from(invitations).all().length;
    expect(after).toBe(before);
  });

  it("I-11 binds the e-mail address of the invitation", async () => {
    const t = await fixture();
    const taken = await invite(t.app, t.owner, {
      email: t.editor.email,
      role: "viewer",
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "user_exists" });
    const { token, email } = await newInvitation(t, "viewer");
    const done = await accept(t.app, {
      ...acceptBody(token),
      email: "o2@dialwarden.test",
    });
    expect(done.statusCode).toBe(201);
    expect(done.json<{ user: { email: string } }>().user.email).toBe(email);
  });

  it("I-12 makes no invitation on Free", async () => {
    const t = await fixture();
    await toFree(t.app, t.owner);
    const made = await invite(t.app, t.owner, {
      email: testEmail("free"),
      role: "viewer",
    });
    expect(made.statusCode).toBe(402);
    expect(made.json()).toEqual({
      error: "payment_required",
      plan: "free",
      feature: "team.users",
    });
  });

  it("I-13 checks the users limit at the accept", async () => {
    const app = await paidApp();
    current = app;
    const owner = await setupOwner(app.app);
    const email = testEmail("limit");
    const made = await invite(app.app, owner, { email, role: "viewer" });
    const token = made.json<{ token: string }>().token;
    await toFree(app.app, owner);
    const refused = await accept(app.app, acceptBody(token));
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toEqual({
      error: "payment_required",
      plan: "free",
      limit: "users",
      current: 1,
      max: 1,
    });
    const rows = app.app.ctx.store.db.select().from(invitations).all();
    expect(rows.every((row) => row.usedAt === null)).toBe(true);
    await toPaid(app.app, owner);
    expect((await accept(app.app, acceptBody(token))).statusCode).toBe(201);
  });

  it("I-14 revokes an invitation; an editor cannot", async () => {
    const t = await fixture();
    const { token, id } = await newInvitation(t);
    const byEditor = await call(
      t.app,
      t.editor,
      "DELETE",
      `/api/v1/invitations/${id}`,
    );
    expect(byEditor.statusCode).toBe(403);
    const gone = await call(
      t.app,
      t.owner,
      "DELETE",
      `/api/v1/invitations/${id}`,
    );
    expect(gone.statusCode).toBe(204);
    expect((await accept(t.app, acceptBody(token))).statusCode).toBe(410);
  });

  it("I-15 starts a new session and ends the one the browser held", async () => {
    const t = await fixture();
    const { token } = await newInvitation(t);
    const noCsrf = await accept(t.app, acceptBody(token), {
      cookie: t.viewer.cookie,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toEqual({ error: "csrf" });
    const done = await accept(t.app, acceptBody(token), headersOf(t.viewer));
    expect(done.statusCode).toBe(201);
    expect(sessionCookie(done)).not.toBe(t.viewer.cookie);
    const old = await call(t.app, t.viewer, "GET", "/api/v1/auth/session");
    expect(old.statusCode).toBe(401);
  });

  it("I-16 refuses cross-site form and text bodies", async () => {
    const t = await fixture();
    const { token } = await newInvitation(t);
    const form = await t.app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${token}&name=F&password=${randomPassword()}`,
    });
    expect(form.statusCode).toBe(415);
    expect(form.json()).toEqual({ error: "fst_err_ctp_invalid_media_type" });
    const text = await t.app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(acceptBody(token)),
    });
    expect(text.statusCode).toBe(400);
    expect(form.headers["set-cookie"]).toBeUndefined();
    expect(text.headers["set-cookie"]).toBeUndefined();
    const hash = createHash("sha256").update(token).digest("hex");
    const rows = t.app.ctx.store.db.select().from(invitations).all();
    const row = rows.find((item) => item.tokenHash === hash);
    expect(row?.usedAt).toBeNull();
  });

  it("makes users through the invite path with their grants", async () => {
    const t = await fixture();
    const made = await inviteAndAccept(t.app, t.owner, "editor", [
      { server: t.servers.b, level: "write" },
    ]);
    const url = `/api/v1/users/${made.userId}`;
    const view = await call(t.app, t.owner, "GET", url);
    expect(view.json()).toMatchObject({
      role: "editor",
      effectiveRole: "editor",
      grants: [{ server: t.servers.b, level: "write" }],
    });
  });
});
