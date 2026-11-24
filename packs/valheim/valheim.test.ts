// The Valheim pack (dev-work-plan P6-A step 6): the launch flags with their
// keyed -modifier and -setkey arguments, the -preset-first rule (the pack
// lint for hand-edited lines and the serializer for written ones), the launch
// sources of dev-work-plan P6-A step 5, and the rules of pack-draft-valheim.
// The access lists wait for file paths that follow -savedir (THE-2596 F3).
import { getAdapter } from "@dialwarden/formats";
import {
  checkValue,
  hasShellCharacters,
  launchPanelWarnings,
  launchSnippets,
  launchSourcePaths,
  launchSourceViews,
  lintFile,
  readLaunchSourceValues,
  renderLaunchLine,
  validate,
  writeFileValues,
  writeLaunchSourceValues,
  type JsonValue,
} from "@dialwarden/packs-schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fixtureValues,
  loadPack,
  ruleOf,
  settingOf,
  writeSetting,
} from "../kit.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the fixtures folder of this pack */

const pack = loadPack("valheim");
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const args = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/dialwarden-args.txt`));

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (line: string) => new TextEncoder().encode(line);

const PRESET_IDS = [
  "normal",
  "casual",
  "easy",
  "hard",
  "hardcore",
  "immersive",
  "hammer",
  "friends-relaxed",
];

/** The settings the preset-with-modifiers note names. */
const PRESET_NOTE = [
  "preset",
  "combat",
  "deathpenalty",
  "resources",
  "raids",
  "portals",
];

/** The value of one launch setting of a parsed line. */
function launchValue(line: string | Uint8Array, key: string): JsonValue {
  const setting = settingOf(pack, key);
  const launch = getAdapter("launch");
  if (launch === undefined) throw new Error("no launch adapter");
  const source = typeof line === "string" ? bytesOf(line) : line;
  const doc = launch.parse(source);
  const found = launch.get(doc, setting.locator);
  if (setting.type === "bool" && setting.locator.kind === "launch") {
    return found === undefined ? false : found === true ? true : found;
  }
  if (found === undefined) throw new Error(`${key} is not on the line`);
  return found;
}

/** The line after one launch setting is written. */
function launchWrite(
  line: string | Uint8Array,
  key: string,
  value: JsonValue,
): string {
  const setting = settingOf(pack, key);
  const launch = getAdapter("launch");
  if (launch === undefined) throw new Error("no launch adapter");
  const source = typeof line === "string" ? bytesOf(line) : line;
  const doc = launch.parse(source);
  return text(writeSetting(launch, doc, setting.locator, value));
}

describe("Valheim pack", () => {
  it("declares its files with the right policies and sources", () => {
    expect(pack.files.map((f) => [f.id, f.adapter, f.applyPolicy])).toEqual([
      ["launch", "launch", "anytime"],
    ]);
    expect(pack.hooksSupported).toEqual(["restart"]);
    expect(pack.probes).toEqual([
      {
        kind: "a2s",
        portSetting: "port",
        portOffset: 1,
        players: true,
      },
    ]);
    expect(PRESET_IDS).toEqual(pack.presets.map((p) => p.id));
  });

  it("declares four launch sources on the launch file", () => {
    const views = launchSourceViews(pack, "launch");
    expect(views.map((view) => view.kind)).toEqual([
      "args",
      "linuxgsm",
      "env",
      "panel",
    ]);
    expect(views.map((view) => view.writable)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    const env = pack.files[0]?.launchSources?.find((s) => s.kind === "env");
    if (env === undefined) throw new Error("no env source");
    expect(launchSourcePaths(pack, "launch", env, "linux")).toEqual([
      "valheim.env",
    ]);
    expect(launchSourcePaths(pack, "launch", env, "windows")).toEqual([]);
    const paths = launchSourcePaths(pack, "launch", { kind: "args" }, "linux");
    expect(paths).toEqual(["dialwarden-args.txt"]);
  });

  it("reads the fixture line: quoted words and two-token modifiers", () => {
    expect(launchValue(args(), "name")).toBe("Quarry Lane");
    // The adapter reads text; the pack types it (port 2456, public 1).
    expect(launchValue(args(), "port")).toBe("2456");
    expect(launchValue(args(), "public")).toBe("1");
    expect(launchValue(args(), "combat")).toBe("easy");
    expect(launchValue(args(), "raids")).toBe("none");
    expect(launchValue(args(), "preset")).toBe("casual");
    expect(launchValue(args(), "crossplay")).toBe(true);
    expect(launchValue(args(), "nomap")).toBe(true);
    // An absent bare flag reads as off, because leaving it out turns it off.
    expect(launchValue("-name x", "crossplay")).toBe(false);
  });

  it("edits keyed modifiers and setkeys on the line", () => {
    const line = launchWrite(args(), "combat", "veryhard");
    expect(launchValue(line, "combat")).toBe("veryhard");
    // Turning a modifier back to standard removes only its two words.
    const cleared = launchWrite(line, "combat", null);
    expect(cleared).not.toContain("-modifier combat");
    expect(launchValue(cleared, "raids")).toBe("none");
    expect(launchValue(cleared, "nomap")).toBe(true);
  });

  it("adds a missing setkey switch at the end of the line", () => {
    const bare = "-name x -modifier raids none";
    const withKey = launchWrite(bare, "nomap", true);
    expect(launchValue(withKey, "nomap")).toBe(true);
    expect(withKey.endsWith("-setkey nomap")).toBe(true);
    // Turning it off again removes its two words only.
    const off = launchWrite(withKey, "nomap", false);
    expect(off).not.toContain("-setkey");
    expect(launchValue(off, "raids")).toBe("none");
  });

  it("places -preset in front of the modifiers it would wipe", () => {
    const withModifiers =
      "-modifier combat hard -setkey nomap -name 'Later Preset'";
    const line = launchWrite(withModifiers, "preset", "casual");
    const at = line.indexOf("-preset casual");
    const modifier = line.indexOf("-modifier");
    const setkey = line.indexOf("-setkey");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(modifier).toBeGreaterThan(at);
    expect(setkey).toBeGreaterThan(at);
    expect(launchValue(line, "preset")).toBe("casual");
  });

  it("warns when a hand-edited line has -preset behind a modifier", () => {
    const wrong = bytesOf(
      "-name x -modifier combat easy -preset casual -setkey nomap",
    );
    const issues = lintFile(pack, "launch", wrong);
    const order = issues.filter((issue) => issue.code === "launch-order");
    expect(order).toHaveLength(1);
    expect(order[0]?.message).toContain("in front");
    // The keyed -modifier and -setkey flags may repeat without a warning.
    expect(issues.filter((issue) => issue.code === "duplicate-key")).toEqual(
      [],
    );
    const right = bytesOf(
      "-name x -preset casual -modifier combat easy -setkey nomap",
    );
    expect(
      lintFile(pack, "launch", right).filter((i) => i.code === "launch-order"),
    ).toEqual([]);
  });

  it("shows no issue in its synthetic fixture beyond the preset note", () => {
    const fixture = fixtureValues(pack);
    const issues = validate(pack, fixture);
    // The fixture line holds a preset and modifiers after it, so the info
    // rule that explains the order fires for exactly those settings.
    expect(issues).toEqual(
      PRESET_NOTE.map((key) => ({
        key,
        severity: "info",
        message: expect.stringContaining("refine the preset"),
      })),
    );
    expect(validate(pack, fixture, { includeServerEvaluated: false })).toEqual(
      issues,
    );
  });

  it("refuses a launch value a shell would act on (X1)", () => {
    const setting = settingOf(pack, "name");
    expect(hasShellCharacters("Lighthouse; rm -rf /")).toBe(true);
    expect(checkValue(setting, "Lighthouse; rm -rf /")).toBeUndefined();
    const fixture = fixtureValues(pack);
    fixture.set("name", "Lighthouse; rm -rf /");
    expect(validate(pack, fixture)).toContainEqual({
      key: "name",
      severity: "error",
      message: expect.stringContaining("passes this value to a shell"),
    });
  });

  it("checks the password rules on the server only", () => {
    const short = ruleOf(pack, "password-too-short-public");
    expect(short.serverEvaluated).toBe(true);
    const fixture = fixtureValues(pack);
    fixture.set("password", "tiny");
    const server = validate(pack, fixture);
    expect(server).toContainEqual({
      key: "password",
      severity: "error",
      message: expect.stringContaining("at least five characters"),
    });
    // The browser never sees the password text, so it judges none of the
    // secret rules: its issues are only the preset note of the fixture.
    const browser = validate(pack, fixture, {
      includeServerEvaluated: false,
    });
    expect(browser).toEqual(
      PRESET_NOTE.map((key) => ({
        key,
        severity: "info",
        message: expect.stringContaining("refine the preset"),
      })),
    );
    const inName = fixtureValues(pack);
    inName.set("password", "quarry");
    inName.set("name", "Quarry lane server (quarry)");
    expect(validate(pack, inName)).toContainEqual({
      key: "name",
      severity: "error",
      message: expect.stringContaining("appears inside the server name"),
    });
  });

  it("reads and writes the LinuxGSM instance cfg source", () => {
    const source = pack.files[0]?.launchSources?.find(
      (s) => s.kind === "linuxgsm",
    );
    if (source === undefined) throw new Error("no linuxgsm source");
    const cfg = bytesOf(
      "servername='Quarry Lane'\n" +
        "serverpassword='fjord-watch-7'\n" +
        "port='2456'\n" +
        "worldname='Dunninger'\n" +
        "public='1'\n" +
        "savedir='/data/saves'\n" +
        "saveinterval='1800'\n" +
        "backups='4'\n" +
        "backupshort='7200'\n" +
        "backuplong='43200'\n" +
        "instanceid='1'\n" +
        "logFile=''\n" +
        'worldmodifiers="-modifier combat easy"\n' +
        "startparameters=\"-crossplay -name '${servername}' -password ${serverpassword} -port ${port} -world ${worldname} -public ${public}\"\n" +
        'extraparams=""\n',
    );
    const values = readLaunchSourceValues(pack, "launch", source, cfg);
    expect(values.get("name")).toBe("Quarry Lane");
    expect(values.get("port")).toBe(2456);
    expect(values.get("combat")).toBe("easy");
    expect(values.get("crossplay")).toBe(true);
    // A mapped flag is written to its own variable, never to the template.
    const next = writeLaunchSourceValues(pack, "launch", source, cfg, [
      { key: "port", value: 2457 },
      { key: "combat", value: "hard" },
      { key: "nomap", value: true },
    ]);
    const line = text(next);
    expect(line).toContain("port='2457'");
    expect(line).toContain(
      'worldmodifiers="-modifier combat hard -setkey nomap"',
    );
    expect(line).toContain("-password ${serverpassword}");
    const reread = readLaunchSourceValues(
      pack,
      "launch",
      source,
      bytesOf(line),
    );
    expect(reread.get("port")).toBe(2457);
    expect(reread.get("combat")).toBe("hard");
    expect(reread.get("nomap")).toBe(true);
  });

  it("reads and writes the container env source with true and false", () => {
    const source = pack.files[0]?.launchSources?.find((s) => s.kind === "env");
    if (source === undefined) throw new Error("no env source");
    const env = bytesOf(
      "SERVER_NAME=Quarry Lane\n" +
        "SERVER_PORT=2456\n" +
        "SERVER_PUBLIC=true\n" +
        "SERVER_ARGS=-crossplay -saveinterval 1800\n" +
        "CROSSPLAY=false\n",
    );
    const values = readLaunchSourceValues(pack, "launch", source, env);
    expect(values.get("name")).toBe("Quarry Lane");
    expect(values.get("public")).toBe(1);
    expect(values.get("saveinterval")).toBe(1800);
    const next = writeLaunchSourceValues(pack, "launch", source, env, [
      { key: "public", value: 0 },
      { key: "saveinterval", value: 900 },
    ]);
    const line = text(next);
    expect(line).toContain("SERVER_PUBLIC=false");
    expect(line).toContain("SERVER_ARGS=-crossplay -saveinterval 900");
  });

  it("refuses to write the panel source and renders the copy text", () => {
    const source = pack.files[0]?.launchSources?.find(
      (s) => s.kind === "panel",
    );
    if (source === undefined) throw new Error("no panel source");
    expect(() =>
      writeLaunchSourceValues(pack, "launch", source, bytesOf(""), []),
    ).toThrowError(/panel manages this launch line/);
    const rendered = renderLaunchLine(pack, "launch", args(), [
      { key: "port", value: 2458 },
    ]);
    expect(rendered).toContain("-port 2458");
    expect(renderLaunchLine(pack, "launch", new Uint8Array(0), [])).toBe("");
    const warnings = launchPanelWarnings(pack, "launch");
    expect(warnings.map((w) => w.key)).toEqual([
      "name",
      "password",
      "port",
      "public",
      "world",
    ]);
  });

  it("renders the four one-line snippets of the args file", () => {
    const snippets = launchSnippets(
      "dialwarden-args.txt",
      "./valheim_server.x86_64",
    );
    expect(snippets.bash).toContain("$(cat dialwarden-args.txt)");
    expect(snippets.powershell).toContain("Get-Content dialwarden-args.txt");
    expect(snippets.compose).toContain("command: sh -c");
    expect(snippets.systemd).toContain("ExecStart=/bin/sh -c");
    // eval keeps the quoted words of the line together; Compose and systemd
    // need $$ for the $ of the command substitution.
    expect(snippets.bash).toBe(
      'set -f; eval "exec ./valheim_server.x86_64 $(cat dialwarden-args.txt)"',
    );
    expect(snippets.compose).toContain("$$(cat dialwarden-args.txt)");
    expect(snippets.systemd).toContain("$$(cat dialwarden-args.txt)");
    // set -f comes before eval in every shell form (no file patterns).
    for (const form of [snippets.bash, snippets.compose, snippets.systemd]) {
      expect(form.indexOf("set -f")).toBeGreaterThanOrEqual(0);
      expect(form.indexOf("set -f")).toBeLessThan(form.indexOf("eval"));
    }
  });

  it("refuses to add a line variable to a default LinuxGSM instance cfg", () => {
    const source = pack.files[0]?.launchSources?.find(
      (s) => s.kind === "linuxgsm",
    );
    if (source === undefined) throw new Error("no linuxgsm source");
    // A new instance cfg holds only a comment header (written here in our
    // own words); the start line lives in _default.cfg.
    const fresh = bytesOf(
      "##################################\n" +
        "# Instance settings: values here win over _default.cfg.\n" +
        "##################################\n",
    );
    for (const edit of [
      { key: "crossplay", value: true },
      { key: "crossplay", value: false },
      { key: "combat", value: "hard" },
    ]) {
      expect(() =>
        writeLaunchSourceValues(pack, "launch", source, fresh, [edit]),
      ).toThrowError(/copy the \w+ line from _default.cfg/);
    }
    // A flag with its own variable is still added: LinuxGSM reads it into
    // the default start line.
    const port = text(
      writeLaunchSourceValues(pack, "launch", source, fresh, [
        { key: "port", value: 2457 },
      ]),
    );
    expect(port).toContain("2457");
    expect(port).not.toContain("startparameters");
  });

  it("reads and writes the args source through the launch-source functions", () => {
    const source = { kind: "args" as const };
    const fixture = args();
    const values = readLaunchSourceValues(pack, "launch", source, fixture);
    expect(values.get("name")).toBe("Quarry Lane");
    expect(values.get("port")).toBe(2456);
    expect(values.get("public")).toBe(1);
    expect(values.get("combat")).toBe("easy");
    expect(values.get("crossplay")).toBe(true);
    expect(values.get("nomap")).toBe(true);
    const written = writeLaunchSourceValues(pack, "launch", source, fixture, [
      { key: "port", value: 2457 },
      { key: "combat", value: "hard" },
      { key: "nomap", value: false },
    ]);
    const expected = text(fixture)
      .replace("2456", "2457")
      .replace("combat easy", "combat hard")
      .replace(" -setkey nomap", "");
    expect(text(written)).toBe(expected);
    const reread = readLaunchSourceValues(pack, "launch", source, written);
    expect(reread.get("port")).toBe(2457);
    expect(reread.get("combat")).toBe("hard");
    expect(reread.get("nomap")).toBe(false);
    // An absent keyed switch reads as off on an empty file too.
    const empty = readLaunchSourceValues(
      pack,
      "launch",
      source,
      new Uint8Array(0),
    );
    expect(empty.get("nomap") ?? false).toBe(false);
  });

  it("rereads the container env source after a write", () => {
    const source = pack.files[0]?.launchSources?.find((s) => s.kind === "env");
    if (source === undefined) throw new Error("no env source");
    const env = bytesOf(
      "SERVER_NAME=Quarry Lane\n" +
        "SERVER_PORT=2456\n" +
        "SERVER_PUBLIC=true\n" +
        "SERVER_ARGS=-crossplay -saveinterval 1800\n" +
        "CROSSPLAY=false\n",
    );
    const next = writeLaunchSourceValues(pack, "launch", source, env, [
      { key: "public", value: 0 },
      { key: "saveinterval", value: 900 },
    ]);
    const reread = readLaunchSourceValues(pack, "launch", source, next);
    expect(reread.get("public")).toBe(0);
    expect(reread.get("saveinterval")).toBe(900);
    expect(reread.get("name")).toBe("Quarry Lane");
  });

  it("finds a keyed modifier whatever the case of its key", () => {
    // LinuxGSM documents the key as deathPenalty.
    const line = "-name x -modifier deathPenalty casual";
    expect(launchValue(line, "deathpenalty")).toBe("casual");
    const written = launchWrite(line, "deathpenalty", "hardcore");
    expect(written.match(/-modifier/g)).toHaveLength(1);
    expect(launchValue(written, "deathpenalty")).toBe("hardcore");
  });

  // Threat test T3 (security review THE-2598): typed values stay eval-safe.
  it("writes typed values with spaces and quotes that lint clean and read back", () => {
    const tricky = `Quarry "Lane" it's`;
    const written = writeFileValues(pack, "launch", args(), [
      { key: "name", value: `Quarry "Lane" it is` },
      { key: "world", value: "Dunninger" },
      { key: "savedir", value: tricky },
    ]);
    const errors = lintFile(pack, "launch", written).filter(
      (issue) => issue.severity === "error",
    );
    expect(errors).toEqual([]);
    const values = readLaunchSourceValues(
      pack,
      "launch",
      { kind: "args" },
      written,
    );
    expect(values.get("name")).toBe(`Quarry "Lane" it is`);
    expect(values.get("world")).toBe("Dunninger");
    expect(values.get("savedir")).toBe(tricky);
  });

  // Threat test T1 at pack level (security review THE-2598 F1).
  it("blocks a raw args line that holds a command substitution", () => {
    const raw = bytesOf(`${text(args()).trim()} -zz "$(touch /tmp/dw-pwn)"\n`);
    const issues = lintFile(pack, "launch", raw).filter(
      (issue) => issue.code === "shell-character",
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });
});
