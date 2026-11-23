// Change sets, the write path and history (dev-work-plan P4-B steps 2 to 4,
// contract C5, rnd-report-1 2.7) on a Palworld server folder made from the
// pack's synthetic fixtures: a write changes only the target bytes; an
// outside edit between read and write gives a merge or a conflict, never a
// lost edit; the state machine with conflict and reverted; serverEvaluated
// rules on the real stored values; and the Free history cap.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { customerLicence } from "@dialwarden/entitlement/testing";
import { SECRET_MASK } from "@dialwarden/packs-schema";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setupOwner,
  tempDir,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import {
  addServer,
  apiOf,
  apply,
  change,
  draft,
  editOutside,
  fileText,
  history,
  palworldFolder,
  PALWORLD_SETTINGS,
  type Api,
  type ChangeSetBody,
} from "../../test/servers.js";
import { canMove, CHANGE_SET_STATUSES, isApplicable } from "./types.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

let current: TestApp | undefined;
let base: string;

beforeEach(async () => {
  base = await tempDir("dialwarden-changes-");
});

afterEach(async () => {
  await current?.close();
  current = undefined;
  await rm(base, { recursive: true, force: true });
});

interface Palworld {
  app: FastifyInstance;
  api: Api;
  root: string;
  slug: string;
}

/** A test app with a signed-in owner and one Palworld server. */
async function palworld(): Promise<Palworld> {
  current = await testApp();
  const api = apiOf(current.app, await setupOwner(current.app));
  const root = await palworldFolder(base);
  const slug = await addServer(api, "Lighthouse", root);
  return { app: current.app, api, root, slug };
}

const settingsText = (root: string) => fileText(root, PALWORLD_SETTINGS);

/** Replaces text in the Palworld settings file, as an outside editor. */
const outside = (root: string, from: string, to: string) =>
  editOutside(root, PALWORLD_SETTINGS, from, to);

async function values(api: Api, slug: string) {
  const response = await api.get(`/api/v1/servers/${slug}/settings`);
  return response.json<{ values: Record<string, unknown> }>().values;
}

/** Posts a raw file patch of the settings file. */
async function patch(api: Api, slug: string, text: string) {
  const url = `/api/v1/servers/${slug}/change-sets`;
  const patches = [{ fileId: "settings", text }];
  return (await api.post(url, { patches })).json<ChangeSetBody>();
}

describe("change sets (contract C5)", () => {
  it("makes a draft with its diff, then writes only the target bytes", async () => {
    const { api, root, slug } = await palworld();
    const before = await settingsText(root);
    const made = await draft(api, slug, { ExpRate: 2 });
    expect(made).toMatchObject({
      status: "draft",
      cause: "app",
      conflict: null,
      error: null,
    });
    expect(made.diff.semantic).toEqual([
      {
        kind: "changed",
        fileId: "settings",
        settingKey: "ExpRate",
        label: "Experience rate",
        from: 1,
        to: 2,
        restartRequired: true,
      },
    ]);
    const [text] = made.diff.text;
    expect(text?.fileId).toBe("settings");
    expect(text?.unifiedDiff).toContain("+++ b/settings");
    expect(await settingsText(root)).toBe(before);

    const done = await apply(api, made.id);
    expect(done.status).toBe("applied");
    const after = await settingsText(root);
    const rate = /ExpRate=[0-9.]+/;
    expect(after).not.toBe(before);
    expect(after.replace(rate, "")).toBe(before.replace(rate, ""));
    expect(await values(api, slug)).toMatchObject({ ExpRate: 2 });
  });

  it("shows secrets masked and the raw file to the owner", async () => {
    const { api, slug } = await palworld();
    const admin = `admin-${randomUUID()}`;
    await change(api, slug, { AdminPassword: admin });
    expect(await values(api, slug)).toMatchObject({
      AdminPassword: SECRET_MASK,
      ServerPassword: "",
      ExpRate: 1,
    });
    const raw = await api.get(`/api/v1/servers/${slug}/files/settings`);
    expect(raw.json()).toMatchObject({
      fileId: "settings",
      path: PALWORLD_SETTINGS,
      exists: true,
      lint: [],
    });
    expect(raw.json<{ text: string }>().text).toContain(admin);
    const missing = await api.get(`/api/v1/servers/${slug}/files/nope`);
    expect(missing.statusCode).toBe(404);
  });

  it("records an outside edit on read once, with cause external", async () => {
    const { api, root, slug } = await palworld();
    await outside(root, "ServerPlayerMaxNum=32", "ServerPlayerMaxNum=40");
    expect(await values(api, slug)).toMatchObject({ ServerPlayerMaxNum: 40 });
    await values(api, slug);
    const past = await history(api, slug);
    expect(past.entries.map((entry) => entry.cause)).toEqual([
      "external",
      "import",
    ]);
    const [edit] = past.entries;
    expect(edit).toMatchObject({
      author: "outside the app",
      status: "applied",
    });
    expect(edit?.chips).toEqual([
      expect.objectContaining({
        settingKey: "ServerPlayerMaxNum",
        from: 32,
        to: 40,
      }),
    ]);
    expect(edit?.snapshots.map((snapshot) => snapshot.kind)).toEqual([
      "external",
    ]);
    const events = await api.get("/api/v1/activity?type=drift.detected");
    expect(events.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it("refuses unknown settings and files, and change sets that change nothing", async () => {
    const { api, slug } = await palworld();
    const url = `/api/v1/servers/${slug}/change-sets`;
    const post = (body: object) => api.post(url, body);
    const unknown = await post({ edits: [{ settingKey: "Nope", value: 1 }] });
    expect(unknown.json()).toEqual({
      error: "unknown_setting",
      keys: ["Nope"],
    });
    const file = await post({ patches: [{ fileId: "nope", text: "x" }] });
    expect(file.json()).toEqual({ error: "unknown_file", fileId: "nope" });
    const both = await post({
      edits: [{ settingKey: "ExpRate", value: 2 }],
      patches: [{ fileId: "settings", text: "x" }],
    });
    expect(both.json()).toEqual({ error: "edits_or_patches" });
    const twice = await post({
      edits: [
        { settingKey: "ExpRate", value: 2 },
        { settingKey: "ExpRate", value: 3 },
      ],
    });
    expect(twice.json()).toEqual({ error: "duplicate_setting" });
    const empty = [
      {},
      { edits: [{ settingKey: "ExpRate", value: 1 }] },
      { edits: [{ settingKey: "AdminPassword", value: SECRET_MASK }] },
    ];
    for (const body of empty) {
      const nothing = await post(body);
      expect(nothing.statusCode).toBe(422);
      expect(nothing.json()).toEqual({ error: "no_change" });
    }
  });
});

describe("the write path (rnd-report-1 2.7)", () => {
  it("merges an outside edit of another setting made between read and write", async () => {
    const { app, api, root, slug } = await palworld();
    const made = await draft(api, slug, { ExpRate: 2 });
    let edited = false;
    app.ctx.changes.beforeWrite = async () => {
      if (edited) return;
      edited = true;
      await outside(root, "ServerPlayerMaxNum=32", "ServerPlayerMaxNum=40");
    };
    const done = await apply(api, made.id);
    expect(done.status).toBe("applied");
    expect(await values(api, slug)).toMatchObject({
      ExpRate: 2,
      ServerPlayerMaxNum: 40,
    });
    const past = await history(api, slug);
    expect(past.entries.map((entry) => entry.cause)).toEqual([
      "app",
      "external",
      "import",
    ]);
  });

  it("becomes a conflict and keeps the outside edit of the same setting", async () => {
    const { app, api, root, slug } = await palworld();
    const made = await draft(api, slug, { ExpRate: 2 });
    let edited = false;
    app.ctx.changes.beforeWrite = async () => {
      if (edited) return;
      edited = true;
      await outside(root, "ExpRate=1.000000", "ExpRate=3.000000");
    };
    const done = await apply(api, made.id);
    expect(done.status).toBe("conflict");
    expect(done.conflict).toEqual({
      files: [
        {
          kind: "settings",
          fileId: "settings",
          settings: [
            {
              settingKey: "ExpRate",
              label: "Experience rate",
              base: 1,
              ours: 2,
              theirs: 3,
            },
          ],
        },
      ],
    });
    expect(await settingsText(root)).toContain("ExpRate=3.000000");
    const past = await history(api, slug);
    const states = past.entries.map((entry) => [entry.cause, entry.status]);
    expect(states).toEqual([
      ["app", "conflict"],
      ["external", "applied"],
      ["import", "applied"],
    ]);
  });

  it("gives up as busy when the file keeps changing, losing no edit", async () => {
    const { app, api, root, slug } = await palworld();
    const made = await draft(api, slug, { ExpRate: 2 });
    let players = 32;
    app.ctx.changes.beforeWrite = async () => {
      const from = `ServerPlayerMaxNum=${players}`;
      players += 1;
      await outside(root, from, `ServerPlayerMaxNum=${players}`);
    };
    const done = await apply(api, made.id);
    expect(done).toMatchObject({ status: "failed", error: { code: "busy" } });
    expect(await values(api, slug)).toMatchObject({
      ExpRate: 1,
      ServerPlayerMaxNum: 35,
    });
  });

  it("merges a raw patch with an outside edit of other lines, not of the same line", async () => {
    const { api, root, slug } = await palworld();
    const original = await settingsText(root);
    const edited = original.replace("; Synthetic", "; Edited");
    const made = await patch(api, slug, edited);
    expect(made.status).toBe("draft");
    expect(made.diff.semantic).toEqual([
      expect.objectContaining({
        kind: "lines",
        settingKey: null,
        to: "1 line changed",
      }),
    ]);
    await outside(root, "ExpRate=1.000000", "ExpRate=3.000000");
    expect((await apply(api, made.id)).status).toBe("applied");
    const merged = await settingsText(root);
    expect(merged).toContain("; Edited Palworld");
    expect(merged).toContain("ExpRate=3.000000");

    const clash = await patch(
      api,
      slug,
      merged.replace("ExpRate=3.000000", "ExpRate=4.000000"),
    );
    await outside(root, "ServerPlayerMaxNum=32", "ServerPlayerMaxNum=40");
    const refused = await apply(api, clash.id);
    expect(refused.status).toBe("conflict");
    expect(refused.conflict?.files).toEqual([
      expect.objectContaining({ kind: "text", fileId: "settings" }),
    ]);
    const kept = await settingsText(root);
    expect(kept).toContain("ServerPlayerMaxNum=40");
    expect(kept).toContain("ExpRate=3.000000");
  });

  it("fails validation without writing, and may be applied again", async () => {
    const { api, root, slug } = await palworld();
    const made = await draft(api, slug, { ExpRate: 50 });
    expect(made.lint).toContainEqual(
      expect.objectContaining({
        settingKey: "ExpRate",
        code: "validation",
        severity: "error",
      }),
    );
    const before = await settingsText(root);
    const failed = await apply(api, made.id);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "validation" },
    });
    expect(await settingsText(root)).toBe(before);
    expect((await apply(api, made.id)).status).toBe("failed");
  });

  it("runs serverEvaluated rules on the stored values and marks them", async () => {
    const { api, slug } = await palworld();
    const secret = `same-${randomUUID()}`;
    const made = await draft(api, slug, {
      AdminPassword: secret,
      ServerPassword: secret,
    });
    const marked = made.lint.filter((entry) => entry.serverEvaluated);
    expect(marked).toEqual([
      expect.objectContaining({
        settingKey: "AdminPassword",
        code: "rule:admin-is-join-password",
        severity: "warning",
      }),
      expect.objectContaining({
        settingKey: "ServerPassword",
        code: "rule:admin-is-join-password",
        severity: "warning",
      }),
    ]);
    const chips = made.diff.semantic.map((chip) => [
      chip.kind,
      chip.settingKey,
      chip.from,
      chip.to,
    ]);
    expect(chips).toEqual([
      ["masked", "AdminPassword", "", SECRET_MASK],
      ["masked", "ServerPassword", "", SECRET_MASK],
    ]);
    expect(JSON.stringify(made)).not.toContain(secret);
    expect((await apply(api, made.id)).status).toBe("applied");
    const response = await api.get(`/api/v1/servers/${slug}/settings`);
    const lint = response.json<{ lint: ChangeSetBody["lint"] }>().lint;
    const rule = lint.filter((entry) => entry.serverEvaluated);
    expect(rule.map((entry) => entry.settingKey)).toEqual([
      "AdminPassword",
      "ServerPassword",
    ]);
  });
});

describe("the change set state machine", () => {
  it("allows only the moves of contract C5", () => {
    expect(canMove("draft", "applied")).toBe(true);
    expect(canMove("draft", "conflict")).toBe(true);
    expect(canMove("failed", "applied")).toBe(true);
    expect(canMove("pending", "applied")).toBe(true);
    expect(canMove("scheduled", "reverted")).toBe(true);
    expect(canMove("applied", "reverted")).toBe(true);
    expect(canMove("applied", "draft")).toBe(false);
    expect(canMove("conflict", "applied")).toBe(false);
    expect(canMove("reverted", "applied")).toBe(false);
    expect(CHANGE_SET_STATUSES.filter(isApplicable)).toEqual([
      "draft",
      "failed",
    ]);
  });

  it("refuses to apply twice, hooks before P6 and unknown ids", async () => {
    const { api, slug } = await palworld();
    const made = await change(api, slug, { ExpRate: 2 });
    const url = `/api/v1/change-sets/${made.id}/apply`;
    const twice = await api.post(url);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toEqual({
      error: "invalid_state",
      status: "applied",
    });
    const hooks = await api.post(url, { runHooks: "restart" });
    expect(hooks.json()).toEqual({ error: "hooks_not_available" });
    const unknown = await api.get(`/api/v1/change-sets/${randomUUID()}`);
    expect(unknown.statusCode).toBe(404);
    expect((await api.get("/api/v1/change-sets/x")).statusCode).toBe(400);
    const shown = await api.get(`/api/v1/change-sets/${made.id}`);
    expect(shown.json()).toMatchObject({ id: made.id, status: "applied" });
  });

  it("restores a version as a rollback and marks the undone change reverted", async () => {
    const { api, root, slug } = await palworld();
    const original = await settingsText(root);
    const made = await change(api, slug, { ExpRate: 2 });
    const past = await history(api, slug);
    const entry = past.entries.find((item) => item.changeSetId === made.id);
    const before = entry?.snapshots.find((item) => item.kind === "before");
    expect(before).toBeDefined();
    const url = `/api/v1/snapshots/${before?.id ?? ""}/restore`;
    const restored = await api.post(url);
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      cause: "rollback",
      status: "applied",
      restoreOf: before?.id,
    });
    expect(await settingsText(root)).toBe(original);
    const after = await history(api, slug);
    const states = after.entries.map((item) => [item.cause, item.status]);
    expect(states).toEqual([
      ["rollback", "applied"],
      ["app", "reverted"],
      ["import", "applied"],
    ]);
    const again = await api.post(`/api/v1/change-sets/${made.id}/apply`);
    expect(again.statusCode).toBe(409);
    const missing = await api.post(`/api/v1/snapshots/${randomUUID()}/restore`);
    expect(missing.statusCode).toBe(404);
  });
});

describe("history limits (contract C1)", () => {
  it("shows 5 entries on Free with hiddenCount, and every entry on Paid", async () => {
    const { api, slug } = await palworld();
    const first = await history(api, slug);
    const imported = first.entries.at(0)?.snapshots.at(0)?.id ?? "";
    for (const rate of [2, 3, 4, 5, 6, 7]) {
      await change(api, slug, { ExpRate: rate });
    }
    const free = await history(api, slug);
    expect(free.entries).toHaveLength(5);
    expect(free.visibleLimit).toBe(5);
    expect(free.hiddenCount).toBe(2);
    const hidden = await api.post(`/api/v1/snapshots/${imported}/restore`);
    expect(hidden.statusCode).toBe(402);
    expect(hidden.json()).toEqual({
      error: "payment_required",
      plan: "free",
      limit: "historyVisible",
      current: 7,
      max: 5,
    });

    const token = customerLicence();
    expect((await api.put("/api/v1/licence", { token })).statusCode).toBe(200);
    const paid = await history(api, slug);
    expect(paid.entries).toHaveLength(7);
    expect(paid.visibleLimit).toBeNull();
    expect(paid.hiddenCount).toBe(0);
    const restored = await api.post(`/api/v1/snapshots/${imported}/restore`);
    expect(restored.json()).toMatchObject({ status: "applied" });
  });

  it("meters the snapshot store for the owner", async () => {
    const { api } = await palworld();
    const response = await api.get("/api/v1/system/snapshots");
    const meter = response.json<{ usedBytes: number; blobs: number }>();
    expect(meter.blobs).toBe(2);
    expect(meter.usedBytes).toBeGreaterThan(0);
  });
});
