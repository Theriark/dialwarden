import { describe, expect, it } from "vitest";
import {
  bytes,
  changedOnlySplices,
  edited,
  errorCode,
  text,
} from "../test/harness.js";
import { fixture } from "../test/kits.js";
import {
  jsonAdapter as json,
  jsoncAdapter as jsonc,
  type JsonLocator,
} from "./index.js";

function at(pointer: string): JsonLocator {
  return { kind: "json", pointer };
}

describe("strict JSON (Enshrouded)", () => {
  const data = fixture("json/enshrouded-like.json");
  const source = text(data);
  const doc = json.parse(data);

  it("reads values by JSON pointer", () => {
    expect(json.lint(doc)).toEqual([]);
    expect(json.get(doc, at("/name"))).toBe("Emberfall Watch");
    expect(json.get(doc, at("/gameSettings/playerHealthFactor"))).toBe(1.25);
    expect(json.get(doc, at("/gameSettings/dayTimeDuration"))).toBe(
      1800000000000,
    );
    expect(json.get(doc, at("/gameSettings/note"))).toBe(
      "Synthetic fixture written by Theriark / é",
    );
    expect(json.get(doc, at("/userGroups/0/name"))).toBe("Wardens");
    expect(json.get(doc, at("/userGroups/5"))).toBeUndefined();
    expect(json.get(doc, at("/missing"))).toBeUndefined();
    expect(json.get(doc, at("/name/deeper"))).toBeUndefined();
  });

  it("replaces one value and nothing else", () => {
    const factor = edited(json, data, (d) =>
      json.set(d, at("/gameSettings/playerHealthFactor"), 2),
    );
    expect(factor).toBe(source.replace("1.25", "2"));
    const name = edited(json, data, (d) => json.set(d, at("/name"), "New"));
    expect(name).toBe(source.replace('"Emberfall Watch"', '"New"'));
    const flag = edited(json, data, (d) =>
      json.set(d, at("/gameSettings/enableDurability"), false),
    );
    expect(flag).toBe(source.replace('true,\n    "day', 'false,\n    "day'));
  });

  it("inserts a property and keeps strict JSON", () => {
    const splices = json.insert(doc, at("/gameSettings/newFactor"), 0.5);
    const out = json.apply(data, splices);
    expect(changedOnlySplices(data, out, splices)).toBe(true);
    const after = json.parse(out);
    expect(json.lint(after)).toEqual([]);
    expect(json.get(after, at("/gameSettings/newFactor"))).toBe(0.5);
    expect(json.get(after, at("/gameSettings/note"))).toBe(
      "Synthetic fixture written by Theriark / é",
    );
    expect(text(out)).toContain('"newFactor": 0.5');
  });

  it("inserts into arrays at an index or at the end", () => {
    const append = edited(json, data, (d) =>
      json.insert(d, at("/userGroups/-"), { name: "Scouts" }),
    );
    const appended = json.parse(bytes(append));
    expect(json.get(appended, at("/userGroups/1/name"))).toBe("Scouts");
    const first = edited(json, data, (d) =>
      json.insert(d, at("/userGroups/0"), "front"),
    );
    const front = json.parse(bytes(first));
    expect(json.get(front, at("/userGroups/0"))).toBe("front");
    expect(json.get(front, at("/userGroups/1/name"))).toBe("Wardens");
  });

  it("removes properties and array items", () => {
    const out = edited(json, data, (d) => json.remove(d, at("/password")));
    const after = json.parse(bytes(out));
    expect(json.lint(after)).toEqual([]);
    expect(json.get(after, at("/password"))).toBeUndefined();
    expect(json.get(after, at("/name"))).toBe("Emberfall Watch");
    const item = edited(json, data, (d) => json.remove(d, at("/userGroups/0")));
    expect(json.get(json.parse(bytes(item)), at("/userGroups"))).toEqual([]);
    expect(json.remove(doc, at("/nope"))).toEqual([]);
  });

  it("refuses edits that do not fit", () => {
    expect(errorCode(() => json.set(doc, at("/missing"), 1))).toBe("not-found");
    expect(errorCode(() => json.set(doc, at("/name"), Number.NaN))).toBe(
      "invalid-value",
    );
    expect(errorCode(() => json.insert(doc, at("/name"), 1))).toBe("exists");
    expect(errorCode(() => json.insert(doc, at("/userGroups/9"), 1))).toBe(
      "not-found",
    );
    expect(errorCode(() => json.insert(doc, at("/nope/x"), 1))).toBe(
      "not-found",
    );
    expect(errorCode(() => json.insert(doc, at(""), 1))).toBe("not-found");
    expect(errorCode(() => json.remove(doc, at("")))).toBe("invalid-locator");
    expect(errorCode(() => json.get(doc, at("name")))).toBe("invalid-locator");
    const ini = { kind: "ini", section: null, key: "a" } as const;
    const wrong = ini as unknown as JsonLocator;
    expect(errorCode(() => json.get(doc, wrong))).toBe("invalid-locator");
  });

  it("replaces the whole document through the empty pointer", () => {
    const out = edited(json, "[1, 2]\n", (d) => json.set(d, at(""), { a: 1 }));
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });
});

describe("JSON pointers, encodings and line endings", () => {
  it("unescapes ~0 and ~1 in pointers", () => {
    const doc = json.parse(bytes('{"a/b": 1, "m~n": 2}'));
    expect(json.get(doc, at("/a~1b"))).toBe(1);
    expect(json.get(doc, at("/m~0n"))).toBe(2);
  });

  it("maps string offsets to bytes after multi-byte text", () => {
    const accent = edited(json, '{"é": "x", "k": 1}', (d) =>
      json.set(d, at("/k"), 2),
    );
    expect(accent).toBe('{"é": "x", "k": 2}');
    const emoji = edited(json, '{"😀": 1, "k": 1}', (d) =>
      json.set(d, at("/k"), 3),
    );
    expect(emoji).toBe('{"😀": 1, "k": 3}');
  });

  it("writes a one-line file without reformatting it", () => {
    const data = fixture("json/minified.json");
    const out = edited(json, data, (d) => json.insert(d, at("/c"), 1));
    expect(out).toBe(text(data).replace("null]}", 'null],"c": 1}'));
  });

  it("keeps the BOM, CRLF and tabs", () => {
    const data = fixture("json/crlf-bom.json");
    const source = text(data);
    const doc = json.parse(data);
    expect(json.lint(doc)).toEqual([]);
    expect(json.get(doc, at("/tags/1"))).toBe("ñandú");
    const out = edited(json, data, (d) =>
      json.set(d, at("/limits/players"), 12),
    );
    expect(out).toBe(source.replace("10", "12"));
    const added = edited(json, data, (d) => json.insert(d, at("/extra"), true));
    expect(added.startsWith("﻿")).toBe(true);
    expect(/[^\r]\n/.test(added)).toBe(false);
    expect(json.get(json.parse(bytes(added)), at("/extra"))).toBe(true);
  });

  it("reports invalid UTF-8 and an empty file as errors", () => {
    const invalid = json.parse(new Uint8Array([123, 255, 125]));
    const codes = json.lint(invalid).map((i) => [i.code, i.severity]);
    expect(codes).toContainEqual(["invalid-utf8", "error"]);
    const empty = json.parse(new Uint8Array());
    expect(json.lint(empty).some((i) => i.severity === "error")).toBe(true);
    expect(errorCode(() => json.insert(empty, at("/a"), 1))).toBe(
      "parse-error",
    );
  });

  it("warns about duplicate keys and refuses to write them", () => {
    const doc = json.parse(bytes('{"a": 1, "a": 2}'));
    expect(json.lint(doc)).toMatchObject([
      { code: "duplicate-key", severity: "warning", locator: at("/a") },
    ]);
    expect(json.get(doc, at("/a"))).toBe(2);
    expect(errorCode(() => json.set(doc, at("/a"), 3))).toBe("ambiguous");
  });
});

describe("strict JSON against JSON with comments", () => {
  it("refuses a trailing comma in strict JSON", () => {
    const data = fixture("json/malformed-trailing-comma.json");
    const doc = json.parse(data);
    expect(json.lint(doc).some((i) => i.severity === "error")).toBe(true);
    expect(errorCode(() => json.set(doc, at("/slotCount"), 5))).toBe(
      "parse-error",
    );
    expect(jsonc.lint(jsonc.parse(data))).toEqual([]);
  });

  it("refuses comments in strict JSON and keeps them in jsonc", () => {
    const data = fixture("json/jsonc-comments.json");
    const source = text(data);
    expect(json.lint(json.parse(data)).map((i) => i.code)).toContain("syntax");
    const doc = jsonc.parse(data);
    expect(jsonc.lint(doc)).toEqual([]);
    expect(jsonc.get(doc, at("/list"))).toEqual([1, 2, 3]);
    const out = edited(jsonc, data, (d) => jsonc.set(d, at("/mode"), "json"));
    expect(out).toBe(source.replace('"mode": "jsonc"', '"mode": "json"'));
  });
});
