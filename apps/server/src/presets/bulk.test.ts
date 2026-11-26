// The bulk preset apply (dev-work-plan P9-A step 2, Paid feature
// presets.bulk): the per-server diff first (a draft change set of cause
// preset on each server, made on its own files), then one apply per server
// with a report that keeps going past a failed server. The P8 grants decide
// per server: a server the caller may not write is server_not_found in its
// item, and a change set of such a server is change_set_not_found. Free
// answers 402, and Paid works again after the Free switch is off.
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addServer,
  apiOf,
  fileText,
  palworldFolder,
  PALWORLD_SETTINGS,
  type ChangeSetBody,
} from "../../test/servers.js";
import {
  call,
  INT_SETTING,
  teamFixture,
  toFree,
  toPaid,
  type TeamFixture,
} from "../../test/team.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

interface DraftItem {
  server: string;
  changeSet: ChangeSetBody | null;
  error: { code: string } | null;
}

interface Report {
  items: {
    changeSetId: string;
    server: string | null;
    status: string;
    error: { code: string } | null;
  }[];
  applied: number;
  pending: number;
  failed: number;
}

let t: TeamFixture;
let preset: string;
let rootC: string;
let c: string;

beforeEach(async () => {
  t = await teamFixture();
  const api = apiOf(t.app, t.owner);
  rootC = await palworldFolder(t.base, "c");
  c = await addServer(api, "demo-c", rootC);
  const made = await api.post("/api/v1/presets", {
    name: "small",
    description: "",
    packId: "palworld",
    values: { [INT_SETTING]: 10 },
  });
  expect(made.statusCode).toBe(201);
  preset = made.json<{ id: string }>().id;
});

afterEach(async () => {
  await t.current.close();
});

const drafts = (who: typeof t.owner, servers: string[]) =>
  call(t.app, who, "POST", `/api/v1/presets/${preset}/bulk-drafts`, {
    servers,
  });

const bulkApply = (who: typeof t.owner, changeSets: string[]) =>
  call(t.app, who, "POST", "/api/v1/presets/bulk-apply", { changeSets });

const maxPlayers = async (root: string) =>
  /ServerPlayerMaxNum=(\d+)/.exec(await fileText(root, PALWORLD_SETTINGS))?.[1];

describe("bulk preset apply", () => {
  it("drafts each server's own diff, then applies past a failed server", async () => {
    const response = await drafts(t.owner, [t.servers.a, t.servers.b, c]);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: DraftItem[] }>().items;
    expect(items.map((item) => item.server)).toEqual([
      t.servers.a,
      t.servers.b,
      c,
    ]);
    for (const item of items) {
      expect(item.error).toBeNull();
      expect(item.changeSet).toMatchObject({
        status: "draft",
        cause: "preset",
      });
      expect(item.changeSet?.diff.semantic).toEqual([
        expect.objectContaining({
          settingKey: INT_SETTING,
          from: 32,
          to: 10,
        }),
      ]);
    }
    // Nothing is written before the apply.
    expect(await maxPlayers(t.servers.rootA)).toBe("32");

    // demo-c can no longer be read when the apply runs.
    const folder = join(rootC, dirname(PALWORLD_SETTINGS));
    await chmod(folder, 0o000);
    try {
      const ids = items.map((item) => item.changeSet?.id ?? "");
      const applied = await bulkApply(t.owner, ids);
      expect(applied.statusCode).toBe(200);
      const report = applied.json<Report>();
      expect(report).toMatchObject({ applied: 2, pending: 0, failed: 1 });
      expect(report.items.map((item) => item.server)).toEqual([
        t.servers.a,
        t.servers.b,
        c,
      ]);
      expect(report.items[0]).toMatchObject({ status: "applied", error: null });
      expect(report.items[2]?.status).not.toBe("applied");
      expect(report.items[2]?.error?.code).toEqual(expect.any(String));
    } finally {
      await chmod(folder, 0o755);
    }
    expect(await maxPlayers(t.servers.rootA)).toBe("10");
    expect(await maxPlayers(t.servers.rootB)).toBe("10");
    expect(await maxPlayers(rootC)).toBe("32");
  });

  it("answers an unexpected error in its item and goes on with the others", async () => {
    const { changes } = t.app.ctx;
    const create = changes.create.bind(changes);
    const draftSpy = vi
      .spyOn(changes, "create")
      .mockImplementation((server, ...rest) =>
        server.id === t.servers.b
          ? Promise.reject(new Error("unexpected"))
          : create(server, ...rest),
      );
    const response = await drafts(t.owner, [t.servers.a, t.servers.b, c]);
    draftSpy.mockRestore();
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: DraftItem[] }>().items;
    expect(items[1]).toEqual({
      server: t.servers.b,
      changeSet: null,
      error: { code: "internal" },
    });
    expect(items[0]?.changeSet?.status).toBe("draft");
    expect(items[2]?.changeSet?.status).toBe("draft");

    const ids = [items[0], items[2]].map((item) => item?.changeSet?.id ?? "");
    const apply = changes.apply.bind(changes);
    const applySpy = vi
      .spyOn(changes, "apply")
      .mockImplementation((id, ...rest) =>
        id === ids[0]
          ? Promise.reject(new Error("unexpected"))
          : apply(id, ...rest),
      );
    const applied = await bulkApply(t.owner, ids);
    applySpy.mockRestore();
    expect(applied.statusCode).toBe(200);
    const report = applied.json<Report>();
    expect(report).toMatchObject({ applied: 1, failed: 1 });
    expect(report.items[0]).toEqual({
      changeSetId: ids[0],
      server: t.servers.a,
      status: "refused",
      error: { code: "internal" },
    });
    expect(report.items[1]?.status).toBe("applied");
    expect(await maxPlayers(rootC)).toBe("10");
  });

  it("answers a missing server in its item, never as an error", async () => {
    const response = await drafts(t.owner, [t.servers.a, "no-such-server"]);
    const items = response.json<{ items: DraftItem[] }>().items;
    expect(items[1]).toEqual({
      server: "no-such-server",
      changeSet: null,
      error: { code: "server_not_found" },
    });
    expect(items[0]?.changeSet?.status).toBe("draft");
  });

  it("respects the per-server grants of the caller", async () => {
    const before = t.app.ctx.store.sqlite
      .prepare("SELECT count(*) AS n FROM change_sets WHERE server_id = ?")
      .get(t.servers.b) as { n: number };
    const response = await drafts(t.editor, [t.servers.a, t.servers.b]);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: DraftItem[] }>().items;
    expect(items[0]?.changeSet?.status).toBe("draft");
    // demo-b looks exactly like a server that does not exist.
    expect(items[1]).toEqual({
      server: t.servers.b,
      changeSet: null,
      error: { code: "server_not_found" },
    });
    const after = t.app.ctx.store.sqlite
      .prepare("SELECT count(*) AS n FROM change_sets WHERE server_id = ?")
      .get(t.servers.b) as { n: number };
    expect(after.n).toBe(before.n);

    // The owner's draft on demo-b is not the editor's to apply.
    const owners = await drafts(t.owner, [t.servers.b]);
    const onB = owners.json<{ items: DraftItem[] }>().items[0]?.changeSet;
    const report = (
      await bulkApply(t.editor, [onB?.id ?? "", items[0]?.changeSet?.id ?? ""])
    ).json<Report>();
    expect(report.items[0]).toEqual({
      changeSetId: onB?.id,
      server: null,
      status: "refused",
      error: { code: "change_set_not_found" },
    });
    expect(report.items[1]?.status).toBe("applied");
    expect(await maxPlayers(t.servers.rootB)).toBe("32");

    // A viewer and a reader of one server change nothing.
    expect((await drafts(t.viewer, [t.servers.a])).statusCode).toBe(403);
    expect((await bulkApply(t.viewer, [onB?.id ?? ""])).statusCode).toBe(403);
    const loner = await drafts(t.loner, [t.servers.a]);
    expect(loner.json<{ items: DraftItem[] }>().items[0]?.error).toEqual({
      code: "server_not_found",
    });
  });

  it("refuses a change set that is not a preset draft", async () => {
    const api = apiOf(t.app, t.owner);
    const own = await api.post(`/api/v1/servers/${t.servers.a}/change-sets`, {
      edits: [{ settingKey: INT_SETTING, value: 3 }],
    });
    const id = own.json<{ id: string }>().id;
    const report = (await bulkApply(t.owner, [id])).json<Report>();
    expect(report.items[0]).toMatchObject({
      status: "refused",
      server: t.servers.a,
      error: { code: "not_a_preset_draft" },
    });
    expect(report).toMatchObject({ applied: 0, failed: 1 });
  });

  // P10-A G3.5 and G4.7: a preset value with a command is never written by
  // a bulk apply, and a preset secret reaches the drafts only as a mask.
  it("G3.5 and G4.7 write no command and show no secret in a bulk apply", async () => {
    const api = apiOf(t.app, t.owner);
    const made = await api.post("/api/v1/presets", {
      name: "shell",
      description: "",
      packId: "palworld",
      values: {
        "Launch.ServerName": "a `touch /tmp/dw-pwn` b",
        AdminPassword: "MARKER-bulk-secret-7c",
      },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json<{ id: string }>().id;
    const launch = "dialwarden-args.txt";
    const before = await fileText(t.servers.rootA, launch);
    const drafted = await call(
      t.app,
      t.editor,
      "POST",
      `/api/v1/presets/${id}/bulk-drafts`,
      { servers: [t.servers.a] },
    );
    expect(drafted.statusCode).toBe(200);
    expect(drafted.body).not.toContain("MARKER-bulk-secret-7c");
    const item = drafted.json<{ items: DraftItem[] }>().items[0];
    const changeSet = item?.changeSet;
    if (changeSet === null || changeSet === undefined) {
      // Refused at the draft: the value never reached a change set.
      expect(item?.error?.code).toMatch(/invalid_value|validation/);
    } else {
      const report = (
        await call(t.app, t.editor, "POST", "/api/v1/presets/bulk-apply", {
          changeSets: [changeSet.id],
        })
      ).json<Report>();
      expect(report.items[0]).toMatchObject({
        status: "failed",
        error: { code: "validation" },
      });
    }
    expect(await fileText(t.servers.rootA, launch)).toBe(before);
  });

  it("answers 402 on Free and works again on Paid", async () => {
    await toFree(t.app, t.owner);
    const free = await drafts(t.owner, [t.servers.a]);
    expect(free.statusCode).toBe(402);
    expect(free.json()).toMatchObject({ feature: "presets.bulk" });
    await toPaid(t.app, t.owner);
    expect((await drafts(t.owner, [t.servers.a])).statusCode).toBe(200);
  });
});
