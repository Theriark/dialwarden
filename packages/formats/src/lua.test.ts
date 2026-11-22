import { describe, expect, it } from "vitest";
import {
  bytes,
  checkDocument,
  edited,
  errorCode,
  text,
} from "../test/harness.js";
import { fixture, luaKit } from "../test/kits.js";
import { luaAdapter as lua, type LuaLocator } from "./index.js";

function path(...keys: (string | number)[]): LuaLocator {
  return { kind: "lua", path: keys };
}

function sandbox(...keys: (string | number)[]): LuaLocator {
  return path("SandboxVars", ...keys);
}

describe("Lua: SandboxVars assignment", () => {
  const data = fixture("lua/sandbox-like.lua");
  const source = text(data);
  const doc = lua.parse(data);

  it("reads numbers, strings, booleans, nil and tables", () => {
    expect(lua.lint(doc)).toEqual([]);
    expect(lua.get(doc, sandbox("Zombies"))).toBe(3);
    expect(lua.get(doc, sandbox("DayLength"))).toBe(2.5);
    expect(lua.get(doc, sandbox("StartMonth"))).toBe(-1);
    expect(lua.get(doc, sandbox("HexValue"))).toBe(31);
    expect(lua.get(doc, sandbox("Name"))).toBe('Pine Hollow "East"');
    expect(lua.get(doc, sandbox("Note"))).toBe("single quoted");
    expect(lua.get(doc, sandbox("Enabled"))).toBe(true);
    expect(lua.get(doc, sandbox("Nothing"))).toBeNull();
    expect(lua.get(doc, sandbox("Spaced Key"))).toBe("bracket key");
    expect(lua.get(doc, sandbox("ZombieLore", "Speed"))).toBe(2);
    expect(lua.get(doc, sandbox("List"))).toEqual(["a", "b", "c"]);
    expect(lua.get(doc, sandbox("List", 2))).toBe("b");
    expect(lua.get(doc, sandbox("Missing"))).toBeUndefined();
    expect(lua.get(doc, path("Nope", "x"))).toBeUndefined();
  });

  it("replaces one value and keeps comments and quotes", () => {
    const set = (keys: (string | number)[], value: string | number | boolean) =>
      edited(lua, data, (d) => lua.set(d, sandbox(...keys), value));
    expect(set(["Zombies"], 4)).toBe(
      source.replace("Zombies = 3,", "Zombies = 4,"),
    );
    expect(set(["DayLength"], 3)).toBe(source.replace("2.5", "3.0"));
    expect(set(["StartMonth"], 2)).toBe(source.replace("= -1", "= 2"));
    expect(set(["Note"], "it's")).toBe(
      source.replace("'single quoted'", "'it\\'s'"),
    );
    expect(set(["Enabled"], false)).toBe(
      source.replace("Enabled = true", "Enabled = false"),
    );
    expect(set(["List", 1], "z")).toBe(source.replace('{ "a",', '{ "z",'));
    const multiline = edited(lua, data, (d) =>
      lua.set(d, sandbox("Name"), "x\ny"),
    );
    expect(lua.get(lua.parse(bytes(multiline)), sandbox("Name"))).toBe("x\ny");
  });

  it("keeps a trailing comment with the field it follows", () => {
    const insert = (input: string) =>
      edited(lua, input, (d) => lua.insert(d, path("t", "c"), 3));
    expect(insert("t = {\n  a = 1, -- one\n  b = 2 -- two\n}\n")).toBe(
      "t = {\n  a = 1, -- one\n  b = 2, -- two\n  c = 3\n}\n",
    );
    expect(insert("t = {\n  a = 1,   \n  b = 2, -- two\n}\n")).toBe(
      "t = {\n  a = 1,   \n  b = 2, -- two\n  c = 3,\n}\n",
    );
    // A long comment may run past the line: the field goes before it.
    expect(insert("t = {\n  b = 2, --[[ two\n  ]]\n}\n")).toBe(
      "t = {\n  b = 2,\n  c = 3, --[[ two\n  ]]\n}\n",
    );
  });

  it("inserts fields in the style of the table", () => {
    const key = edited(lua, data, (d) => lua.insert(d, sandbox("NewKey"), 7));
    expect(key).toBe(
      source.replace("Unknown = 42,\n", "Unknown = 42,\n    NewKey = 7,\n"),
    );
    const item = edited(lua, data, (d) =>
      lua.insert(d, sandbox("List", 4), "d"),
    );
    expect(item).toBe(source.replace('"c" }', '"c", "d" }'));
    const bracket = edited(lua, data, (d) =>
      lua.insert(d, sandbox("ZombieLore", "Weird Key"), 1),
    );
    expect(bracket).toBe(
      source.replace(
        "Strength = 2,\n",
        'Strength = 2,\n        ["Weird Key"] = 1,\n',
      ),
    );
    const global = edited(lua, data, (d) =>
      lua.insert(d, path("NewGlobal"), { a: 1, "b c": [true, null] }),
    );
    expect(global).toBe(
      `${source}NewGlobal = { a = 1, ["b c"] = { true, nil } }\n`,
    );
  });

  it("removes fields with their line or their separator", () => {
    const remove = (...keys: (string | number)[]) =>
      edited(lua, data, (d) => lua.remove(d, sandbox(...keys)));
    expect(remove("Nothing")).toBe(source.replace("    Nothing = nil,\n", ""));
    expect(remove("Zombies")).toBe(
      source.replace("    Zombies = 3, -- a trailing comment\n", ""),
    );
    expect(remove("List", 2)).toBe(source.replace('"b", ', ""));
    expect(remove("List", 3)).toBe(source.replace(', "c"', ""));
    const all = edited(lua, data, (d) => lua.remove(d, path("SandboxVars")));
    expect(all).toBe(`${source.split("\n")[0]}\n`);
    expect(lua.remove(doc, sandbox("Missing"))).toEqual([]);
  });

  it("refuses edits that do not fit", () => {
    expect(errorCode(() => lua.insert(doc, sandbox("Zombies"), 1))).toBe(
      "exists",
    );
    expect(errorCode(() => lua.insert(doc, path("X", "Y"), 1))).toBe(
      "not-found",
    );
    expect(errorCode(() => lua.insert(doc, path(), 1))).toBe("invalid-locator");
    expect(errorCode(() => lua.insert(doc, path("not a name"), 1))).toBe(
      "invalid-locator",
    );
    expect(errorCode(() => lua.get(doc, path(1.5)))).toBe("invalid-locator");
    expect(errorCode(() => lua.set(doc, sandbox("Nope"), 1))).toBe("not-found");
    expect(errorCode(() => lua.set(doc, sandbox("Zombies"), Infinity))).toBe(
      "invalid-value",
    );
  });
});

describe("Lua: return chunk with CRLF and a BOM", () => {
  const data = fixture("lua/return-table.lua");
  const source = text(data);
  const doc = lua.parse(data);

  it("reads and writes inside the returned table", () => {
    expect(lua.lint(doc)).toEqual([]);
    expect(lua.get(doc, path("override_enabled"))).toBe(true);
    expect(lua.get(doc, path("overrides", "season_start"))).toBe("autumn");
    expect(lua.get(doc, path("preset"))).toBe("long\r\nstring");
    const day = edited(lua, data, (d) =>
      lua.set(d, path("overrides", "day"), "shortday"),
    );
    expect(day).toBe(source.replace('"longday"', '"shortday"'));
    const flag = edited(lua, data, (d) =>
      lua.insert(d, path("new_flag"), false),
    );
    expect(flag).toBe(
      source.replace("string]],\r\n", "string]],\r\n  new_flag = false,\r\n"),
    );
  });
});

describe("Lua: errors and duplicates", () => {
  const codes = (input: string) =>
    lua.lint(lua.parse(bytes(input))).map((issue) => issue.code);

  it("reports what it does not support and refuses writes", () => {
    const doc = lua.parse(fixture("lua/malformed-unclosed-table.lua"));
    expect(lua.lint(doc).map((issue) => issue.code)).toEqual([
      "unclosed-table",
    ]);
    expect(errorCode(() => lua.set(doc, sandbox("Zombies"), 4))).toBe(
      "parse-error",
    );
    expect(codes("x = foo")).toEqual(["unsupported"]);
    expect(codes("x = 1 2")).toEqual(["unsupported"]);
    expect(codes('print("x")')).toEqual(["syntax"]);
    expect(codes('x = "abc')).toEqual(["unclosed-string"]);
    expect(codes("x = [[abc")).toEqual(["unclosed-long"]);
    expect(codes("x = 0b1")).toEqual(["syntax"]);
    expect(codes("return 5")).toEqual(["unsupported"]);
    expect(codes("x = { [true] = 1 }")).toEqual(["unsupported"]);
    expect(codes("x = { a }")).toEqual(["unsupported"]);
    expect(codes("x = - y")).toEqual(["unsupported"]);
    expect(codes("x = { a = 1 b = 2 }")).toEqual(["syntax"]);
    expect(codes("x = 1 return { a = 1 }")).toEqual(["unsupported"]);
  });

  it("refuses globals mixed with return { ... }", () => {
    // Fuzz seed 55001267: SandboxVars was listed but set found no such key.
    const seed = text(fixture("lua/sandbox-like.lua"));
    const mixed = seed.replace("true,\n", "true,}return {\n");
    const doc = lua.parse(bytes(mixed));
    expect(lua.lint(doc).map((issue) => issue.code)).toEqual(["unsupported"]);
    for (const locator of [sandbox("Zombies"), path("Disabled")]) {
      expect(errorCode(() => lua.set(doc, locator, 1))).toBe("parse-error");
      expect(errorCode(() => lua.remove(doc, locator))).toBe("parse-error");
    }
    checkDocument(luaKit, bytes(mixed), null, 1073741826);
  });

  it("warns about duplicates and reads the last one", () => {
    const doc = lua.parse(bytes("x = 1\nx = 2\nt = { a = 1, a = 2 }\n"));
    expect(lua.lint(doc).map((issue) => issue.code)).toEqual([
      "duplicate-key",
      "duplicate-key",
    ]);
    expect(lua.get(doc, path("x"))).toBe(2);
    expect(lua.get(doc, path("t", "a"))).toBe(2);
    expect(errorCode(() => lua.set(doc, path("x"), 3))).toBe("ambiguous");
    expect(errorCode(() => lua.set(doc, path("t", "a"), 3))).toBe("ambiguous");
    const out = edited(lua, "x = 1\nx = 2\n", (d) => lua.remove(d, path("x")));
    expect(out).toBe("");
  });

  it("decodes escapes, long strings and local assignments", () => {
    const doc = lua.parse(
      bytes('local s = "\\65\\x42\\u{43}\\z   D\\n"\nl = [==[\nline]==]\n'),
    );
    expect(lua.lint(doc)).toEqual([]);
    expect(lua.get(doc, path("s"))).toBe("ABCD\n");
    expect(lua.get(doc, path("l"))).toBe("line");
  });

  it("writes into empty tables", () => {
    const insert = (locator: LuaLocator, value: string | number) =>
      edited(lua, "t = {}\n", (d) => lua.insert(d, locator, value));
    expect(insert(path("t", "a"), 1)).toBe("t = { a = 1 }\n");
    expect(insert(path("t", 1), "x")).toBe('t = { "x" }\n');
    expect(insert(path("t", 5), 0)).toBe("t = { [5] = 0 }\n");
    const value = edited(lua, "t = 1\n", (d) => lua.set(d, path("t"), []));
    expect(value).toBe("t = {}\n");
  });
});
