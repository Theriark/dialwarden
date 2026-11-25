// Privacy retention (dev-work-plan P8-A step 7; p8-threat-specs P-07 to
// P-11): the settings work on every plan, the newest snapshot of a file and
// everything a pending change set or a draft restore still needs stay, a
// blob file goes only when no snapshot row names it, the app backup folder is
// never touched, and none of the link or token values ever reaches the log.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { setupOwner, type TestApp } from "../../test/helpers.js";
import {
  call,
  INT_SETTING,
  inviteAndAccept,
  paidApp,
  teamFixture,
  toFree,
  type TeamFixture,
} from "../../test/team.js";

const DAY_MS = 86_400_000;

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function fixture(
  options: Parameters<typeof teamFixture>[0] = {},
): Promise<TeamFixture> {
  const made = await teamFixture(options);
  current = made.current;
  return made;
}

const changesUrl = (t: TeamFixture) =>
  `/api/v1/servers/${t.servers.a}/change-sets`;

async function applyValue(t: TeamFixture, value: number): Promise<void> {
  const { app, owner } = t;
  const made = await call(app, owner, "POST", changesUrl(t), {
    edits: [{ settingKey: INT_SETTING, value }],
  });
  expect(made.statusCode).toBe(201);
  const applied = await call(
    app,
    owner,
    "POST",
    `/api/v1/change-sets/${made.json<{ id: string }>().id}/apply`,
    {},
  );
  expect(applied.statusCode).toBe(200);
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listing(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

interface SnapshotRow {
  id: string;
  sha256: string;
  kind: string;
  at: string;
}

const rowsOf = (t: TeamFixture): SnapshotRow[] =>
  t.app.ctx.store.sqlite
    .prepare('SELECT * FROM "snapshots"')
    .all() as SnapshotRow[];

describe("privacy retention (P-07 to P-11)", () => {
  it("P-07 works on the Free plan", async () => {
    const t = await fixture();
    const { app, owner, editor } = t;
    const other = await inviteAndAccept(app, owner, "viewer");
    await toFree(app, owner);
    const codes = [
      await call(app, owner, "DELETE", `/api/v1/users/${editor.userId}`),
      await call(
        app,
        owner,
        "POST",
        `/api/v1/users/${other.userId}/anonymise`,
      ),
      await call(app, owner, "GET", `/api/v1/users/${other.userId}/export`),
      await call(app, owner, "PUT", "/api/v1/settings/snapshots", {
        snapshotRetention: { mode: "days", days: 30 },
      }),
      await call(app, owner, "PUT", "/api/v1/settings/audit", {
        retentionDays: 90,
      }),
    ];
    expect(codes.map((response) => response.statusCode)).toEqual([
      204,
      200,
      200,
      200,
      200,
    ]);
  });

  it("P-08 keeps the newest snapshot of a file", async () => {
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const t = await fixture({ now: () => new Date(clock) });
    const { app, owner } = t;
    await applyValue(t, 10);
    const before = rowsOf(t);
    expect(before.length).toBeGreaterThan(0);
    clock += 31 * DAY_MS;
    const url = "/api/v1/settings/snapshots";
    const days = await call(app, owner, "PUT", url, {
      snapshotRetention: { mode: "days", days: 1 },
    });
    expect(days.statusCode).toBe(200);
    await t.app.ctx.retention.pruneSnapshots();
    expect(rowsOf(t)).toEqual(before);
    const versions = await call(app, owner, "PUT", url, {
      snapshotRetention: { mode: "versions", versions: 1 },
    });
    expect(versions.statusCode).toBe(200);
    await t.app.ctx.retention.pruneSnapshots();
    expect(rowsOf(t)).toEqual(before);
    for (const body of [
      { snapshotRetention: { mode: "days", days: 0 } },
      { snapshotRetention: { mode: "versions", versions: 0 } },
      { snapshotRetention: { mode: "days", days: -1 } },
    ]) {
      const refused = await call(app, owner, "PUT", url, body);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: "validation" });
    }
  });

  it("P-09 keeps what is in use and deletes only orphan blobs", async () => {
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const t = await fixture({ now: () => new Date(clock) });
    const { app, owner } = t;
    await applyValue(t, 10);
    await applyValue(t, 20);
    const rows = rowsOf(t);
    const target = rows.find((row) => row.kind === "after");
    if (target === undefined) throw new Error("no after snapshot");
    const restore = await call(
      app,
      owner,
      "POST",
      `/api/v1/snapshots/${target.id}/restore`,
    );
    expect(restore.statusCode).toBe(200);
    const backups = join(t.current.dataDir, "backups");
    const backupsBefore = await listing(backups);
    clock += 31 * DAY_MS;
    await call(app, owner, "PUT", "/api/v1/settings/snapshots", {
      snapshotRetention: { mode: "days", days: 1 },
    });
    const blobs = [...new Set(rows.map((row) => row.sha256))].map(
      (sha256) => ({
        sha256,
        path: t.app.ctx.snapshots.pathOf(sha256),
      }),
    );
    for (const blob of blobs) {
      expect(await exists(blob.path)).toBe(true);
    }
    const report = await t.app.ctx.retention.pruneSnapshots();
    expect(report.rows).toBeGreaterThan(0);
    // The newest snapshot of the file and the draft-restore target stay.
    const kept = rowsOf(t);
    expect(kept.map((row) => row.id)).toContain(target.id);
    const keptHashes = new Set(kept.map((row) => row.sha256));
    expect(keptHashes.has(target.sha256)).toBe(true);
    for (const blob of blobs) {
      expect(await exists(blob.path), blob.sha256).toBe(
        keptHashes.has(blob.sha256),
      );
    }
    const meter = t.app.ctx.store.sqlite
      .prepare('SELECT * FROM "snapshot_blobs"')
      .all() as { sha256: string }[];
    for (const row of meter) {
      expect(keptHashes.has(row.sha256)).toBe(true);
    }
    expect(await listing(backups)).toEqual(backupsBefore);
  });

  it("P-10 keeps the retention settings to the owner and admins", async () => {
    const t = await fixture();
    const body = { snapshotRetention: { mode: "days", days: 30 } };
    for (const user of [t.editor, t.viewer]) {
      const response = await call(
        t.app,
        user,
        "PUT",
        "/api/v1/settings/snapshots",
        body,
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden" });
    }
  });

  it("P-11 keeps every link and token value out of the log", async () => {
    const lines: string[] = [];
    current = await paidApp({
      logStream: new Writable({
        write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
          lines.push(String(chunk));
          done();
        },
      }),
      extraEnv: { LOG_LEVEL: "info" },
    });
    const app = current.app;
    const owner = await setupOwner(app);
    const invite = await call(app, owner, "POST", "/api/v1/invitations", {
      email: "retention-p11@dialwarden.test",
      role: "viewer",
    });
    expect(invite.statusCode).toBe(201);
    const invitationToken = invite.json<{ token: string }>().token;
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: {
        token: invitationToken,
        name: "retention",
        password: "p11-password-730141",
      },
    });
    expect(accepted.statusCode).toBe(201);
    const viewerId = accepted.json<{ user: { id: string } }>().user.id;
    const token = await call(app, owner, "POST", "/api/v1/tokens", {
      name: "logged",
      role: "viewer",
    });
    expect(token.statusCode).toBe(201);
    const tokenValue = token.json<{ token: string }>().token;
    const reset = await call(
      app,
      owner,
      "POST",
      `/api/v1/users/${viewerId}/password-reset`,
    );
    expect(reset.statusCode).toBe(201);
    const resetToken = reset.json<{ token: string }>().token;
    const used = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset",
      payload: { token: resetToken, password: "p11-new-password-730141" },
    });
    expect(used.statusCode).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(invitationToken);
      expect(line).not.toContain(tokenValue);
      expect(line).not.toContain(resetToken);
      expect(line).not.toContain("p11-password-730141");
      expect(line).not.toContain(owner.password);
    }
  });
});
