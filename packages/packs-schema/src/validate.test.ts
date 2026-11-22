import { describe, expect, it } from "vitest";
import {
  GOLDEN_ISSUES,
  GOLDEN_VALUES,
  settingOf,
  testPack,
  withSetting,
} from "../test/kit.js";
import type { JsonValue, Pack, PackFile } from "./types.js";
import {
  checkValue,
  effectiveValues,
  hasShellCharacters,
  validate,
} from "./validate.js";

const pack = testPack();

const SHELL_MESSAGE =
  "Must not contain ; & | ` ( ) < > \\, a line break or a $ other than a plain $NAME or ${NAME} reference: the server start script passes this value to a shell.";

/** The messages validate gives one setting for one value. */
function messagesFor(key: string, value: JsonValue, target: Pack = pack) {
  return validate(target, { [key]: value })
    .filter((issue) => issue.key === key && issue.severity === "error")
    .map((issue) => issue.message);
}

describe("validate(pack, values): types and ranges", () => {
  it("accepts the pack defaults", () => {
    expect(validate(pack, {})).toEqual([]);
    const defaults = effectiveValues(pack, new Map());
    expect(validate(pack, defaults)).toEqual([]);
  });

  it("checks whole numbers, min and max", () => {
    expect(messagesFor("MaxPlayers", 32)).toEqual([]);
    expect(messagesFor("MaxPlayers", 2.5)).toEqual(["Must be a whole number."]);
    expect(messagesFor("MaxPlayers", 0)).toEqual(["Must be at least 1."]);
    expect(messagesFor("MaxPlayers", 65)).toEqual(["Must be at most 64."]);
    expect(messagesFor("MaxPlayers", "16")).toEqual(["Must be a number."]);
    expect(messagesFor("DayLength", 5)).toEqual(["Must be at least 10 min."]);
  });

  it("checks steps from the minimum", () => {
    expect(messagesFor("Difficulty", 1.5)).toEqual([]);
    expect(messagesFor("Difficulty", 1.25)).toEqual([
      "Must be a multiple of 0.5.",
    ]);
    const noMin = withSetting(pack, "Difficulty", { min: undefined as never });
    expect(messagesFor("Difficulty", 0.25, noMin)).toEqual([
      "Must be a multiple of 0.5.",
    ]);
  });

  it("checks on/off, choices, text, lists and groups", () => {
    expect(messagesFor("PvP", "yes")).toEqual(["Must be on or off."]);
    expect(messagesFor("Mode", "Hardcore")).toEqual([]);
    expect(messagesFor("Mode", "Nightmare")).toEqual([
      "Must be one of the listed choices.",
    ]);
    expect(messagesFor("ServerName", 7)).toEqual(["Must be text."]);
    expect(messagesFor("ServerName", "x".repeat(65))).toEqual([
      "Allows at most 64 characters.",
    ]);
    const list = withSetting(pack, "ServerName", { type: "list", min: 1 });
    expect(messagesFor("ServerName", ["a", 1, true], list)).toEqual([]);
    expect(messagesFor("ServerName", [], list)).toEqual([
      "Needs at least 1 items.",
    ]);
    expect(messagesFor("ServerName", "a", list)).toEqual(["Must be a list."]);
    expect(messagesFor("ServerName", [["a"]], list)).toEqual([
      "List items must be text, numbers or on/off values.",
    ]);
    const group = withSetting(pack, "ServerName", { type: "struct" });
    expect(messagesFor("ServerName", { a: 1 }, group)).toEqual([]);
    expect(messagesFor("ServerName", [1], group)).toEqual([
      "Must be a group of fields.",
    ]);
  });

  it("accepts null as not set and refuses numbers that are not finite", () => {
    expect(checkValue(settingOf(pack, "MaxPlayers"), null)).toBeUndefined();
    expect(checkValue(settingOf(pack, "Difficulty"), Infinity)).toBe(
      "Must be a finite number.",
    );
  });

  it("refuses keys the pack does not have", () => {
    expect(validate(pack, { Unknown: 1 })).toEqual([
      { key: "Unknown", severity: "error", message: "Unknown setting." },
    ]);
  });

  it("gives the same issues for a plain object and a Map", () => {
    const values = { MaxPlayers: 0, Mode: "Hardcore", Unknown: true };
    const fromMap = validate(pack, new Map(Object.entries(values)));
    expect(validate(pack, values)).toEqual(fromMap);
    expect(fromMap.map((issue) => issue.key)).toEqual([
      "Unknown",
      "MaxPlayers",
      "Mode",
      "PvP",
    ]);
  });

  it("matches the written-out golden issues", () => {
    expect(validate(pack, GOLDEN_VALUES)).toEqual(GOLDEN_ISSUES);
  });
});

describe("validate(pack, values): rules", () => {
  it("fires a rule over the defaults overlaid with the values", () => {
    const issues = validate(pack, { Mode: "Hardcore" });
    const message =
      "Hardcore mode is meant to be played with player combat on.";
    expect(issues).toEqual([
      { key: "Mode", severity: "warning", message },
      { key: "PvP", severity: "warning", message },
    ]);
    expect(validate(pack, { Mode: "Hardcore", PvP: true })).toEqual([]);
  });

  it("reads dotted keys and info rules", () => {
    const fast = validate(pack, { "Options.ExpRate": 12, DayLength: 15 });
    expect(fast.map((issue) => [issue.key, issue.severity])).toEqual([
      ["DayLength", "info"],
      ["Options.ExpRate", "warning"],
    ]);
  });
});

describe("validate(pack, values): shell characters (X1)", () => {
  const refused = [
    "-port 2456; touch /tmp/x",
    "-port 2456 && reboot",
    "-name x | nc host 1",
    "-name `id`",
    "-name $(id)",
    "-name $((1+1))",
    "-port ${port:-2456}",
    "-port ${port:=$(id)}",
    "-port ${#port}",
    "-port ${port/2/3}",
    "-port ${port%6}",
    "-port ${port",
    "-port $1",
    "-pid $$",
    "-name $",
    "-port $port;reboot",
    "-log > /tmp/out",
    "-log < /etc/hosts",
    "-name x\nreboot",
    "-name x\r",
    "-name x\\y",
    "(subshell)",
  ];

  const ordinary = [
    "-port=7777 -log",
    "-port 2456 -public 1",
    "-name 'Quarry Lane Survivors' -world Dedicated",
    '-name "Synthetic Server" -players 16',
    "+maxplayers 16 +hostname Example",
    "TheIsland?listen?SessionName=Synthetic",
    "-world Dedicated -nosteam -crossplay",
    "-servername='${servername}' -port='${port}' -queryport='${steamport}'",
    "-port=$port -log -players=${maxplayers}",
  ];

  // The test pack's lgsm file uses the shellvar adapter; the same check must
  // hold for a text setting of the launch file and for shellvar-systemd.
  const launchText = withSetting(pack, "StartParameters", {
    file: "launch",
    locator: { kind: "launch", flag: "-extra" },
  });
  const systemd: Pack = {
    ...pack,
    files: pack.files.map((file): PackFile => {
      if (file.id !== "lgsm") return file;
      return { ...file, adapter: "shellvar-systemd" };
    }),
  };
  const shellPacks: [string, Pack][] = [
    ["shellvar", pack],
    ["launch", launchText],
    ["shellvar-systemd", systemd],
  ];

  it("refuses values a shell would act on in launch and shellvar files", () => {
    for (const [adapter, target] of shellPacks) {
      for (const value of refused) {
        const label = `${adapter}: ${value}`;
        const messages = messagesFor("StartParameters", value, target);
        expect(messages, label).toEqual([SHELL_MESSAGE]);
        const named = messagesFor("LgsmName", value, target);
        expect(named, label).toEqual([SHELL_MESSAGE]);
      }
    }
  });

  it("refuses shell characters in each list item", () => {
    const list = withSetting(launchText, "StartParameters", { type: "list" });
    const bad = ["-log", "-port 1;"];
    expect(messagesFor("StartParameters", bad, list)).toEqual([SHELL_MESSAGE]);
    expect(messagesFor("StartParameters", ["-log"], list)).toEqual([]);
  });

  it("lets ordinary arguments and plain variable references through", () => {
    for (const [adapter, target] of shellPacks) {
      for (const value of ordinary) {
        const messages = messagesFor("StartParameters", value, target);
        expect(messages, `${adapter}: ${value}`).toEqual([]);
      }
    }
  });

  it("checks every text inside lists and groups", () => {
    expect(hasShellCharacters(["-log", "-port 1;"])).toBe(true);
    expect(hasShellCharacters({ a: { b: "$(x)" } })).toBe(true);
    expect(hasShellCharacters({ a: { b: "${x}" } })).toBe(false);
    expect(hasShellCharacters({ a: ["-log", 1, true, null] })).toBe(false);
  });

  it("leaves files that no shell reads alone", () => {
    expect(messagesFor("ServerName", "Fish & Chips; (EU)")).toEqual([]);
  });
});
