// The Rust pack (dev-work-plan P7 step 1): the console convars of
// server.cfg and users.cfg, the launch convars of the args line, the quoted
// and bare value forms the server writes, and the rules of the pack draft.
// Every convar the pack does not know stays in the file untouched.
import { getAdapter } from "@dialwarden/formats";
import { validate, writeFileValues } from "@dialwarden/packs-schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureOf, fixtureValues, loadPack, ruleOf } from "../kit.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the fixtures folder of this pack */

const pack = loadPack("rust");
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (line: string) => new TextEncoder().encode(line);

const serverCfg = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/server.cfg`));
const usersCfg = () =>
  new Uint8Array(readFileSync(`${FIXTURES}/users.cfg`));

describe("Rust pack", () => {
  it("declares its files, probes and hooks", () => {
    expect(pack.files.map((file) => [file.id, file.adapter, file.applyPolicy]))
      .toEqual([
        ["servercfg", "cfg", "anytime"],
        ["userscfg", "cfg", "anytime"],
        ["launch", "launch", "anytime"],
      ]);
    // The whole instance lives under the identity folder of the default
    // LinuxGSM instance name.
    expect(pack.files[0]?.paths).toEqual({
      linux: ["server/rustserver/cfg/server.cfg"],
      windows: ["server/rustserver/cfg/server.cfg"],
    });
    expect(pack.probes).toEqual([
      {
        kind: "rustWebRcon",
        portSetting: "rcon.port",
        passwordSetting: "rcon.password",
        host: "127.0.0.1",
        allow: ["server.save", "quit"],
        saveCommand: "server.save",
        stopCommand: "quit",
      },
      {
        kind: "a2s",
        portSetting: "server.queryport",
        host: "127.0.0.1",
        players: true,
      },
    ]);
    expect(pack.hooksSupported).toEqual(["save", "stop"]);
  });

  it("reads quoted and bare values side by side (the convar trap)", () => {
    const { adapter, doc } = fixtureOf(pack, "servercfg");
    // The server writes every value in quotes; hand files mix both forms.
    // The value is the first word after the name, so an unquoted value with
    // spaces keeps only its first word in the game; the editor keeps the
    // text as written.
    expect(
      adapter.get(doc, { kind: "cfg", command: "server.saveinterval" }),
    ).toBe("300");
    expect(
      adapter.get(doc, { kind: "cfg", command: "server.description" }),
    ).toBe("");
    expect(
      adapter.get(doc, { kind: "cfg", command: "server.hostname" }),
    ).toBeUndefined();
  });

  it("writes a value with spaces and keeps the quoting", () => {
    const { adapter, bytes } = fixtureOf(pack, "servercfg");
    const written = writeFileValues(pack, "servercfg", bytes, [
      { key: "server.motd", value: "Welcome to the quarry lane" },
    ]);
    expect(text(written)).toContain('server.motd "Welcome to the quarry lane"');
    const reread = adapter.parse(written);
    expect(
      adapter.get(reread, { kind: "cfg", command: "server.motd" }),
    ).toBe("Welcome to the quarry lane");
    expect(written.byteLength).toBeGreaterThan(0);
  });

  it("keeps the convars it does not know byte for byte", () => {
    const before = text(serverCfg());
    const { adapter, bytes } = fixtureOf(pack, "servercfg");
    const written = writeFileValues(pack, "servercfg", bytes, [
      { key: "server.idlekick", value: 15 },
    ]);
    const after = text(written);
    // A stray colon, a convar the game renamed, a commented-out convar,
    // an indented comment line and a double-slash line all survive.
    for (const line of [
      'wipetimer.wipehourofday: "19"',
      "server.pvp true",
      "#server.pve false",
      "  # heli.bulletAccuracy 2",
      "// A double slash is not a comment to this game either",
    ]) {
      expect(after, line).toContain(line);
    }
    expect(after).not.toBe(before);
    // users.cfg holds admin lines no pack setting addresses; an edit to
    // server.cfg cannot touch it.
    expect(text(usersCfg())).toContain(
      'ownerid 76561198000000001 "Quarry Keeper"',
    );
    expect(adapter.get(adapter.parse(written), {
      kind: "cfg",
      command: "server.idlekick",
    })).toBe("15");
  });

  it("reads the launch convars of the args line", () => {
    const { adapter, doc } = fixtureOf(pack, "launch");
    expect(
      adapter.get(doc, { kind: "launch", flag: "+server.hostname" }),
    ).toBe("Quarry Lane");
    expect(
      adapter.get(doc, { kind: "launch", flag: "+server.level" }),
    ).toBe("Procedural Map");
    expect(
      adapter.get(doc, { kind: "launch", flag: "-batchmode" }),
    ).toBe(true);
    // The identity convar is not a pack setting; the line keeps it.
    expect(
      adapter.get(doc, { kind: "launch", flag: "+server.identity" }),
    ).toBe("rustserver");
  });

  it("adds a missing launch convar at the end of the line", () => {
    const line = bytesOf(
      '-batchmode +server.port 28015 +server.hostname "Old line"',
    );
    const launch = getAdapter("launch");
    if (launch === undefined) throw new Error("no launch adapter");
    // A switch given true lands on the line bare, the form the game
    // replays as 1.
    const written = writeFileValues(pack, "launch", line, [
      { key: "rcon.web", value: true },
    ]);
    expect(text(written)).toContain("+rcon.web");
    const reread = launch.parse(written);
    expect(
      launch.get(reread, { kind: "launch", flag: "+rcon.web" }),
    ).toBe(true);
  });

  it("shows no issue in its synthetic fixture", () => {
    expect(validate(pack, fixtureValues(pack))).toEqual([]);
  });

  it("flags the weak remote console password on the server only", () => {
    const weak = ruleOf(pack, "rcon-web-weak-password");
    expect(weak.serverEvaluated).toBe(true);
    const values = fixtureValues(pack);
    values.set("rcon.password", "short");
    expect(validate(pack, values)).toContainEqual({
      key: "rcon.password",
      severity: "error",
      message: expect.stringContaining("shorter than 12 characters"),
    });
    expect(
      validate(pack, values, { includeServerEvaluated: false }),
    ).toEqual([]);
  });

  it("flags colliding ports and the legacy console protocol", () => {
    const clash = fixtureValues(pack);
    clash.set("rcon.port", 28015);
    expect(validate(pack, clash)).toContainEqual({
      key: "server.port",
      severity: "error",
      message: expect.stringContaining("must all differ"),
    });
    const legacy = fixtureValues(pack);
    legacy.set("rcon.web", false);
    expect(validate(pack, legacy)).toContainEqual({
      key: "rcon.web",
      severity: "warning",
      message: expect.stringContaining("Legacy remote console"),
    });
  });

  it("marks a large map and a missing query port", () => {
    const large = fixtureValues(pack);
    large.set("server.worldsize", 5000);
    expect(validate(pack, large)).toContainEqual({
      key: "server.worldsize",
      severity: "warning",
      message: expect.stringContaining("above 4500 metres"),
    });
    const unset = fixtureValues(pack);
    unset.set("server.queryport", null);
    expect(validate(pack, unset)).toContainEqual({
      key: "server.queryport",
      severity: "warning",
      message: expect.stringContaining("No query port is set"),
    });
  });

  it("refuses the negative companion port on the launch line by rule", () => {
    // The adapter already refuses writing -1 as a value word (it would
    // read as a flag); the rule catches a raw-edited line.
    const values = fixtureValues(pack);
    values.set("app.port", -1);
    expect(validate(pack, values)).toContainEqual({
      key: "app.port",
      severity: "error",
      message: expect.stringContaining("Launch arguments cannot carry"),
    });
  });

  it("explains a zero decay scale", () => {
    const values = fixtureValues(pack);
    values.set("decay.scale", 0);
    expect(validate(pack, values)).toContainEqual({
      key: "decay.scale",
      severity: "info",
      message: expect.stringContaining("upkeep settings have no visible"),
    });
  });
});
