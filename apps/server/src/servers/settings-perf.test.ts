// The performance test of P10-B (THE-2857): a synthetic ARK-style
// GameUserSettings.ini with 400 settings is read through the Local
// connector, parsed, validated (the pack lint) and served by GET
// /api/v1/servers/:slug/settings in under 200 ms on the server.
//
// SYNTHETIC: the pack and its file are generated here, by Theriark, in the
// layout of ARK: Survival Ascended (UE ini sections, ServerSettings and
// SessionSettings); no game publisher file or value is copied.
/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setupOwner,
  tempDir,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import { addServer, apiOf } from "../../test/servers.js";

/** The settings of the synthetic file, and the time the read may take. */
const SETTINGS = 400;
const LIMIT_MS = 200;

const GUS = "ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini";
const MARKER = "ShooterGame/Binaries/Win64/ArkAscendedServer.exe";
const TYPES = ["int", "float", "bool", "string"] as const;

interface Generated {
  readonly key: string;
  readonly section: string;
  readonly type: (typeof TYPES)[number];
  readonly value: string;
}

/** The 400 settings: a quarter of each type, over two sections. */
function generated(): Generated[] {
  return Array.from({ length: SETTINGS }, (_, index) => {
    const type = TYPES[index % TYPES.length] ?? "int";
    const section = index % 2 === 0 ? "ServerSettings" : "SessionSettings";
    const value =
      type === "int"
        ? String(index)
        : type === "float"
          ? `${index}.500000`
          : type === "bool"
            ? index % 3 === 0
              ? "True"
              : "False"
            : `Synthetic text ${index}`;
    return { key: `PerfSetting${index}`, section, type, value };
  });
}

/** The synthetic pack: one UE ini file holding every generated setting. */
function packOf(settings: readonly Generated[]) {
  return {
    id: "arkperf",
    version: "1.0.0",
    displayName: "Synthetic ARK performance game",
    steamAppId: 4000400,
    builds: { from: 0, to: null },
    os: ["linux"],
    detection: { markers: [{ path: MARKER }] },
    files: [
      {
        id: "gus",
        paths: { linux: [GUS] },
        adapter: "ueini",
        encoding: "utf-8",
        applyPolicy: "anytime",
      },
    ],
    settings: settings.map((setting, index) => ({
      key: setting.key,
      file: "gus",
      locator: { kind: "ini", section: setting.section, key: setting.key },
      type: setting.type,
      group: index < SETTINGS / 2 ? "First half" : "Second half",
      description: `Synthetic setting ${index} of the performance pack, a ${setting.type} value.`,
    })),
    rules: [],
    presets: [],
    probes: [],
    hooksSupported: [],
    sources: ["https://example.com/dialwarden/arkperf"],
  };
}

/** The file: both sections, every setting on its own line. */
function fileOf(settings: readonly Generated[]): string {
  const lines: string[] = [];
  for (const section of ["ServerSettings", "SessionSettings"]) {
    lines.push(`[${section}]`);
    for (const setting of settings) {
      if (setting.section !== section) continue;
      lines.push(`${setting.key}=${setting.value}`);
    }
    lines.push("");
  }
  return lines.join("\r\n");
}

let base: string;
let current: TestApp | undefined;

beforeEach(async () => {
  base = await tempDir("dialwarden-perf-");
});

afterEach(async () => {
  await current?.close();
  current = undefined;
  await rm(base, { recursive: true, force: true });
});

describe("settings read performance", () => {
  it(`parses, validates and serves ${SETTINGS} settings in under ${LIMIT_MS} ms`, async () => {
    const settings = generated();
    const packDir = join(base, "packs", "arkperf");
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, "pack.json"),
      JSON.stringify(packOf(settings)),
    );
    const root = join(base, "server");
    for (const path of [GUS, MARKER]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
    }
    await writeFile(join(root, MARKER), "");
    await writeFile(join(root, GUS), fileOf(settings));

    current = await testApp({ config: { packsDir: join(base, "packs") } });
    const api = apiOf(current.app, await setupOwner(current.app));
    const slug = await addServer(api, "Perf", root);
    const url = `/api/v1/servers/${slug}/settings`;

    // Warm-up: the first reads load code paths and fill caches.
    for (let i = 0; i < 2; i += 1) {
      expect((await api.get(url)).statusCode).toBe(200);
    }
    const times: number[] = [];
    interface Answer {
      values: Record<string, unknown>;
      lint: { severity: string }[];
    }
    let body: Answer = { values: {}, lint: [] };
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const response = await api.get(url);
      times.push(performance.now() - started);
      expect(response.statusCode).toBe(200);
      body = response.json<Answer>();
    }
    expect(Object.keys(body.values)).toHaveLength(SETTINGS);
    expect(body.values["PerfSetting0"]).toBe(0);
    expect(body.values["PerfSetting3"]).toBe("Synthetic text 3");
    expect(body.lint.filter((entry) => entry.severity === "error")).toEqual([]);
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
    expect(median, `read times ${sorted.join(", ")} ms`).toBeLessThan(LIMIT_MS);
  });
});
