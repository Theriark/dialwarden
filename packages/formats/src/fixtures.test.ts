// Every synthetic fixture: it parses as expected (the malformed ones with an
// error), it round-trips byte for byte, every locator keeps the adapter
// contract, and writing each text value back changes no byte.

import { describe, expect, it } from "vitest";
import { checkDocument, text, type Kit } from "../test/harness.js";
import {
  cfgKit,
  fixture,
  fixtureNames,
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

interface Case {
  readonly kit: Kit;
  readonly folder: string;
  /** Files with a syntax error for this adapter. */
  readonly broken: readonly string[];
  /** Files where writing every text value back must change nothing. */
  readonly identity: readonly string[];
}

const CASES: Case[] = [
  {
    kit: ueIniKit,
    folder: "ueini",
    broken: ["malformed-unclosed-struct.ini"],
    identity: [
      "array-ops.ini",
      "palworld-crlf-bom.ini",
      "palworld-optionsettings.ini",
    ],
  },
  {
    kit: iniKit,
    folder: "ini",
    broken: ["malformed-section.ini"],
    identity: ["crlf-bom.ini", "duplicates.ini", "plain.ini"],
  },
  {
    kit: jsonKit,
    folder: "json",
    broken: ["jsonc-comments.json", "malformed-trailing-comma.json"],
    identity: [],
  },
  { kit: jsoncKit, folder: "json", broken: [], identity: [] },
  {
    kit: xmlKit,
    folder: "xml",
    broken: ["malformed-unclosed-tag.xml"],
    identity: ["crlf-bom.xml", "serverconfig-like.xml"],
  },
  {
    kit: luaKit,
    folder: "lua",
    broken: ["malformed-unclosed-table.lua"],
    identity: ["sandbox-like.lua"],
  },
  {
    kit: cfgKit,
    folder: "cfg",
    broken: ["malformed-unclosed-quote.cfg"],
    identity: ["crlf-bom.cfg", "hash-comments.cfg", "server.cfg"],
  },
  {
    kit: shellVarKit,
    folder: "shellvar",
    broken: ["environmentfile.conf", "malformed-unclosed-quote.cfg"],
    identity: ["linuxgsm.cfg"],
  },
  {
    kit: systemdKit,
    folder: "shellvar",
    broken: ["linuxgsm.cfg", "malformed-unclosed-quote.cfg"],
    identity: ["environmentfile.conf"],
  },
  {
    kit: launchKit,
    folder: "launch",
    broken: ["malformed-unclosed-quote.txt"],
    identity: ["ark-chain.txt", "palworld.txt", "source-plus.txt"],
  },
];

const VALUES = ["Fixture value", 42, true] as const;

for (const { kit, folder, broken, identity } of CASES) {
  describe(`${kit.name} fixtures`, () => {
    for (const name of fixtureNames(folder)) {
      it(`${name} round-trips and keeps the contract`, () => {
        const data = fixture(`${folder}/${name}`);
        const doc = kit.adapter.parse(data);
        const issues = kit.adapter.lint(doc);
        const errors = issues.filter((issue) => issue.severity === "error");
        expect(errors.length > 0).toBe(broken.includes(name));
        expect(kit.adapter.apply(data, [])).toEqual(data);
        for (const value of VALUES) {
          for (let pick = 0; pick < 60; pick += 6) {
            checkDocument(kit, data, value, pick);
          }
        }
      });
    }

    for (const name of identity) {
      it(`${name}: writing every text value back changes no byte`, () => {
        const data = fixture(`${folder}/${name}`);
        const doc = kit.adapter.parse(data);
        for (const locator of kit.locators(doc)) {
          const value = kit.adapter.get(doc, locator);
          if (typeof value !== "string") continue;
          const splices = kit.adapter.set(doc, locator, value);
          expect(text(kit.adapter.apply(data, splices))).toBe(text(data));
        }
      });
    }
  });
}
