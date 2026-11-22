import { describe, expect, it } from "vitest";
import { bytes, edited, errorCode, text } from "../test/harness.js";
import { fixture } from "../test/kits.js";
import {
  iniAdapter as ini,
  ueIniAdapter as ue,
  type IniLocator,
  type StructLocator,
} from "./index.js";

const PAL = "/Script/Pal.PalGameWorldSettings";

function field(name: string): StructLocator {
  return { kind: "struct", key: "OptionSettings", field: name };
}

function key(section: string | null, name: string, index?: number) {
  const locator: IniLocator = { kind: "ini", section, key: name };
  return index === undefined ? locator : { ...locator, index };
}

describe("UE INI: Palworld OptionSettings", () => {
  const data = fixture("ueini/palworld-optionsettings.ini");
  const source = text(data);
  const doc = ue.parse(data);

  it("parses the one-line struct without issues", () => {
    expect(ue.lint(doc)).toEqual([]);
    expect(ue.apply(data, [])).toEqual(data);
  });

  it("reads struct fields, nested lists and quoted strings", () => {
    expect(ue.get(doc, field("Difficulty"))).toBe("None");
    expect(ue.get(doc, field("servername"))).toBe("Lighthouse Keepers, (EU)");
    expect(ue.get(doc, field("ServerDescription"))).toBe("");
    expect(ue.get(doc, field("CrossplayPlatforms"))).toEqual([
      "Steam",
      "Xbox",
      "PS5",
      "Mac",
    ]);
    expect(ue.get(doc, field("Missing"))).toBeUndefined();
    expect(ue.get(doc, key(PAL, "OptionSettings"))).toMatchObject({
      Difficulty: "None",
      PublicPort: "8211",
    });
  });

  it("changes one field and nothing else", () => {
    const rate = edited(ue, data, (d) => ue.set(d, field("ExpRate"), 2));
    expect(rate).toBe(source.replace("ExpRate=1.500000", "ExpRate=2.000000"));
    const pvp = edited(ue, data, (d) => ue.set(d, field("bIsPvP"), true));
    expect(pvp).toBe(source.replace("bIsPvP=False", "bIsPvP=True"));
    const name = edited(ue, data, (d) =>
      ue.set(d, field("ServerName"), 'Quay "North"'),
    );
    expect(name).toBe(
      source.replace(
        'ServerName="Lighthouse Keepers, (EU)"',
        'ServerName="Quay \\"North\\""',
      ),
    );
    const list = edited(ue, data, (d) =>
      ue.set(d, field("CrossplayPlatforms"), ["Steam"]),
    );
    expect(list).toBe(
      source.replace(
        "CrossplayPlatforms=(Steam,Xbox,PS5,Mac)",
        "CrossplayPlatforms=(Steam)",
      ),
    );
  });

  it("inserts and removes fields with their commas", () => {
    const added = edited(ue, data, (d) =>
      ue.insert(d, field("bAllowGlobalPalboxExport"), true),
    );
    expect(added).toBe(
      source.replace(
        "bShowPlayerList=True)",
        "bShowPlayerList=True,bAllowGlobalPalboxExport=True)",
      ),
    );
    const middle = edited(ue, data, (d) => ue.remove(d, field("Region")));
    expect(middle).toBe(source.replace('Region="",', ""));
    const last = edited(ue, data, (d) =>
      ue.remove(d, field("bShowPlayerList")),
    );
    expect(last).toBe(source.replace(",bShowPlayerList=True", ""));
    const first = edited(ue, data, (d) => ue.remove(d, field("Difficulty")));
    expect(first).toBe(source.replace("Difficulty=None,", ""));
    expect(ue.remove(doc, field("Missing"))).toEqual([]);
  });

  it("refuses edits that do not fit", () => {
    expect(errorCode(() => ue.insert(doc, field("ExpRate"), 1))).toBe("exists");
    expect(errorCode(() => ue.set(doc, field("Nope"), 1))).toBe("not-found");
    const other: StructLocator = { kind: "struct", key: "Nope", field: "X" };
    expect(errorCode(() => ue.insert(doc, other, 1))).toBe("not-found");
    expect(errorCode(() => ue.set(doc, field("ExpRate"), "a\nb"))).toBe(
      "invalid-value",
    );
    expect(errorCode(() => ue.set(doc, field("ExpRate"), null))).toBe(
      "invalid-value",
    );
    expect(errorCode(() => ue.set(doc, field("ExpRate"), Infinity))).toBe(
      "invalid-value",
    );
    const badName: StructLocator = { kind: "struct", key: "K", field: "a..b" };
    expect(errorCode(() => ue.get(doc, badName))).toBe("invalid-locator");
    const spaced = field("Has space");
    expect(errorCode(() => ue.insert(doc, spaced, 1))).toBe("invalid-locator");
  });
});

describe("UE INI: a malformed OptionSettings never produces a write", () => {
  const data = fixture("ueini/malformed-unclosed-struct.ini");
  const doc = ue.parse(data);

  it("reports the unclosed struct where it opens", () => {
    const [issue] = ue.lint(doc);
    expect(issue).toMatchObject({
      code: "unclosed-struct",
      severity: "error",
      line: 3,
      column: 16,
    });
  });

  it("refuses set, insert and remove", () => {
    expect(errorCode(() => ue.set(doc, field("Difficulty"), "Hard"))).toBe(
      "parse-error",
    );
    expect(errorCode(() => ue.insert(doc, field("New"), 1))).toBe(
      "parse-error",
    );
    expect(errorCode(() => ue.remove(doc, field("Difficulty")))).toBe(
      "parse-error",
    );
    const whole = key(PAL, "OptionSettings");
    expect(errorCode(() => ue.set(doc, whole, "x"))).toBe("parse-error");
  });
});

describe("UE INI: CRLF, BOM and trailing spaces", () => {
  const data = fixture("ueini/palworld-crlf-bom.ini");
  const source = text(data);
  const doc = ue.parse(data);

  it("keeps the BOM, CRLF and trailing spaces on a write", () => {
    expect(doc.bom).toBe(true);
    expect(doc.newline).toBe("\r\n");
    expect(ue.lint(doc)).toEqual([]);
    expect(ue.get(doc, field("ServerName"))).toBe('Tidewater "North"');
    const out = edited(ue, data, (d) => ue.set(d, field("ExpRate"), 3));
    expect(out).toBe(source.replace("ExpRate=2.000000", "ExpRate=3.000000"));
    expect(out.startsWith("\\u{FEFF}")).toBe(true);
    const added = edited(ue, data, (d) => ue.insert(d, key(PAL, "Extra"), "1"));
    expect(added).toBe(
      source.replace("True)   \r\n", "True)   \r\nExtra=1\r\n"),
    );
  });
});

describe("UE INI: array operations, duplicates and unknown keys", () => {
  const data = fixture("ueini/array-ops.ini");
  const source = text(data);
  const doc = ue.parse(data);
  const settings = "ServerSettings";

  it("lints a key outside any section, a duplicate key and section", () => {
    const issues = ue.lint(doc);
    expect(issues.map((i) => i.code)).toEqual([
      "key-outside-section",
      "duplicate-key",
      "duplicate-section",
    ]);
    expect(issues.map((i) => i.line)).toEqual([2, 8, 16]);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("reads every operation of an array key, or one operation", () => {
    expect(ue.get(doc, key(settings, "BannedNames"))).toEqual([
      "ClearArray",
      "Grumpy Gary",
      "Sneaky Sam",
      "Grumpy Gary",
    ]);
    expect(ue.get(doc, key(settings, "+BannedNames"))).toEqual([
      "Grumpy Gary",
      "Sneaky Sam",
    ]);
    expect(ue.get(doc, key(settings, "-BannedNames"))).toBe("Grumpy Gary");
    expect(ue.get(doc, key(settings, "DifficultyOffset"))).toEqual([
      "0.5",
      "0.75",
    ]);
    expect(ue.get(doc, key(settings, "DifficultyOffset", 1))).toBe("0.75");
    expect(ue.get(doc, key(settings, "SecondBlockKey"))).toBe("True");
    expect(ue.get(doc, key(null, "TopLevel"))).toBe("outside any section");
    expect(ue.get(doc, key(settings, "ServerAdminPassword"))).toBe("");
    const rate = { kind: "struct", key: "ConfigOverride", field: "Rate" };
    expect(ue.get(doc, rate as StructLocator)).toBe("1.0");
  });

  it("needs an index to change a duplicated key", () => {
    const duplicated = key(settings, "DifficultyOffset");
    expect(errorCode(() => ue.set(doc, duplicated, 1))).toBe("ambiguous");
    const out = edited(ue, data, (d) =>
      ue.set(d, key(settings, "DifficultyOffset", 1), 1),
    );
    expect(out).toBe(
      source.replace("difficultyoffset=0.75", "difficultyoffset=1.00"),
    );
  });

  it("appends array operations next to their siblings", () => {
    const out = edited(ue, data, (d) =>
      ue.insert(d, key(settings, "+BannedNames"), "Quiet Quinn"),
    );
    expect(out).toBe(
      source.replace(
        "+BannedNames=Sneaky Sam\n",
        "+BannedNames=Sneaky Sam\n+BannedNames=Quiet Quinn\n",
      ),
    );
  });

  it("inserts into the last block of a section or a new section", () => {
    const out = edited(ue, data, (d) =>
      ue.insert(d, key(settings, "NewKey"), "x"),
    );
    expect(out).toBe(`${source}NewKey=x\n`);
    expect(out.endsWith("SecondBlockKey=True\nNewKey=x\n")).toBe(true);
    const fresh = edited(ue, data, (d) =>
      ue.insert(d, key("Brand New", "K"), 5),
    );
    expect(fresh).toBe(`${source}[Brand New]\nK=5\n`);
  });

  it("removes every operation of a key", () => {
    const out = edited(ue, data, (d) =>
      ue.remove(d, key(settings, "+BannedNames")),
    );
    expect(out).toBe(
      source
        .replace("+BannedNames=Grumpy Gary\n", "")
        .replace("+BannedNames=Sneaky Sam\n", ""),
    );
  });
});

describe("UE INI: struct edge cases", () => {
  it("inserts into empty structs and keeps a trailing comma", () => {
    const empty = edited(ue, "[S]\nA=()\n", (d) =>
      ue.insert(d, { kind: "struct", key: "A", field: "X" }, 1),
    );
    expect(empty).toBe("[S]\nA=(X=1)\n");
    const trailing = edited(ue, "[S]\nA=(B=1,)\n", (d) =>
      ue.insert(d, { kind: "struct", key: "A", field: "C" }, 2),
    );
    expect(trailing).toBe("[S]\nA=(B=1,C=2,)\n");
    const only = edited(ue, "[S]\nA=(B=1,)\n", (d) =>
      ue.remove(d, { kind: "struct", key: "A", field: "B" }),
    );
    expect(only).toBe("[S]\nA=()\n");
  });

  it("reads and writes nested fields with a dotted path", () => {
    const input = "[S]\nA=(Inner=(X=1,Y=2))\n";
    const inner: StructLocator = { kind: "struct", key: "A", field: "Inner.Y" };
    expect(ue.get(ue.parse(bytes(input)), inner)).toBe("2");
    const out = edited(ue, input, (d) => ue.set(d, inner, 5));
    expect(out).toBe("[S]\nA=(Inner=(X=1,Y=5))\n");
    const deeper: StructLocator = { kind: "struct", key: "A", field: "No.Y" };
    expect(ue.get(ue.parse(bytes(input)), deeper)).toBeUndefined();
  });

  it("writes objects and lists as structs", () => {
    const out = edited(ue, "[S]\nA=1\n", (d) =>
      ue.set(d, key("S", "A"), { X: 1, Y: "a b", Z: ["p", "q r"] }),
    );
    expect(out).toBe("[S]\nA=(X=1,Y=a b,Z=(p,q r))\n");
    const quoted = edited(ue, "[S]\nA=1\n", (d) =>
      ue.set(d, key("S", "A"), "(x"),
    );
    expect(quoted).toBe('[S]\nA="(x"\n');
    const doc = ue.parse(bytes("[S]\nA=1\n"));
    expect(errorCode(() => ue.set(doc, key("S", "A"), { "a b": 1 }))).toBe(
      "invalid-value",
    );
  });

  it("reports struct syntax errors and ambiguous structs", () => {
    const codes = (input: string) =>
      ue.lint(ue.parse(bytes(input))).map((issue) => issue.code);
    expect(codes('[S]\nA=(X="abc)\n')).toEqual(["unclosed-string"]);
    expect(codes('[S]\nA=(X=a"b)\n')).toEqual(["struct-syntax"]);
    expect(codes("[S]\nA=(X=1) extra\n")).toEqual(["syntax"]);
    expect(codes("[S]\nA=(X=1,X=2)\n")).toEqual(["duplicate-field"]);
    const twice = ue.parse(bytes("[S]\nA=(X=1)\n[T]\nA=(X=2)\n"));
    const x: StructLocator = { kind: "struct", key: "A", field: "X" };
    expect(errorCode(() => ue.get(twice, x))).toBe("ambiguous");
    const doubled = ue.parse(bytes("[S]\nA=(X=1,X=2)\n"));
    expect(errorCode(() => ue.get(doubled, x))).toBe("ambiguous");
  });

  it("counts columns in characters, not bytes", () => {
    const [issue] = ue.lint(ue.parse(bytes("[S]\nKé=(\n")));
    expect(issue).toMatchObject({
      code: "unclosed-struct",
      line: 2,
      column: 4,
    });
  });

  it("refuses keys an INI line cannot hold", () => {
    const doc = ue.parse(bytes("[S]\nA=1\n"));
    expect(errorCode(() => ue.insert(doc, key("S", "+"), 1))).toBe(
      "invalid-value",
    );
    expect(errorCode(() => ue.insert(doc, key("S", "a=b"), 1))).toBe(
      "invalid-value",
    );
    expect(errorCode(() => ue.insert(doc, key("a]b", "k"), 1))).toBe(
      "invalid-value",
    );
  });
});

describe("plain INI", () => {
  const data = fixture("ini/plain.ini");
  const source = text(data);
  const doc = ini.parse(data);

  it("reads values without the spaces around them", () => {
    expect(ini.lint(doc)).toEqual([]);
    expect(ini.get(doc, key("Server", "Name"))).toBe("Harbour Lights");
    expect(ini.get(doc, key("Server", "Motd"))).toBe("Welcome; be kind");
    expect(ini.get(doc, key("Server", "Quoted"))).toBe("  padded value  ");
    expect(ini.get(doc, key("Server", "Empty"))).toBe("");
    expect(ini.get(doc, key("World", "Seed"))).toBe("0451");
    expect(ini.get(doc, key("World", "Path"))).toBe("C:\\Games\\Harbour");
    expect(ini.get(doc, key("World", "Unknown.Key"))).toBe("kept");
    expect(ini.get(doc, key("world", "Seed"))).toBeUndefined();
  });

  it("replaces only the value and keeps trailing spaces", () => {
    const set = (name: string, value: string | number | boolean) =>
      edited(ini, data, (d) => ini.set(d, key("Server", name), value));
    expect(set("Name", "Harbour Lights II")).toBe(
      source.replace("Name = Harbour Lights  ", "Name = Harbour Lights II  "),
    );
    expect(set("Quoted", "x")).toBe(
      source.replace('"  padded value  "', '"x"'),
    );
    expect(set("Empty", 3)).toBe(source.replace("Empty=\n", "Empty=3\n"));
    expect(set("Port", true)).toBe(source.replace("Port=27015", "Port=true"));
    expect(set("Name", "  lead")).toBe(
      source.replace("Name = Harbour Lights  ", 'Name = "  lead"  '),
    );
  });

  it("refuses values plain INI cannot hold", () => {
    const name = key("Server", "Name");
    expect(errorCode(() => ini.set(doc, name, "a\nb"))).toBe("invalid-value");
    expect(errorCode(() => ini.set(doc, name, { a: 1 }))).toBe("invalid-value");
    expect(errorCode(() => ini.set(doc, name, null))).toBe("invalid-value");
    expect(errorCode(() => ini.insert(doc, key("Server", "Port"), 1))).toBe(
      "exists",
    );
    expect(errorCode(() => ini.set(doc, key("Server", "Nope"), 1))).toBe(
      "not-found",
    );
  });

  it("inserts after the last key of a section or at the top", () => {
    const out = edited(ini, data, (d) =>
      ini.insert(d, key("Server", "Rcon"), "on"),
    );
    expect(out).toBe(source.replace("Empty=\n", "Empty=\nRcon=on\n"));
    const top = edited(ini, data, (d) => ini.insert(d, key(null, "Top"), "1"));
    expect(top).toBe(`Top=1\n${source}`);
  });

  it("removes a key line and ignores a missing key", () => {
    const out = edited(ini, data, (d) => ini.remove(d, key("World", "Seed")));
    expect(out).toBe(source.replace("Seed=0451\n", ""));
    expect(ini.remove(doc, key("World", "Missing"))).toEqual([]);
  });

  it("checks locators and documents", () => {
    const struct: StructLocator = { kind: "struct", key: "A", field: "B" };
    expect(errorCode(() => ini.get(doc, struct))).toBe("invalid-locator");
    expect(errorCode(() => ini.get(doc, key("Server", "")))).toBe(
      "invalid-locator",
    );
    expect(errorCode(() => ini.get(doc, key("Server", "Name", -1)))).toBe(
      "invalid-locator",
    );
    const other = ue.parse(data);
    expect(errorCode(() => ini.get(other, key("Server", "Name")))).toBe(
      "wrong-document",
    );
  });
});

describe("plain INI: duplicates, CRLF and malformed files", () => {
  it("reads every occurrence and edits one by index", () => {
    const data = fixture("ini/duplicates.ini");
    const source = text(data);
    const doc = ini.parse(data);
    expect(ini.lint(doc).map((i) => [i.code, i.line])).toEqual([
      ["key-outside-section", 2],
      ["duplicate-key", 5],
      ["duplicate-section", 8],
    ]);
    expect(ini.get(doc, key("A", "Key"))).toEqual(["first", "second"]);
    expect(ini.get(doc, key("B", "Key"))).toBe("other section");
    const removed = edited(ini, data, (d) => ini.remove(d, key("A", "Key", 0)));
    expect(removed).toBe(source.replace("Key=first\n", ""));
    const inserted = edited(ini, data, (d) =>
      ini.insert(d, key("A", "Key", 1), "mid"),
    );
    expect(inserted).toBe(source.replace("Key=second", "Key=mid\nKey=second"));
  });

  it("keeps CRLF and the BOM and reads UTF-8", () => {
    const data = fixture("ini/crlf-bom.ini");
    const source = text(data);
    const doc = ini.parse(data);
    expect(ini.get(doc, key("General", "Title"))).toBe("Café Norte");
    const out = edited(ini, data, (d) =>
      ini.set(d, key("General", "Title"), "Café Sul"),
    );
    expect(out).toBe(source.replace("Café Norte", "Café Sul"));
    const added = edited(ini, data, (d) =>
      ini.insert(d, key("General", "Mode"), "pve"),
    );
    expect(added).toBe(source.replace("true\r\n", "true\r\nMode=pve\r\n"));
  });

  it("reports an unclosed section header and refuses writes", () => {
    const doc = ini.parse(fixture("ini/malformed-section.ini"));
    expect(ini.lint(doc)).toMatchObject([
      { code: "unclosed-section", severity: "error", line: 2, column: 1 },
    ]);
    expect(errorCode(() => ini.set(doc, key(null, "Name"), "x"))).toBe(
      "parse-error",
    );
  });

  it("reports lines that are not key=value", () => {
    const doc = ini.parse(bytes("[A]\njust words\n=no key\n[B] trailing\n"));
    expect(ini.lint(doc).map((i) => [i.code, i.severity])).toEqual([
      ["syntax", "error"],
      ["syntax", "error"],
      ["syntax", "warning"],
    ]);
  });
});
