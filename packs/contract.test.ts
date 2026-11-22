// Contract test of P3-B (dev-work-plan P3, Tests): every setting of the
// Palworld and Enshrouded packs round-trips through its P2 format adapter on
// the pack's synthetic fixture. For each setting the test writes another
// valid value and reads it back, checks that no other setting of the file
// changed, then writes the fixture value back and reads that again. The
// restored file must equal the fixture byte for byte, except where the
// adapter cannot put the old text back by design: a bare launch flag that was
// removed is added again at the end of the line, and a JSON list is written
// in JSON.stringify layout.
import type { FormatAdapter } from "@dialwarden/formats";
import { checkValue, sameJson, type Setting } from "@dialwarden/packs-schema";
import { describe, expect, it } from "vitest";
import {
  fixtureOf,
  loadPack,
  otherValue,
  readSetting,
  writeSetting,
} from "./kit.js";

const PACKS = ["palworld", "enshrouded"];

function exactRestore(adapter: FormatAdapter, setting: Setting): boolean {
  if (adapter.id === "launch" && setting.type === "bool") return false;
  return !(adapter.id === "json" && setting.type === "list");
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe.each(PACKS)("%s pack", (id) => {
  const pack = loadPack(id);
  const cases = pack.settings.map((setting) => [setting.key, setting] as const);

  it.each(cases)("round-trips %s through its adapter", (_key, setting) => {
    const { adapter, bytes, doc } = fixtureOf(pack, setting.file);
    const before = readSetting(adapter, doc, setting);
    if (before === undefined) throw new Error("not in the fixture");
    expect(checkValue(setting, before)).toBeUndefined();
    const next = otherValue(setting, before);
    expect(checkValue(setting, next)).toBeUndefined();

    const written = writeSetting(adapter, doc, setting.locator, next);
    const changed = adapter.parse(written);
    const errors = changed.issues.filter((issue) => issue.severity === "error");
    expect(errors).toEqual([]);
    expect(sameJson(readSetting(adapter, changed, setting), next)).toBe(true);
    for (const other of pack.settings) {
      if (other.file !== setting.file || other === setting) continue;
      const was = readSetting(adapter, doc, other);
      expect(readSetting(adapter, changed, other), other.key).toEqual(was);
    }

    const restored = writeSetting(adapter, changed, setting.locator, before);
    const reread = adapter.parse(restored);
    expect(sameJson(readSetting(adapter, reread, setting), before)).toBe(true);
    if (exactRestore(adapter, setting)) {
      expect(text(restored)).toBe(text(bytes));
    }
  });

  it("covers every file of the pack", () => {
    const files = new Set(pack.settings.map((setting) => setting.file));
    expect([...files].sort()).toEqual(pack.files.map((f) => f.id).sort());
  });
});
