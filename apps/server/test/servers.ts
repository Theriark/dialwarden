// Test helpers for the servers, change sets and demo seed tests (P4-B): game
// server folders made from the packs' synthetic fixtures, and the API calls
// the tests repeat. Outside src/, so never built into the image.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { headersOf, type SignedIn } from "./helpers.js";

/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder and the repository's packs */

const PACKS_URL = new URL("../../../packs/", import.meta.url);

/** The packs folder of the repository (synthetic fixtures). */
export const PACKS_DIR = fileURLToPath(PACKS_URL);

const SETTINGS_FOLDER = "Pal/Saved/Config/LinuxServer";

/** Where the Palworld settings file sits in a Linux server folder. */
export const PALWORLD_SETTINGS = `${SETTINGS_FOLDER}/PalWorldSettings.ini`;

/** A Palworld server folder from the pack's fixtures, at base/name. */
export async function palworldFolder(
  base: string,
  name = "palworld",
): Promise<string> {
  const root = join(base, name);
  const fixtures = join(PACKS_DIR, "palworld", "fixtures");
  await mkdir(join(root, SETTINGS_FOLDER), { recursive: true });
  await copyFile(
    join(fixtures, "PalWorldSettings.ini"),
    join(root, PALWORLD_SETTINGS),
  );
  await copyFile(
    join(fixtures, "dialwarden-args.txt"),
    join(root, "dialwarden-args.txt"),
  );
  await writeFile(join(root, "PalServer.sh"), "");
  return root;
}

/** The text of a file of a server folder. */
export async function fileText(root: string, path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

/** Replaces text in a file the way an outside editor would. */
export async function editOutside(
  root: string,
  path: string,
  from: string,
  to: string,
): Promise<void> {
  const text = await fileText(root, path);
  if (!text.includes(from)) throw new Error(`${path} holds no ${from}`);
  await writeFile(join(root, path), text.replace(from, to));
}

export interface Api {
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, payload?: object): Promise<LightMyRequestResponse>;
  patch(url: string, payload: object): Promise<LightMyRequestResponse>;
  put(url: string, payload: object): Promise<LightMyRequestResponse>;
  delete(url: string): Promise<LightMyRequestResponse>;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Signed-in API calls of a test app. */
export function apiOf(app: FastifyInstance, user: SignedIn): Api {
  const headers = headersOf(user);
  function send(method: Method, url: string, payload?: object) {
    if (payload === undefined) return app.inject({ method, url, headers });
    return app.inject({ method, url, headers, payload });
  }
  return {
    get: (url) => send("GET", url),
    post: (url, payload = {}) => send("POST", url, payload),
    patch: (url, payload) => send("PATCH", url, payload),
    put: (url, payload) => send("PUT", url, payload),
    delete: (url) => send("DELETE", url),
  };
}

/** Adds a Local server through the API; fails the test unless 201. */
export async function addServer(
  api: Api,
  name: string,
  root: string,
): Promise<string> {
  const connector = { kind: "local", root };
  const response = await api.post("/api/v1/servers", { name, connector });
  if (response.statusCode !== 201) {
    throw new Error(`add server: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ id: string }>().id;
}

export interface ChipBody {
  kind: string;
  fileId: string;
  settingKey: string | null;
  label: string;
  from: unknown;
  to: unknown;
  restartRequired: boolean;
}

export interface LintBody {
  fileId: string | null;
  settingKey: string | null;
  code: string;
  severity: string;
  serverEvaluated: boolean;
}

export interface ChangeSetBody {
  id: string;
  status: string;
  cause: string;
  restoreOf: string | null;
  diff: {
    semantic: ChipBody[];
    text: { fileId: string; unifiedDiff: string }[];
  };
  lint: LintBody[];
  conflict: { files: { kind: string; fileId: string }[] } | null;
  error: { code: string; message: string } | null;
}

/** Makes a draft change set of setting edits and returns its body. */
export async function draft(
  api: Api,
  slug: string,
  edits: Record<string, unknown>,
): Promise<ChangeSetBody> {
  const list = Object.entries(edits).map(([settingKey, value]) => ({
    settingKey,
    value,
  }));
  const url = `/api/v1/servers/${slug}/change-sets`;
  const response = await api.post(url, { edits: list });
  if (response.statusCode !== 201) {
    throw new Error(`draft: ${response.statusCode} ${response.body}`);
  }
  return response.json<ChangeSetBody>();
}

/** Applies a change set and returns its body (any status). */
export async function apply(api: Api, id: string): Promise<ChangeSetBody> {
  const response = await api.post(`/api/v1/change-sets/${id}/apply`);
  if (response.statusCode !== 200) {
    throw new Error(`apply: ${response.statusCode} ${response.body}`);
  }
  return response.json<ChangeSetBody>();
}

/**
 * Applies a change set with a hook mode (P6-B, contract C5 runHooks) and
 * returns the whole response, because a refused apply is part of the test.
 */
export async function applyHooks(
  api: Api,
  id: string,
  runHooks: string,
): Promise<LightMyRequestResponse> {
  return api.post(`/api/v1/change-sets/${id}/apply`, { runHooks });
}

/** The status probe answer of a server (P6-B). */
export interface StatusBody {
  state: string;
  players: number | null;
  source: string | null;
  pending: number;
}

/** The status probe answer of a server (GET .../status). */
export async function statusOf(api: Api, slug: string): Promise<StatusBody> {
  const response = await api.get(`/api/v1/servers/${slug}/status`);
  if (response.statusCode !== 200) {
    throw new Error(`status: ${response.statusCode} ${response.body}`);
  }
  return response.json<StatusBody>();
}

/** The hook configuration view of a server (GET .../hooks). */
export async function hooksOf(api: Api, slug: string): Promise<unknown> {
  const response = await api.get(`/api/v1/servers/${slug}/hooks`);
  if (response.statusCode !== 200) {
    throw new Error(`hooks: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}

/** Sets the hook configuration of a server (PUT .../hooks). */
export async function putHooks(
  api: Api,
  slug: string,
  body: object,
): Promise<LightMyRequestResponse> {
  return api.put(`/api/v1/servers/${slug}/hooks`, body);
}

/** Runs one hook action (POST .../hooks/run). */
export async function runHook(
  api: Api,
  slug: string,
  action: string,
): Promise<LightMyRequestResponse> {
  return api.post(`/api/v1/servers/${slug}/hooks/run`, { action });
}

/** The pending change sets of a server (GET .../pending). */
export async function pendingOf(
  api: Api,
  slug: string,
): Promise<ChangeSetBody[]> {
  const response = await api.get(`/api/v1/servers/${slug}/pending`);
  if (response.statusCode !== 200) {
    throw new Error(`pending: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ items: ChangeSetBody[] }>().items;
}

/** An activity event row (contract C6). */
export interface ActivityRow {
  id: number;
  type: string;
  at: string;
  actor: string;
  data: unknown;
}

interface ActivityPage {
  items: ActivityRow[];
  nextBefore: number | null;
}

/** The activity events of a server, oldest first (GET /api/v1/activity). */
export async function activityOf(
  api: Api,
  slug: string,
): Promise<ActivityRow[]> {
  const rows: ActivityRow[] = [];
  let before: number | undefined;
  for (;;) {
    const query = new URLSearchParams({ serverId: slug, limit: "50" });
    if (before !== undefined) query.set("before", String(before));
    const response = await api.get(`/api/v1/activity?${query.toString()}`);
    if (response.statusCode !== 200) {
      throw new Error(`activity: ${response.statusCode} ${response.body}`);
    }
    const page = response.json<ActivityPage>();
    rows.push(...page.items);
    if (page.nextBefore === null) break;
    before = page.nextBefore;
  }
  return rows.reverse();
}

/** Makes and applies a change set of setting edits. */
export async function change(
  api: Api,
  slug: string,
  edits: Record<string, unknown>,
): Promise<ChangeSetBody> {
  return apply(api, (await draft(api, slug, edits)).id);
}

export interface HistoryBody {
  entries: {
    changeSetId: string;
    author: string;
    cause: string;
    status: string;
    chips: ChipBody[];
    snapshots: { id: string; fileId: string; kind: string }[];
  }[];
  visibleLimit: number | null;
  hiddenCount: number;
}

export async function history(api: Api, slug: string): Promise<HistoryBody> {
  const response = await api.get(`/api/v1/servers/${slug}/history`);
  if (response.statusCode !== 200) {
    throw new Error(`history: ${response.statusCode} ${response.body}`);
  }
  return response.json<HistoryBody>();
}
