// The browser half of contract C3: the shared validate() behind the editor's
// inline messages, with the server-evaluated rules skipped because the browser
// holds masked secrets (THE-2361).
import type { Pack } from "@dialwarden/packs-schema";
import { describe, expect, it } from "vitest";
import type { SettingsMeta } from "../api/schema";
import { issuesOf, packOf, settingsByKey } from "./pack";

const pack = {
  id: "testpack",
  version: "1.0",
  displayName: "Test Pack",
  steamAppId: 1,
  os: ["linux"],
  files: [
    {
      id: "settings",
      paths: { linux: ["s.ini"] },
      adapter: "ini",
      encoding: "utf-8",
      applyPolicy: "anytime",
    },
  ],
  settings: [
    {
      key: "expRate",
      label: "Exp rate",
      file: "settings",
      locator: { kind: "ini", section: null, key: "ExpRate" },
      type: "float",
      min: 0,
      max: 5,
      description: "How fast.",
    },
    {
      key: "difficulty",
      label: "Difficulty",
      file: "settings",
      locator: { kind: "ini", section: null, key: "Difficulty" },
      type: "enum",
      enum: [
        { value: "None", label: "None" },
        { value: "Hard", label: "Hard" },
      ],
      description: "How hard.",
    },
  ],
  rules: [
    {
      id: "r1",
      severity: "warning",
      message: "Hard mode wants a higher experience rate.",
      settings: ["expRate"],
      when: {
        and: [
          { "==": [{ var: "difficulty" }, "Hard"] },
          { "<": [{ var: "expRate" }, 2] },
        ],
      },
    },
    {
      id: "r2",
      severity: "error",
      message: "A server-evaluated rule.",
      settings: ["expRate"],
      when: { var: "expRate" },
      serverEvaluated: true,
    },
  ],
  presets: [],
  hooksSupported: [],
  sources: [],
} as unknown as Pack;

describe("issuesOf", () => {
  it("has nothing to say about valid values", () => {
    const issues = issuesOf(pack, { expRate: 2, difficulty: "Hard" });
    expect(issues.size).toBe(0);
  });

  it("carries the range and enum messages of the shared validate()", () => {
    const issues = issuesOf(pack, { expRate: 9, difficulty: "Extreme" });
    expect(issues.get("expRate")?.message).toBe("Must be at most 5.");
    expect(issues.get("difficulty")?.message).toBe(
      "Must be one of the listed choices.",
    );
  });

  it("marks a key the pack does not know", () => {
    const issues = issuesOf(pack, { surprise: 1 });
    expect(issues.get("surprise")?.message).toBe("Unknown setting.");
  });

  it("shows the pack's rule messages but skips server-evaluated rules", () => {
    const issues = issuesOf(pack, { expRate: 1, difficulty: "Hard" });
    expect(issues.get("expRate")?.message).toBe(
      "Hard mode wants a higher experience rate.",
    );
    const serverOnly = issuesOf(pack, { expRate: 1, difficulty: "None" });
    expect(serverOnly.has("expRate")).toBe(false);
  });
});

describe("packOf and settingsByKey", () => {
  it("casts a settings-meta answer to the pack the shared code uses", () => {
    const meta: SettingsMeta = {
      id: pack.id,
      version: "1.1",
      displayName: "Test Pack",
      steamAppId: 1,
      os: ["linux"],
      files: [],
      settings: [
        {
          key: "a",
          label: "A",
          file: "settings",
          locator: { kind: "ini", section: null, key: "A" },
          type: "bool",
          description: "One",
        },
      ],
      rules: [],
      presets: [],
      hooksSupported: [],
      sources: [],
    };
    const cast = packOf(meta);
    expect(cast.version).toBe("1.1");
    expect(cast.settings[0]?.key).toBe("a");
    expect(settingsByKey(cast.settings).get("a")?.type).toBe("bool");
  });
});
