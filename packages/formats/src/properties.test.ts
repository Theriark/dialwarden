// fast-check properties of every adapter:
// - one edit changes only its span (and reads back, see checkDocument);
// - parse(write(x)) equals x: a model written key by key with insert reads
//   back key by key with get.

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bytes,
  checkDocument,
  documents,
  jsonValue,
  luaValue,
  scalarValue,
  text,
  textValue,
  type Kit,
} from "../test/harness.js";
import {
  cfgKit,
  iniKit,
  jsoncKit,
  jsonKit,
  launchKit,
  luaKit,
  shellVarKit,
  systemdKit,
  ueIniKit,
  xmlKit,
} from "../test/kits.js";
import { FormatError, type Locator, type Splice, type Value } from "./index.js";

const KITS = [
  ueIniKit,
  iniKit,
  jsonKit,
  jsoncKit,
  xmlKit,
  luaKit,
  cfgKit,
  shellVarKit,
  systemdKit,
  launchKit,
];

describe("property: one edit changes only its span", () => {
  for (const kit of KITS) {
    it(kit.name, () => {
      const property = fc.property(
        documents(kit),
        kit.values,
        fc.nat(),
        (data, value, pick) => checkDocument(kit, data, value, pick),
      );
      fc.assert(property, { numRuns: 150 });
    });
  }
});

type Entry = [Locator, Value];

/** Writes the entries one insert at a time; unwritable values are left out. */
function write(kit: Kit, base: string, entries: readonly Entry[]) {
  let data = bytes(base);
  const written: Entry[] = [];
  for (const [locator, value] of entries) {
    const doc = kit.adapter.parse(data);
    let splices: Splice[];
    try {
      splices = kit.adapter.insert(doc, locator, value);
    } catch (error) {
      if (error instanceof FormatError && error.code === "invalid-value") {
        continue;
      }
      throw error;
    }
    data = kit.adapter.apply(data, splices);
    written.push([locator, value]);
  }
  return { data, written };
}

function readsBack(kit: Kit, base: string, entries: readonly Entry[]): void {
  const { data, written } = write(kit, base, entries);
  const doc = kit.adapter.parse(data);
  const errors = doc.issues.filter((issue) => issue.severity === "error");
  expect(errors).toEqual([]);
  for (const [locator, value] of written) {
    const got = kit.adapter.get(doc, locator);
    if (!kit.matches(value, got, undefined)) {
      const detail = JSON.stringify({ locator, value, got });
      throw new Error(`${kit.name}: ${detail} in ${text(data)}`);
    }
  }
}

interface Model {
  readonly kit: Kit;
  readonly base: string;
  readonly entries: fc.Arbitrary<Entry[]>;
}

const nameText = fc.string({
  unit: fc.constantFrom("a", "b", "Z", "_", "1"),
  maxLength: 6,
});
const identifier = nameText.filter((s) => /^[A-Za-z_]/.test(s));

const commandName = fc.string({
  unit: fc.constantFrom("a", "b", "_", ".", "1"),
  minLength: 1,
  maxLength: 6,
});

const SECTIONS = fc.constantFrom("Alpha", "Beta", "/Script/Game.Settings");

type IniRow = [string, string, Value];

function iniKey([section, key]: IniRow): string {
  return `${section}/${key.toLowerCase()}`;
}

function iniEntry([section, key, value]: IniRow): Entry {
  return [{ kind: "ini", section, key }, value];
}

function iniModel(kit: Kit): Model {
  const row = fc.tuple(SECTIONS, identifier, scalarValue);
  const rows = fc.uniqueArray(row, { selector: iniKey, maxLength: 8 });
  return { kit, base: "", entries: rows.map((list) => list.map(iniEntry)) };
}

function namedModel(
  kit: Kit,
  base: string,
  names: fc.Arbitrary<string>,
  values: fc.Arbitrary<Value>,
  locate: (name: string) => Locator,
): Model {
  const row = fc.tuple(names, values);
  const selector = ([name]: [string, Value]) => name.toLowerCase();
  const rows = fc.uniqueArray(row, { selector, maxLength: 8 });
  function entry([name, value]: [string, Value]): Entry {
    return [locate(name), value];
  }
  return { kit, base, entries: rows.map((list) => list.map(entry)) };
}

function pointer(key: string): Locator {
  const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
  return { kind: "json", pointer: `/${escaped}` };
}

function field(name: string): Locator {
  return { kind: "struct", key: "OptionSettings", field: name };
}

function property(name: string): Locator {
  return { kind: "xml", property: name };
}

function luaKey(name: string): Locator {
  return { kind: "lua", path: [name] };
}

function command(name: string): Locator {
  return { kind: "cfg", command: name };
}

function variable(name: string): Locator {
  return { kind: "shellvar", name };
}

function flag(name: string): Locator {
  return { kind: "launch", flag: `-${name}` };
}

const STRUCT = "[S]\nOptionSettings=()\n";
const JSONC = "{\n  // settings\n}\n";
const XML = "<ServerSettings>\n</ServerSettings>\n";

const MODELS: Model[] = [
  iniModel(ueIniKit),
  iniModel(iniKit),
  namedModel(ueIniKit, STRUCT, identifier, scalarValue, field),
  namedModel(jsonKit, "{\n}\n", textValue(6), jsonValue, pointer),
  namedModel(jsoncKit, JSONC, textValue(6), jsonValue, pointer),
  namedModel(xmlKit, XML, textValue(8), scalarValue, property),
  namedModel(luaKit, "return {\n}\n", textValue(6), luaValue, luaKey),
  namedModel(cfgKit, "", commandName, scalarValue, command),
  namedModel(shellVarKit, "", identifier, scalarValue, variable),
  namedModel(systemdKit, "", identifier, scalarValue, variable),
  namedModel(launchKit, "./server\n", identifier, scalarValue, flag),
];

describe("property: parse(write(x)) equals x", () => {
  MODELS.forEach(({ kit, base, entries }, i) => {
    it(`${kit.name} model ${i}`, () => {
      const written = fc.property(entries, (list) => {
        readsBack(kit, base, list);
      });
      fc.assert(written, { numRuns: 150 });
    });
  });
});
