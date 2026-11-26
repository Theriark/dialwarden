// The notification channel API (dev-work-plan P9-B) on a test app: the
// channel routes and their masking, the secrets encrypted at rest, delivery
// of C6 rows with the change chips, the send test, the in-app
// notifications and who sees them, the roles (owner and admin configure,
// editor and viewer cannot), Free (402, stored, nothing sent) and back to
// Paid, the log lines (a code, never the URL) and the address checks when
// the admin saves a channel. The webhook and Discord receivers are a server
// in the test process (simulated answers, test/http-sink.ts).
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { notificationChannels } from "../db/schema.js";
import { headersOf, setupOwner, type SignedIn } from "../../test/helpers.js";
import { startHttpSink, type HttpSink } from "../../test/http-sink.js";
import { apiOf, apply, draft } from "../../test/servers.js";
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
import type { ChannelView } from "./channels.js";

const CHANNELS = "/api/v1/notifications/channels";
const LOOPBACK = { allowLoopback: true, allowHttp: true };
/** The secret part of a webhook URL; it must never come back. */
const TOKEN = `tok-${randomBytes(12).toString("hex")}`;

let sink: HttpSink;
let fixture: TeamFixture;
let lines: string[];

function logStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
}

function webhookInput(extra: Record<string, unknown> = {}) {
  return {
    name: "Ops webhook",
    enabled: true,
    types: ["change.applied", "backup.done", "drift.detected"],
    settings: {
      kind: "webhook",
      url: `${sink.base}/hooks/${TOKEN}?team=ops`,
      signingSecret: randomBytes(24).toString("base64url"),
      allowPrivateHost: false,
      ...extra,
    },
  };
}

async function create(user: SignedIn, payload: object): Promise<ChannelView> {
  const response = await call(fixture.app, user, "POST", CHANNELS, payload);
  if (response.statusCode !== 201) {
    throw new Error(`create: ${response.statusCode} ${response.body}`);
  }
  return response.json<ChannelView>();
}

async function removeAll(): Promise<void> {
  const { app, owner } = fixture;
  for (const channel of app.ctx.channels.list()) {
    await call(app, owner, "DELETE", `${CHANNELS}/${channel.id}`);
  }
}

beforeAll(async () => {
  sink = await startHttpSink();
  lines = [];
  fixture = await teamFixture({
    notificationNetwork: LOOPBACK,
    extraEnv: { LOG_LEVEL: "info" },
    logStream: logStream(),
  });
});

afterAll(async () => {
  await fixture.current.close();
  await sink.close();
});

beforeEach(() => {
  sink.received.length = 0;
});

afterEach(async () => {
  await fixture.app.ctx.notifications.idle();
  await removeAll();
});

describe("channel configuration", () => {
  it("masks the URL and secret in every answer", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, webhookInput());
    expect(made.settings).toEqual({
      kind: "webhook",
      url: `http://127.0.0.1:${String(sink.port)}/***`,
      host: `127.0.0.1:${String(sink.port)}`,
      hasSigningSecret: true,
      allowPrivateHost: false,
    });
    const answers = [
      await call(app, owner, "GET", CHANNELS),
      await call(app, owner, "GET", `${CHANNELS}/${made.id}`),
    ];
    for (const answer of answers) {
      expect(answer.statusCode).toBe(200);
      expect(answer.body).not.toContain(TOKEN);
      expect(answer.body).not.toContain("team=ops");
    }
  });

  it("stores the URL and the secrets encrypted with APP_SECRET_KEY", async () => {
    const { app, owner } = fixture;
    const input = webhookInput();
    const made = await create(owner, input);
    const row = app.ctx.store.db
      .select()
      .from(notificationChannels)
      .all()
      .find((item) => item.id === made.id);
    expect(row?.secretEnc).toMatch(/^dwenc1\./);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(input.settings.signingSecret);
  });

  it("keeps the stored URL when the masked value comes back, and removes a secret", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, webhookInput());
    const updated = await call(app, owner, "PUT", `${CHANNELS}/${made.id}`, {
      name: "Renamed",
      enabled: true,
      types: ["backup.done"],
      settings: {
        kind: "webhook",
        url: made.settings.kind === "webhook" ? made.settings.url : "",
        signingSecret: null,
        allowPrivateHost: false,
      },
    });
    expect(updated.statusCode).toBe(200);
    const view = updated.json<ChannelView>();
    expect(view.name).toBe("Renamed");
    expect(view.types).toEqual(["backup.done"]);
    expect(view.settings).toMatchObject({ hasSigningSecret: false });
    const test = await call(app, owner, "POST", `${CHANNELS}/${made.id}/test`);
    expect(test.json()).toEqual({ ok: true, error: null });
    expect(sink.received[0]?.path).toBe(`/hooks/${TOKEN}?team=ops`);
    expect(sink.received[0]?.headers["x-dialwarden-signature"]).toBeUndefined();
  });

  it("refuses a change of kind, a missing URL and a second in-app channel", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, webhookInput());
    const kind = await call(app, owner, "PUT", `${CHANNELS}/${made.id}`, {
      name: "x",
      enabled: true,
      types: ["backup.done"],
      settings: { kind: "in_app" },
    });
    expect(kind.statusCode).toBe(422);
    expect(kind.json()).toEqual({ error: "kind_immutable" });
    const noUrl = await call(app, owner, "POST", CHANNELS, {
      name: "x",
      enabled: true,
      types: ["backup.done"],
      settings: { kind: "discord", allowPrivateHost: false },
    });
    expect(noUrl.statusCode).toBe(422);
    expect(noUrl.json()).toEqual({ error: "url_required" });
    const inApp = { name: "Bell", enabled: true, types: ["backup.done"] };
    await create(owner, { ...inApp, settings: { kind: "in_app" } });
    const second = await call(app, owner, "POST", CHANNELS, {
      ...inApp,
      settings: { kind: "in_app" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "in_app_exists" });
  });

  it("deletes a channel", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, webhookInput());
    const gone = await call(app, owner, "DELETE", `${CHANNELS}/${made.id}`);
    expect(gone.statusCode).toBe(204);
    const missing = await call(app, owner, "GET", `${CHANNELS}/${made.id}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "channel_not_found" });
    app.ctx.activity.record("backup.done", { data: { id: "b-1" } });
    await app.ctx.notifications.idle();
    expect(sink.received).toEqual([]);
  });
});

describe("roles", () => {
  it("lets owner and admin configure and test; editor and viewer cannot", async () => {
    const { app, admin, editor, viewer, owner } = fixture;
    const made = await create(admin, webhookInput());
    expect(made.kind).toBe("webhook");
    for (const user of [editor, viewer]) {
      const routes: ["GET" | "POST" | "PUT" | "DELETE", string, object?][] = [
        ["GET", CHANNELS],
        ["POST", CHANNELS, webhookInput()],
        ["GET", `${CHANNELS}/${made.id}`],
        ["PUT", `${CHANNELS}/${made.id}`, webhookInput()],
        ["DELETE", `${CHANNELS}/${made.id}`],
        ["POST", `${CHANNELS}/${made.id}/test`],
      ];
      for (const [method, url, payload] of routes) {
        const answer = await call(app, user, method, url, payload);
        expect(answer.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect(sink.received).toEqual([]);
    const byOwner = await call(
      app,
      owner,
      "POST",
      `${CHANNELS}/${made.id}/test`,
    );
    expect(byOwner.json()).toEqual({ ok: true, error: null });
  });
});

describe("delivery", () => {
  it("delivers a change.applied row with its chips as text", async () => {
    const { app, owner, servers } = fixture;
    await create(owner, webhookInput());
    const api = apiOf(app, owner);
    const made = await draft(api, servers.a, { [INT_SETTING]: 17 });
    await apply(api, made.id);
    await app.ctx.notifications.idle();
    const bodies = sink.received.map(
      (r) => JSON.parse(r.body) as Record<string, unknown>,
    );
    const applied = bodies.find(
      (b) =>
        (b["event"] as { type?: string } | null)?.type === "change.applied",
    );
    expect(applied).toMatchObject({
      version: 1,
      kind: "event",
      server: { id: servers.a },
      event: { serverId: servers.a, data: { changeSetId: made.id } },
    });
    expect(String(applied?.["title"])).toMatch(/^Change applied on /);
    expect(applied?.["lines"]).toEqual([
      "Player slots: 32 to 17 (restart required)",
    ]);
  });

  it("delivers only the types a channel names, and nothing while disabled", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, {
      ...webhookInput(),
      types: ["backup.failed"],
    });
    app.ctx.activity.record("backup.done", { data: { id: "b-2" } });
    app.ctx.activity.record("backup.failed", { data: { reason: "disk" } });
    await app.ctx.notifications.idle();
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]?.headers["x-dialwarden-event"]).toBe(
      "backup.failed",
    );
    const off = await call(app, owner, "PUT", `${CHANNELS}/${made.id}`, {
      ...webhookInput(),
      enabled: false,
      types: ["backup.failed"],
    });
    expect(off.statusCode).toBe(200);
    app.ctx.activity.record("backup.failed", { data: { reason: "disk" } });
    await app.ctx.notifications.idle();
    expect(sink.received).toHaveLength(1);
  });

  it("stores a failure as a code and logs it without the URL", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, webhookInput());
    sink.script({ status: 404, body: `no hook ${TOKEN}` });
    const test = await call(app, owner, "POST", `${CHANNELS}/${made.id}/test`);
    expect(test.json()).toEqual({ ok: false, error: "http_404" });
    const view = (
      await call(app, owner, "GET", `${CHANNELS}/${made.id}`)
    ).json<ChannelView>();
    expect(view).toMatchObject({
      lastResult: "failed",
      lastError: "http_404",
      failures: 1,
    });
    const failed = lines.filter((l) =>
      l.includes("notification delivery failed"),
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.join("")).toContain('"code":"http_404"');
    expect(lines.join("")).not.toContain(TOKEN);
  });

  // Code review L1: an edit keeps the channel's queue, so deliveries that
  // wait across it go out once each and in event order.
  it("keeps event order across an edit", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, {
      ...webhookInput(),
      types: ["backup.done"],
    });
    const ids = [1, 2, 3].map(
      (n) => app.ctx.activity.record("backup.done", { data: { n } }).id,
    );
    const edited = await call(app, owner, "PUT", `${CHANNELS}/${made.id}`, {
      ...webhookInput(),
      name: "Ops webhook, renamed",
      types: ["backup.done"],
    });
    expect(edited.statusCode).toBe(200);
    ids.push(app.ctx.activity.record("backup.done", { data: { n: 4 } }).id);
    await app.ctx.notifications.idle();
    const sent = sink.received.map(
      (r) => (JSON.parse(r.body) as { event: { id: number } }).event.id,
    );
    expect(sent).toEqual(ids);
  });

  // Code review L3: the send test runs beside the queue, one at a time.
  it("runs one send test at a time per channel", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, webhookInput());
    // The first try fails with 503, so the first test waits for its retry.
    sink.script({ status: 503 });
    const url = `${CHANNELS}/${made.id}/test`;
    const first = call(app, owner, "POST", url).then((r) => r);
    for (let i = 0; i < 200 && sink.received.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = await call(app, owner, "POST", url);
    expect(second.json()).toEqual({ ok: false, error: "test_running" });
    expect((await first).json()).toEqual({ ok: true, error: null });
  });

  it("sends a Discord test message to the configured webhook", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, {
      name: "Discord",
      enabled: true,
      types: ["change.applied"],
      settings: {
        kind: "discord",
        url: `${sink.base}/api/webhooks/123/${TOKEN}`,
        allowPrivateHost: false,
      },
    });
    expect(made.settings).toMatchObject({
      url: `http://127.0.0.1:${String(sink.port)}/***`,
    });
    const test = await call(app, owner, "POST", `${CHANNELS}/${made.id}/test`);
    expect(test.json()).toEqual({ ok: true, error: null });
    const sent = JSON.parse(sink.received[0]?.body ?? "{}") as {
      content: string;
    };
    expect(sent.content).toMatch(/^\*\*Test message from Dialwarden\*\*/);
  });
});

describe("Free plan", () => {
  it("answers 402, keeps the channels and sends nothing until Paid returns", async () => {
    const { app, owner } = fixture;
    const made = await create(owner, webhookInput());
    await toFree(app, owner);
    try {
      const routes: ["GET" | "POST", string][] = [
        ["GET", CHANNELS],
        ["GET", `${CHANNELS}/${made.id}`],
        ["POST", `${CHANNELS}/${made.id}/test`],
        ["GET", "/api/v1/notifications"],
      ];
      for (const [method, url] of routes) {
        const answer = await call(app, owner, method, url);
        expect(answer.statusCode, url).toBe(402);
        expect(answer.json(), url).toEqual({
          error: "payment_required",
          plan: "free",
          feature: "notifications",
        });
      }
      app.ctx.activity.record("backup.done", { data: { id: "b-3" } });
      await app.ctx.notifications.idle();
      expect(sink.received).toEqual([]);
      expect(app.ctx.channels.list().map((c) => c.id)).toEqual([made.id]);
    } finally {
      await toPaid(app, owner);
    }
    app.ctx.activity.record("backup.done", { data: { id: "b-4" } });
    await app.ctx.notifications.idle();
    expect(sink.received).toHaveLength(1);
  });
});

describe("in-app notifications", () => {
  it("shows each user the rows of their servers and counts unread per user", async () => {
    const { app, owner, viewer, loner, servers } = fixture;
    await create(owner, {
      name: "Bell",
      enabled: true,
      types: ["backup.done", "drift.detected"],
      settings: { kind: "in_app" },
    });
    app.ctx.activity.record("backup.done", { data: { id: "b-5" } });
    app.ctx.activity.record("drift.detected", {
      serverId: servers.a,
      data: { via: "background" },
    });
    app.ctx.activity.record("drift.detected", { serverId: servers.b });
    await app.ctx.notifications.idle();
    const read = async (user: SignedIn) =>
      (await call(app, user, "GET", "/api/v1/notifications")).json<{
        items: { title: string; serverId: string | null; lines: string[] }[];
        unread: number;
      }>();
    const mine = await read(owner);
    expect(mine.items).toHaveLength(3);
    expect(mine.unread).toBe(3);
    expect(mine.items[1]?.title).toMatch(/^Outside edit detected on /);
    expect(mine.items[1]?.lines).toContain("Found by: background");
    const theirs = await read(viewer);
    expect(theirs.items.map((i) => i.serverId)).toEqual([servers.a]);
    expect((await read(loner)).items).toEqual([]);
    const newest = (
      await call(app, owner, "GET", "/api/v1/notifications?limit=1")
    ).json<{ items: { id: number }[]; nextBefore: number | null }>();
    expect(newest.nextBefore).not.toBeNull();
    const marked = await call(
      app,
      owner,
      "POST",
      "/api/v1/notifications/read",
      {
        upTo: newest.items[0]?.id ?? 0,
      },
    );
    expect(marked.json()).toEqual({ unread: 0 });
    expect((await read(viewer)).unread).toBe(1);
  });

  // Code review M1: the inbox names the actor by id (D7), so erasing a user
  // leaves no e-mail address behind.
  it("stops showing an erased user's address", async () => {
    const { app, owner } = fixture;
    await create(owner, {
      name: "Bell",
      enabled: true,
      types: ["backup.done"],
      settings: { kind: "in_app" },
    });
    const gone = await inviteAndAccept(app, owner, "editor", [], "gone");
    app.ctx.activity.record("backup.done", {
      actor: gone.userId,
      data: { id: "b-6" },
    });
    await app.ctx.notifications.idle();
    const read = async () =>
      (await call(app, owner, "GET", "/api/v1/notifications")).body;
    expect(await read()).toContain(`By ${gone.email}, `);
    const stored = app.ctx.store.sqlite
      .prepare("SELECT actor, lines FROM notification_inbox")
      .all() as { actor: string | null; lines: string }[];
    expect(stored).toEqual([{ actor: gone.userId, lines: "[]" }]);
    const erased = await call(
      app,
      owner,
      "DELETE",
      `/api/v1/users/${gone.userId}`,
    );
    expect(erased.statusCode).toBe(204);
    expect(await read()).not.toContain(gone.email);
  });
});

describe("exports and the audit log", () => {
  it("never carry the webhook URL", async () => {
    const { app, owner } = fixture;
    await create(owner, webhookInput());
    for (const url of ["/api/v1/me/export", "/api/v1/audit/export.csv"]) {
      const answer = await call(app, owner, "GET", url);
      expect(answer.statusCode, url).toBe(200);
      expect(answer.body, url).not.toContain(TOKEN);
    }
  });
});

describe("address checks when saving (SSRF)", () => {
  it("refuses http, credentials and internal addresses without the test seam", async () => {
    const strict = await paidApp();
    try {
      const owner = await setupOwner(strict.app);
      const post = (settings: object) =>
        strict.app.inject({
          method: "POST",
          url: CHANNELS,
          headers: headersOf(owner),
          payload: {
            name: "x",
            enabled: true,
            types: ["backup.done"],
            settings,
          },
        });
      const refused = [
        "http://hooks.example.test/h",
        "https://user:pw@hooks.example.test/h",
        "https://127.0.0.1/h",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/h",
        "https://10.0.0.5/h",
      ];
      for (const url of refused) {
        const answer = await post({
          kind: "discord",
          url,
          allowPrivateHost: false,
        });
        expect(answer.statusCode, url).toBe(422);
        expect(answer.json<{ error: string }>().error, url).toBe("url_refused");
      }
      const lan = await post({
        kind: "webhook",
        url: "https://10.0.0.5/h",
        allowPrivateHost: true,
      });
      expect(lan.statusCode).toBe(201);
      const metadata = await post({
        kind: "webhook",
        url: "https://169.254.169.254/h",
        allowPrivateHost: true,
      });
      expect(metadata.statusCode).toBe(422);
      const smtp = await post({
        kind: "smtp",
        host: "127.0.0.1",
        port: 587,
        security: "starttls",
        username: null,
        from: "dialwarden@dialwarden.test",
        to: ["ops@dialwarden.test"],
        allowPrivateHost: true,
      });
      expect(smtp.statusCode).toBe(422);
      expect(smtp.json<{ error: string }>().error).toBe("host_refused");
    } finally {
      await strict.close();
    }
  });
});
