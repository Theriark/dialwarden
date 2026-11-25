// The raw rule of rnd-decision-p8a Q2 (p8-threat-specs H-01 to H-04, the
// part of P3 X1 left open): raw patches to any file are owner and admin
// only, at create and again at apply (403 raw_requires_admin); a restore
// into a shell-read file is owner and admin only (403
// shell_file_requires_admin); editors keep typed edits, which pass the X1
// value check. The Palworld launch file (adapter launch) is the shell-read
// file here; the settings file (ueini) is a plain one.
import { afterEach, describe, expect, it } from "vitest";
import { changeSets } from "../db/schema.js";
import type { TestApp } from "../../test/helpers.js";
import {
  apiOf,
  apply,
  draft,
  fileText,
  PALWORLD_SETTINGS,
} from "../../test/servers.js";
import {
  call,
  INT_SETTING,
  teamFixture,
  type TeamFixture,
} from "../../test/team.js";

const LAUNCH = "dialwarden-args.txt";
const PLAYERS = "Launch.Players";
const PWN = '\nextra="$(touch /tmp/dw-pwn)"\nother=`touch /tmp/dw-pwn`\n';

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

function changeSetCount(t: TeamFixture): number {
  return t.app.ctx.store.db.select().from(changeSets).all().length;
}

const changesUrl = (t: TeamFixture) =>
  `/api/v1/servers/${t.servers.a}/change-sets`;

/** The before snapshot of one file, after the owner applied typed edits. */
async function beforeSnapshot(
  t: TeamFixture,
  fileId: string,
  edits: Record<string, unknown>,
): Promise<string> {
  const api = apiOf(t.app, t.owner);
  const made = await draft(api, t.servers.a, edits);
  await apply(api, made.id);
  const records = t.app.ctx.snapshots.ofChangeSets([made.id]);
  const found = records.find(
    (item) => item.kind === "before" && item.fileId === fileId,
  );
  if (found === undefined) throw new Error(`no before snapshot of ${fileId}`);
  return found.id;
}

describe("raw patches and shell-read files (H-01 to H-04)", () => {
  it("H-01, H-02 refuses a raw patch from an editor, to any file", async () => {
    const t = await fixture();
    const files = [
      { fileId: "launch", path: LAUNCH },
      { fileId: "settings", path: PALWORLD_SETTINGS },
    ];
    for (const { fileId, path } of files) {
      const before = await fileText(t.servers.rootA, path);
      const count = changeSetCount(t);
      const text = `${before}${PWN}`;
      const response = await call(t.app, t.editor, "POST", changesUrl(t), {
        patches: [{ fileId, text }],
      });
      expect(response.statusCode, fileId).toBe(403);
      expect(response.json(), fileId).toEqual({ error: "raw_requires_admin" });
      expect(changeSetCount(t)).toBe(count);
      expect(await fileText(t.servers.rootA, path)).toBe(before);
    }
  });

  it("lets the owner and admins draft raw patches", async () => {
    const t = await fixture();
    const before = await fileText(t.servers.rootA, LAUNCH);
    const text = before.replace("-players 32", "-players 30");
    for (const user of [t.admin, t.owner]) {
      const response = await call(t.app, user, "POST", changesUrl(t), {
        patches: [{ fileId: "launch", text }],
      });
      expect(response.statusCode).toBe(201);
    }
  });

  it("refuses an editor's apply of a raw patch an admin drafted", async () => {
    const t = await fixture();
    const before = await fileText(t.servers.rootA, PALWORLD_SETTINGS);
    const text = `${before}\n`;
    const made = await call(t.app, t.admin, "POST", changesUrl(t), {
      patches: [{ fileId: "settings", text }],
    });
    expect(made.statusCode).toBe(201);
    const id = made.json<{ id: string }>().id;
    const url = `/api/v1/change-sets/${id}/apply`;
    const byEditor = await call(t.app, t.editor, "POST", url, {});
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toEqual({ error: "raw_requires_admin" });
    expect(await fileText(t.servers.rootA, PALWORLD_SETTINGS)).toBe(before);
    const byAdmin = await call(t.app, t.admin, "POST", url, {});
    expect(byAdmin.statusCode).toBe(200);
  });

  it("H-03 refuses an editor's restore into a shell-read file", async () => {
    const t = await fixture();
    const snapshot = await beforeSnapshot(t, "launch", { [PLAYERS]: 30 });
    const url = `/api/v1/snapshots/${snapshot}/restore`;
    const after = await fileText(t.servers.rootA, LAUNCH);
    const byEditor = await call(t.app, t.editor, "POST", url);
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toEqual({ error: "shell_file_requires_admin" });
    expect(await fileText(t.servers.rootA, LAUNCH)).toBe(after);
    const byAdmin = await call(t.app, t.admin, "POST", url);
    expect(byAdmin.statusCode).toBe(200);
  });

  it("lets an editor restore a plain settings file", async () => {
    const t = await fixture();
    const edits = { [INT_SETTING]: 20 };
    const snapshot = await beforeSnapshot(t, "settings", edits);
    const url = `/api/v1/snapshots/${snapshot}/restore`;
    const byEditor = await call(t.app, t.editor, "POST", url);
    expect(byEditor.statusCode).toBe(200);
  });

  it("H-04 keeps typed edits of shell-read files open to editors", async () => {
    const t = await fixture();
    const response = await call(t.app, t.editor, "POST", changesUrl(t), {
      edits: [{ settingKey: PLAYERS, value: 30 }],
    });
    expect(response.statusCode).toBe(201);
  });

  it("H-05 shows the raw text of a file to admins only (D14)", async () => {
    const t = await fixture();
    const url = `/api/v1/servers/${t.servers.a}/files/settings`;
    for (const user of [t.editor, t.viewer]) {
      const response = await call(t.app, user, "GET", url);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden" });
    }
    const asAdmin = await call(t.app, t.admin, "GET", url);
    expect(asAdmin.statusCode).toBe(200);
  });

  it("H-06 hides the hook command and the server settings below admin", async () => {
    const t = await fixture();
    const hooksUrl = `/api/v1/servers/${t.servers.a}/hooks`;
    const serverUrl = `/api/v1/servers/${t.servers.a}`;
    // The owner sets a docker proxy hook (the local demo server has no SSH
    // access, so the command kind is refused for it); an editor may neither
    // change the hook nor the server's own settings (D20).
    const proxy = {
      kind: "dockerProxy",
      url: "http://127.0.0.1:2375",
      containerLabel: "com.example.game=dialwarden",
    };
    const set = await call(t.app, t.owner, "PUT", hooksUrl, { hook: proxy });
    expect(set.statusCode).toBe(200);
    const byEditor = await call(t.app, t.editor, "PUT", hooksUrl, {
      hook: { ...proxy, containerLabel: "com.example.game=pwn" },
    });
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toEqual({ error: "forbidden" });
    const patch = await call(t.app, t.editor, "PATCH", serverUrl, {
      name: "renamed",
    });
    expect(patch.statusCode).toBe(403);
    // Editors and viewers see the hook kind, never the proxy URL; an admin
    // sees it in full.
    for (const user of [t.editor, t.viewer]) {
      const view = await call(t.app, user, "GET", hooksUrl);
      expect(view.statusCode).toBe(200);
      const body = view.json<{ hook: { kind: string; url: string } }>();
      expect(body.hook.kind).toBe("dockerProxy");
      expect(body.hook.url).not.toBe(proxy.url);
    }
    const full = await call(t.app, t.admin, "GET", hooksUrl);
    expect(full.statusCode).toBe(200);
    expect(full.json<{ hook: { url: string } }>().hook.url).toBe(proxy.url);
  });
});
