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
import { ConnectorError } from "../connectors/types.js";
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

/** The Palworld launch file (dialwarden-args.txt), the pack's second file. */
const PALWORLD_LAUNCH = "dialwarden-args.txt";

/** One outside edit per Palworld file, on a setting no test change edits. */
const OUTSIDE_EDITS = {
  settings: {
    path: PALWORLD_SETTINGS,
    from: "ServerPlayerMaxNum=32",
    to: "ServerPlayerMaxNum=40",
    key: "ServerPlayerMaxNum",
    value: 40,
  },
  launch: {
    path: PALWORLD_LAUNCH,
    from: "-publicip=203.0.113.10",
    to: "-publicip=203.0.113.20",
    key: "Launch.PublicIp",
    value: "203.0.113.20",
  },
} as const;

const outsideEditOf = (fileId: string) =>
  fileId === "launch" ? OUTSIDE_EDITS.launch : OUTSIDE_EDITS.settings;

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

/** Makes and applies one change of both Palworld files. */
const bothFiles = (api: Api, slug: string) =>
  change(api, slug, { ExpRate: 2, "Launch.Players": 40 });

/** The before snapshots of a visible history entry, by file. */
async function beforeSnapshots(api: Api, slug: string, id: string) {
  const past = await history(api, slug);
  const entry = past.entries.find((item) => item.changeSetId === id);
  const found = new Map<string, string>();
  for (const snapshot of entry?.snapshots ?? []) {
    if (snapshot.kind === "before") found.set(snapshot.fileId, snapshot.id);
  }
  const settings = found.get("settings") ?? "";
  const launch = found.get("launch") ?? "";
  expect(settings).not.toBe("");
  expect(launch).not.toBe("");
  return { settings, launch };
}

const restoreSnapshot = (api: Api, id: string) =>
  api.post(`/api/v1/snapshots/${id}/restore`);

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

  it("masks a secret that the file holds escaped, in drafts and history", async () => {
    const { api, slug } = await palworld();
    const tail = randomUUID();
    // The UE INI writer stores \ and " escaped, so the file text differs
    // from the value; masking by value alone would miss it.
    const made = await draft(api, slug, { AdminPassword: `pass\\${tail}` });
    const [text] = made.diff.text;
    expect(text?.unifiedDiff).toContain(SECRET_MASK);
    expect(JSON.stringify(made)).not.toContain(tail);
    const done = await apply(api, made.id);
    expect(done.status).toBe("applied");
    const shown = await api.get(`/api/v1/change-sets/${made.id}`);
    expect(shown.body).not.toContain(tail);
    expect(JSON.stringify(await history(api, slug))).not.toContain(tail);

    // A double quote: the pack refuses it on apply (quote-in-text-secret),
    // and neither the draft nor the failed change set shows it.
    const quoted = `quote"${randomUUID()}`;
    const refused = await draft(api, slug, { ServerPassword: quoted });
    expect(JSON.stringify(refused)).not.toContain(quoted.slice(6));
    const failed = await apply(api, refused.id);
    expect(failed.status).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain(quoted.slice(6));
  });

  it("hides the text diff of a broken file with secrets, never the secret", async () => {
    const { api, root, slug } = await palworld();
    const tail = randomUUID();
    // A new password on a line whose closing ) is gone: the file no longer
    // parses, so the password cannot be located by the format adapter.
    const breakLine = (line: string) => {
      if (!line.startsWith("OptionSettings=")) return line;
      const set = line.replace('AdminPassword=""', `AdminPassword="${tail}"`);
      return set.replace(/\)$/, "");
    };
    const original = await settingsText(root);
    const broken = original.split("\n").map(breakLine).join("\n");
    expect(broken).toContain(tail);
    const made = await patch(api, slug, broken);
    expect(made.status).toBe("draft");
    const [text] = made.diff.text;
    expect(text?.unifiedDiff).toContain("diff hidden");
    expect(JSON.stringify(made)).not.toContain(tail);
    const shown = await api.get(`/api/v1/change-sets/${made.id}`);
    expect(shown.body).not.toContain(tail);
    const failed = await apply(api, made.id);
    expect(failed.status).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain(tail);
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
    // P10-A G1.3: a file id is a pack id, never a path.
    const climb = await post({
      patches: [{ fileId: "../../etc/passwd", text: "x" }],
    });
    expect(climb.statusCode).toBe(422);
    expect(climb.json()).toMatchObject({ error: "unknown_file" });
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

  it("refuses an edit whose value the setting cannot hold (F2)", async () => {
    const { api, slug } = await palworld();
    const url = `/api/v1/servers/${slug}/change-sets`;
    // A boolean is not one of the listed choices of an enum; such an edit
    // used to be dropped from the change set with no 422, chip or write.
    const wrongEnum = await api.post(url, {
      edits: [{ settingKey: "Difficulty", value: false }],
    });
    expect(wrongEnum.statusCode).toBe(422);
    expect(wrongEnum.json()).toEqual({
      error: "invalid_value",
      key: "Difficulty",
      message: "Must be one of the listed choices.",
    });
    // Text for a number is refused the same way. A number out of range is
    // not: it stays a validation error on the draft (the write path tests).
    const kind = await api.post(url, {
      edits: [{ settingKey: "ServerPlayerMaxNum", value: "many" }],
    });
    expect(kind.statusCode).toBe(422);
    expect(kind.json()).toEqual({
      error: "invalid_value",
      key: "ServerPlayerMaxNum",
      message: "Must be a number.",
    });
    // false is still a value of a bool setting: the edit is kept and works.
    const kept = await change(api, slug, { bIsShowJoinLeftMessage: false });
    expect(
      kept.diff.semantic.some(
        (chip) => chip.settingKey === "bIsShowJoinLeftMessage",
      ),
    ).toBe(true);
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

  // P10-A G4.5: a conflict on a secret shows all three sides as masks.
  it("G4.5 masks base, ours and theirs of a secret in conflict", async () => {
    const { app, api, root, slug } = await palworld();
    const [base, ours, theirs] = ["base", "ours", "theirs"].map(
      (side) => `${side}-${randomUUID()}`,
    );
    await change(api, slug, { AdminPassword: base });
    const made = await draft(api, slug, { AdminPassword: ours });
    let edited = false;
    app.ctx.changes.beforeWrite = async () => {
      if (edited) return;
      edited = true;
      await outside(
        root,
        `AdminPassword="${base ?? ""}"`,
        `AdminPassword="${theirs ?? ""}"`,
      );
    };
    const done = await apply(api, made.id);
    expect(done.status).toBe("conflict");
    expect(done.conflict?.files[0]).toMatchObject({
      settings: [
        {
          settingKey: "AdminPassword",
          base: SECRET_MASK,
          ours: SECRET_MASK,
          theirs: SECRET_MASK,
        },
      ],
    });
    const shown = await api.get(`/api/v1/change-sets/${made.id}`);
    for (const body of [JSON.stringify(done), shown.body]) {
      for (const value of [base, ours, theirs]) {
        expect(body).not.toContain(value);
      }
    }
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

  it("undoes the files already written when a later file changes, then merges", async () => {
    const { app, api, root, slug } = await palworld();
    const made = await draft(api, slug, { ExpRate: 2, "Launch.Players": 40 });
    let calls = 0;
    const seen: { fileId?: string } = {};
    app.ctx.changes.beforeWrite = async (_server, fileId) => {
      calls += 1;
      if (calls !== 2) return;
      // The second file of the pass: the first one is already written.
      seen.fileId = fileId;
      const edit = outsideEditOf(fileId);
      await editOutside(root, edit.path, edit.from, edit.to);
    };
    const done = await apply(api, made.id);
    expect(done.status).toBe("applied");
    expect(seen.fileId).toBeDefined();
    const edit = outsideEditOf(seen.fileId ?? "");
    expect(await values(api, slug)).toMatchObject({
      ExpRate: 2,
      "Launch.Players": 40,
      [edit.key]: edit.value,
    });
    const past = await history(api, slug);
    expect(past.entries.map((entry) => [entry.cause, entry.status])).toEqual([
      ["app", "applied"],
      ["external", "applied"],
      ["import", "applied"],
    ]);
  });

  it("puts the files already written back when a later file of the pass conflicts", async () => {
    const { app, api, root, slug } = await palworld();
    const before = await settingsText(root);
    const made = await draft(api, slug, { ExpRate: 2, "Launch.Players": 40 });
    const seen: string[] = [];
    app.ctx.changes.beforeWrite = async (_server, fileId) => {
      seen.push(fileId);
      if (seen.length !== 2) return;
      // The second file of the pass (launch): the settings file is already
      // written. An outside edit of the very setting the change set edits
      // makes the retry a conflict, so the settings file must be put back.
      await editOutside(root, PALWORLD_LAUNCH, "-players 32", "-players 48");
    };
    const done = await apply(api, made.id);
    expect(done.status).toBe("conflict");
    // The retry plans a conflict and writes nothing: two writes in total.
    expect(seen).toEqual(["settings", "launch"]);
    expect(await settingsText(root)).toBe(before);
    expect(await values(api, slug)).toMatchObject({
      ExpRate: 1,
      "Launch.Players": 48,
    });
    const past = await history(api, slug);
    expect(past.entries.map((entry) => [entry.cause, entry.status])).toEqual([
      ["app", "conflict"],
      ["external", "applied"],
      ["import", "applied"],
    ]);
  });

  it("applies a failed change set again over its own partial write", async () => {
    const { app, api, root, slug } = await palworld();
    const made = await draft(api, slug, { ExpRate: 2, "Launch.Players": 40 });
    let calls = 0;
    app.ctx.changes.beforeWrite = async (_server, fileId) => {
      calls += 1;
      if (calls !== 2) return;
      throw new ConnectorError("Connection", `disk gone before ${fileId}`);
    };
    const failed = await apply(api, made.id);
    expect(failed.status).toBe("failed");
    // One file holds the new value; applying again is no conflict with
    // itself (both sides made the same change).
    app.ctx.changes.beforeWrite = null;
    const again = await apply(api, made.id);
    expect(again.status).toBe("applied");
    expect(await values(api, slug)).toMatchObject({
      ExpRate: 2,
      "Launch.Players": 40,
    });
    expect(await fileText(root, PALWORLD_LAUNCH)).toContain("-players 40");
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

    // Every Palworld value sits on the one OptionSettings line, so an edit of
    // ExpRate and an outside edit of ServerPlayerMaxNum touch the same line.
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

  it("refuses to apply twice, with or without hooks, and unknown ids", async () => {
    const { api, slug } = await palworld();
    const made = await change(api, slug, { ExpRate: 2 });
    const url = `/api/v1/change-sets/${made.id}/apply`;
    const twice = await api.post(url);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toEqual({
      error: "invalid_state",
      status: "applied",
    });
    // P6-B accepts runHooks; an applied change set is refused all the same.
    const hooks = await api.post(url, { runHooks: "restart" });
    expect(hooks.statusCode).toBe(409);
    expect(hooks.json()).toEqual({
      error: "invalid_state",
      status: "applied",
    });
    const unknown = await api.get(`/api/v1/change-sets/${randomUUID()}`);
    expect(unknown.statusCode).toBe(404);
    // P10-A I5: a malformed id answers like a missing one, before the schema.
    expect((await api.get("/api/v1/change-sets/x")).statusCode).toBe(404);
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

  it("marks a multi-file change reverted only when every file is restored", async () => {
    const { api, root, slug } = await palworld();
    const launch = await fileText(root, PALWORLD_LAUNCH);
    const made = await change(api, slug, { ExpRate: 2, "Launch.Players": 40 });
    expect(made.status).toBe("applied");
    const past = await history(api, slug);
    const entry = past.entries.find((item) => item.changeSetId === made.id);
    const before = (fileId: string) => {
      const found = entry?.snapshots.find(
        (item) => item.kind === "before" && item.fileId === fileId,
      );
      return found?.id ?? "";
    };
    const restore = (id: string) => api.post(`/api/v1/snapshots/${id}/restore`);
    const status = async () => {
      const response = await api.get(`/api/v1/change-sets/${made.id}`);
      return response.json<ChangeSetBody>().status;
    };

    const first = await restore(before("settings"));
    expect(first.json()).toMatchObject({ status: "applied" });
    expect(await status()).toBe("applied");
    expect(await fileText(root, PALWORLD_LAUNCH)).toContain("-players 40");

    const second = await restore(before("launch"));
    expect(second.json()).toMatchObject({ status: "applied" });
    expect(await status()).toBe("reverted");
    expect(await fileText(root, PALWORLD_LAUNCH)).toBe(launch);
  });

  it("refuses to apply a change set in conflict again", async () => {
    const { app, api, root, slug } = await palworld();
    const made = await draft(api, slug, { ExpRate: 2 });
    app.ctx.changes.beforeWrite = async () => {
      app.ctx.changes.beforeWrite = null;
      await outside(root, "ExpRate=1.000000", "ExpRate=3.000000");
    };
    expect((await apply(api, made.id)).status).toBe("conflict");
    const again = await api.post(`/api/v1/change-sets/${made.id}/apply`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      error: "invalid_state",
      status: "conflict",
    });
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

  it("restores a multi-file entry at the Free boundary whole, one call per file", async () => {
    const { api, root, slug } = await palworld();
    const settings = await settingsText(root);
    const launch = await fileText(root, PALWORLD_LAUNCH);
    const made = await bothFiles(api, slug);
    const ids = await beforeSnapshots(api, slug, made.id);
    for (const rate of [3, 4, 5, 6]) await change(api, slug, { ExpRate: rate });
    const past = await history(api, slug);
    expect(past.entries.at(4)?.changeSetId).toBe(made.id);
    // The history page sends one restore per file; the first rollback is a
    // new entry on top, and the second call must still reach this entry.
    for (const id of [ids.settings, ids.launch]) {
      const restored = await restoreSnapshot(api, id);
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({
        cause: "rollback",
        status: "applied",
      });
    }
    expect(await settingsText(root)).toBe(settings);
    expect(await fileText(root, PALWORLD_LAUNCH)).toBe(launch);
    const shown = await api.get(`/api/v1/change-sets/${made.id}`);
    expect(shown.json()).toMatchObject({ status: "reverted" });
  });

  it("refuses a multi-file entry past the Free boundary before any write, and restores it on Paid", async () => {
    const { api, root, slug } = await palworld();
    const settings = await settingsText(root);
    const launch = await fileText(root, PALWORLD_LAUNCH);
    const made = await bothFiles(api, slug);
    const ids = await beforeSnapshots(api, slug, made.id);
    for (const rate of [3, 4, 5, 6, 7]) {
      await change(api, slug, { ExpRate: rate });
    }
    const now = {
      settings: await settingsText(root),
      launch: await fileText(root, PALWORLD_LAUNCH),
    };
    for (const id of [ids.settings, ids.launch]) {
      const refused = await restoreSnapshot(api, id);
      expect(refused.statusCode).toBe(402);
      expect(refused.json()).toMatchObject({
        limit: "historyVisible",
        current: 7,
        max: 5,
      });
    }
    expect(await settingsText(root)).toBe(now.settings);
    expect(await fileText(root, PALWORLD_LAUNCH)).toBe(now.launch);
    expect((await history(api, slug)).hiddenCount).toBe(2);

    const token = customerLicence();
    expect((await api.put("/api/v1/licence", { token })).statusCode).toBe(200);
    for (const id of [ids.settings, ids.launch]) {
      const restored = await restoreSnapshot(api, id);
      expect(restored.json()).toMatchObject({ status: "applied" });
    }
    expect(await settingsText(root)).toBe(settings);
    expect(await fileText(root, PALWORLD_LAUNCH)).toBe(launch);
  });

  it("checks the Free boundary again after the read, so an outside edit found then writes nothing", async () => {
    const { api, root, slug } = await palworld();
    const made = await bothFiles(api, slug);
    const ids = await beforeSnapshots(api, slug, made.id);
    for (const rate of [3, 4, 5, 6]) await change(api, slug, { ExpRate: rate });
    // The entry is the fifth; the restore's own read records this outside
    // edit as a new entry on top, which pushes it out.
    await outside(root, "ServerPlayerMaxNum=32", "ServerPlayerMaxNum=40");
    const edited = await settingsText(root);
    const launch = await fileText(root, PALWORLD_LAUNCH);
    const refused = await restoreSnapshot(api, ids.settings);
    expect(refused.statusCode).toBe(402);
    expect(await settingsText(root)).toBe(edited);
    expect(await fileText(root, PALWORLD_LAUNCH)).toBe(launch);
    const past = await history(api, slug);
    expect(past.entries.at(0)?.cause).toBe("external");
    expect(past.hiddenCount).toBe(2);
  });

  it("L20 answers 402 for a hidden entry read by id, until Paid", async () => {
    const { api, slug } = await palworld();
    for (const rate of [2, 3, 4, 5, 6, 7]) {
      await change(api, slug, { ExpRate: rate });
    }
    // The ids of every change leak through the activity feed on Free.
    const feed = await api.get("/api/v1/activity?type=change.applied");
    const ids = feed
      .json<{ items: { data: { changeSetId?: string } }[] }>()
      .items.map((item) => item.data.changeSetId ?? "");
    expect(ids).toHaveLength(6);
    const oldest = ids.at(-1) ?? "";
    const hidden = await api.get(`/api/v1/change-sets/${oldest}`);
    expect(hidden.statusCode).toBe(402);
    expect(hidden.json()).toEqual({
      error: "payment_required",
      plan: "free",
      limit: "historyVisible",
      current: 7,
      max: 5,
    });
    const newest = await api.get(`/api/v1/change-sets/${ids[0] ?? ""}`);
    expect(newest.statusCode).toBe(200);
    const token = customerLicence();
    expect((await api.put("/api/v1/licence", { token })).statusCode).toBe(200);
    const paid = await api.get(`/api/v1/change-sets/${oldest}`);
    expect(paid.statusCode).toBe(200);
  });

  it("L20 refuses to apply again a failed rollback that is now hidden", async () => {
    const { app, api, root, slug } = await palworld();
    const made = await bothFiles(api, slug);
    const ids = await beforeSnapshots(api, slug, made.id);
    // The rollback fails: the host drops the connection before the write.
    app.ctx.changes.beforeWrite = async () => {
      throw new ConnectorError("Connection", "simulated drop");
    };
    const rollback = await restoreSnapshot(api, ids.settings);
    app.ctx.changes.beforeWrite = null;
    const failed = rollback.json<ChangeSetBody>();
    expect(failed.status).toBe("failed");
    for (const rate of [3, 4, 5, 6, 7]) {
      await change(api, slug, { ExpRate: rate });
    }
    const before = await settingsText(root);
    const again = await api.post(`/api/v1/change-sets/${failed.id}/apply`);
    expect(again.statusCode).toBe(402);
    expect(again.json()).toMatchObject({ limit: "historyVisible", max: 5 });
    expect(await settingsText(root)).toBe(before);
  });

  // P10-B N1: snapshot retention keeps no snapshot of a failed rollback,
  // but its payload still holds the bytes: the check then falls back on
  // the rollback entry itself, so a hidden one still answers 402 on Free.
  it("N1 refuses a hidden failed rollback whose snapshot was pruned", async () => {
    const { app, api, root, slug } = await palworld();
    const made = await bothFiles(api, slug);
    const ids = await beforeSnapshots(api, slug, made.id);
    app.ctx.changes.beforeWrite = async () => {
      throw new ConnectorError("Connection", "simulated drop");
    };
    const rollback = await restoreSnapshot(api, ids.settings);
    app.ctx.changes.beforeWrite = null;
    const failed = rollback.json<ChangeSetBody>();
    expect(failed.status).toBe("failed");
    for (const rate of [3, 4, 5, 6, 7]) {
      await change(api, slug, { ExpRate: rate });
    }
    app.ctx.store.sqlite
      .prepare("DELETE FROM snapshots WHERE id = ?")
      .run(ids.settings);
    const before = await settingsText(root);
    const again = await api.post(`/api/v1/change-sets/${failed.id}/apply`);
    expect(again.statusCode).toBe(402);
    expect(again.json()).toMatchObject({ limit: "historyVisible", max: 5 });
    expect(await settingsText(root)).toBe(before);
  });

  it("F10 adds no history entry for a restore that writes nothing", async () => {
    const { api, slug } = await palworld();
    const made = await bothFiles(api, slug);
    const ids = await beforeSnapshots(api, slug, made.id);
    const first = await restoreSnapshot(api, ids.settings);
    expect(first.json()).toMatchObject({ status: "applied" });
    const count = (await history(api, slug)).entries.length;
    // The file already holds that version: answered applied, no new entry.
    const again = await restoreSnapshot(api, ids.settings);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      cause: "rollback",
      status: "applied",
    });
    expect((await history(api, slug)).entries).toHaveLength(count);
  });

  it("meters the snapshot store for the owner", async () => {
    const { api } = await palworld();
    const response = await api.get("/api/v1/system/snapshots");
    const meter = response.json<{ usedBytes: number; blobs: number }>();
    expect(meter.blobs).toBe(2);
    expect(meter.usedBytes).toBeGreaterThan(0);
  });
});
