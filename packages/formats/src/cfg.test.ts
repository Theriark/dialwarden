import { describe, expect, it } from "vitest";
import { bytes, edited, errorCode, text } from "../test/harness.js";
import { fixture } from "../test/kits.js";
import { cfgLocators } from "./cfg.js";
import { cfgAdapter as cfg, type CfgLocator } from "./index.js";

function command(name: string): CfgLocator {
  return { kind: "cfg", command: name };
}

describe("console cfg", () => {
  const data = fixture("cfg/server.cfg");
  const source = text(data);
  const doc = cfg.parse(data);

  it("reads the last statement of a command", () => {
    expect(cfg.lint(doc)).toMatchObject([
      { code: "duplicate-key", severity: "warning", line: 9 },
    ]);
    expect(cfg.get(doc, command("hostname"))).toBe("Granite Point | Friendly");
    expect(cfg.get(doc, command("sv_maxrate"))).toBe("0");
    expect(cfg.get(doc, command("sv_password"))).toBe("");
    expect(cfg.get(doc, command("mp_timelimit"))).toBe("30");
    expect(cfg.get(doc, command("server.hostname"))).toBe("Rust style name");
    expect(cfg.get(doc, command("server.worldsize"))).toBe("3000");
    expect(cfg.get(doc, command("sv_cheats"))).toBe("1");
    expect(cfg.get(doc, command("exec"))).toBe("banned_user.cfg");
    expect(cfg.get(doc, command("sv_tags"))).toBe("one,two");
    expect(cfg.get(doc, command("missing"))).toBeUndefined();
  });

  it("replaces the arguments and keeps quotes and comments", () => {
    const set = (name: string, value: string | number | boolean) =>
      edited(cfg, data, (d) => cfg.set(d, command(name), value));
    expect(set("hostname", "New Name")).toBe(
      source.replace('"Granite Point | Friendly"', '"New Name"'),
    );
    expect(set("sv_maxrate", 30000)).toBe(
      source.replace("sv_maxrate 0", "sv_maxrate 30000"),
    );
    expect(set("mp_timelimit", 45)).toBe(
      source.replace("mp_timelimit 30 //", "mp_timelimit 45 //"),
    );
    expect(set("server.maxplayers", 100)).toBe(
      source.replace("maxplayers 50;", "maxplayers 100;"),
    );
    expect(set("sv_cheats", false)).toBe(
      source.replace("SV_CHEATS 1", "SV_CHEATS 0"),
    );
    expect(set("exec", "two words")).toBe(
      source.replace("exec banned_user.cfg", 'exec "two words"'),
    );
  });

  it("refuses quotes and line breaks in values", () => {
    const name = command("hostname");
    expect(errorCode(() => cfg.set(doc, name, 'a"b'))).toBe("invalid-value");
    expect(errorCode(() => cfg.set(doc, name, "a\nb"))).toBe("invalid-value");
    expect(errorCode(() => cfg.set(doc, name, null))).toBe("invalid-value");
    expect(errorCode(() => cfg.set(doc, command("nope"), 1))).toBe("not-found");
  });

  // P10-A U2: a console may split a statement at ; even inside quotes, so
  // a string value with ; or a NUL is never written.
  it("U2 refuses a semicolon or a NUL in a value", () => {
    const name = command("server.hostname");
    const smuggled = 'Name"; quit; "x';
    expect(errorCode(() => cfg.set(doc, name, smuggled))).toBe("invalid-value");
    expect(errorCode(() => cfg.set(doc, name, "a; quit"))).toBe(
      "invalid-value",
    );
    expect(errorCode(() => cfg.set(doc, name, "a\0b"))).toBe("invalid-value");
    const add = (value: string) =>
      errorCode(() => cfg.insert(doc, command("fresh_command"), value));
    expect(add("x;y")).toBe("invalid-value");
    expect(cfg.set(doc, name, "Plain name").length).toBeGreaterThan(0);
  });

  it("appends new commands and refuses existing ones", () => {
    const out = edited(cfg, data, (d) =>
      cfg.insert(d, command("maxplayers"), 12),
    );
    expect(out).toBe(`${source}maxplayers 12\n`);
    const password = edited(cfg, data, (d) =>
      cfg.insert(d, command("rcon_password"), ""),
    );
    expect(password).toBe(`${source}rcon_password ""\n`);
    expect(errorCode(() => cfg.insert(doc, command("hostname"), "x"))).toBe(
      "exists",
    );
    expect(errorCode(() => cfg.insert(doc, command("two words"), 1))).toBe(
      "invalid-locator",
    );
    expect(errorCode(() => cfg.get(doc, command("")))).toBe("invalid-locator");
  });

  it("removes every statement of a command", () => {
    const remove = (name: string) =>
      edited(cfg, data, (d) => cfg.remove(d, command(name)));
    expect(remove("sv_cheats")).toBe(
      source.replace("sv_cheats 0\nSV_CHEATS 1\n", ""),
    );
    expect(remove("server.worldsize")).toBe(
      source.replace("50; server.worldsize 3000", "50"),
    );
    expect(remove("server.maxplayers")).toBe(
      source.replace("server.maxplayers 50; ", ""),
    );
    expect(remove("mp_timelimit")).toBe(
      source.replace("mp_timelimit 30 // minutes", " // minutes"),
    );
  });
});

describe("console cfg edge cases", () => {
  it("adds a value to a command without arguments", () => {
    const out = edited(cfg, "sv_lan\n", (d) =>
      cfg.set(d, command("sv_lan"), 1),
    );
    expect(out).toBe("sv_lan 1\n");
    expect(cfg.get(cfg.parse(bytes("sv_lan\n")), command("sv_lan"))).toBe("");
  });

  it("keeps a bare value apart from a command it touched", () => {
    const out = edited(cfg, 'x"".\n', (d) => cfg.set(d, command("x"), 0));
    expect(out).toBe("x 0\n");
    expect(cfg.get(cfg.parse(bytes(out)), command("x"))).toBe("0");
    const slash = edited(cfg, "x a//c\n", (d) =>
      cfg.set(d, command("x"), "b/"),
    );
    expect(slash).toBe('x "b/"//c\n');
  });

  it("refuses an edit that would turn a U+FEFF into a BOM", () => {
    const doc = cfg.parse(bytes(`Z\n${String.fromCharCode(0xfeff)}Z`));
    expect(cfg.get(doc, command("Z"))).toBe("");
    expect(errorCode(() => cfg.remove(doc, command("Z")))).toBe(
      "invalid-value",
    );
  });

  it("reads and replaces several arguments", () => {
    const doc = cfg.parse(bytes("sv_tags a b\n"));
    expect(cfg.get(doc, command("sv_tags"))).toBe("a b");
    const out = edited(cfg, "sv_tags a b\n", (d) =>
      cfg.set(d, command("sv_tags"), "c"),
    );
    expect(out).toBe("sv_tags c\n");
  });

  it("reports an unclosed quote and refuses writes", () => {
    const doc = cfg.parse(fixture("cfg/malformed-unclosed-quote.cfg"));
    expect(cfg.lint(doc).map((issue) => issue.code)).toEqual([
      "unclosed-string",
    ]);
    expect(errorCode(() => cfg.set(doc, command("hostname"), "x"))).toBe(
      "parse-error",
    );
  });

  it("keeps the BOM and CRLF and reads UTF-8", () => {
    const data = fixture("cfg/crlf-bom.cfg");
    const source = text(data);
    const doc = cfg.parse(data);
    expect(cfg.get(doc, command("hostname"))).toBe("Sjöstad");
    const out = edited(cfg, data, (d) => cfg.set(d, command("sv_lan"), 1));
    expect(out).toBe(source.replace("sv_lan 0", "sv_lan 1"));
    const added = edited(cfg, data, (d) => cfg.insert(d, command("x"), true));
    expect(added).toBe(`${source}x 1\r\n`);
  });
});

describe("console cfg # comments", () => {
  const data = fixture("cfg/hash-comments.cfg");
  const source = text(data);
  const doc = cfg.parse(data);
  const names = (d: typeof doc) => cfgLocators(d).map((l) => l.command);

  it("never reads a # comment line as a command", () => {
    // Repeated, empty and indented comment lines raise nothing; the one
    // warning is the real duplicate server.pvp / SERVER.PVP.
    expect(cfg.lint(doc)).toMatchObject([
      { code: "duplicate-key", severity: "warning", line: 15, column: 1 },
    ]);
    expect(names(doc)).toEqual([
      "server.hostname",
      "server.maxplayers",
      "server.tags",
      "server.pvp",
    ]);
    expect(cfg.get(doc, command("#"))).toBeUndefined();
    expect(cfg.get(doc, command("#server.pve"))).toBeUndefined();
    expect(cfg.get(doc, command("say"))).toBeUndefined();
    expect(cfg.get(doc, command("server.hostname"))).toBe("Hash Point");
    expect(cfg.get(doc, command("server.maxplayers"))).toBe("50");
    expect(cfg.get(doc, command("server.tags"))).toBe("a#b");
    expect(cfg.get(doc, command("server.pvp"))).toBe("false");
  });

  it("keeps comment lines byte for byte on every write", () => {
    const set = edited(cfg, data, (d) =>
      cfg.set(d, command("server.pvp"), true),
    );
    expect(set).toBe(source.replace("SERVER.PVP false", "SERVER.PVP true"));
    const removed = edited(cfg, data, (d) =>
      cfg.remove(d, command("server.pvp")),
    );
    expect(removed).toBe(
      source.replace("server.pvp true\nSERVER.PVP false\n", ""),
    );
    const beforeComment = edited(cfg, data, (d) =>
      cfg.remove(d, command("server.maxplayers")),
    );
    expect(beforeComment).toBe(source.replace("server.maxplayers 50; ", ""));
    const added = edited(cfg, data, (d) =>
      cfg.insert(d, command("server.pve"), false),
    );
    expect(added).toBe(`${source}server.pve 0\n`);
  });

  it("refuses to insert a command that would read back as a comment", () => {
    expect(errorCode(() => cfg.insert(doc, command("#x"), 1))).toBe(
      "invalid-locator",
    );
  });

  it("still warns on a real duplicate between comment lines", () => {
    const lines = cfg.parse(bytes("# a\nx 1\n# a\n  # a\nX 2\n"));
    expect(cfg.lint(lines)).toMatchObject([
      { code: "duplicate-key", severity: "warning", line: 5 },
    ]);
  });

  it("ends the line at a # where a statement starts", () => {
    const after = cfg.parse(bytes("x 1; # y 2; z 3\n"));
    expect(names(after)).toEqual(["x"]);
    const bom = String.fromCharCode(0xfeff);
    const crlf = cfg.parse(bytes(`${bom}# a\r\n# a\r\nx 1\r\n`));
    expect(cfg.lint(crlf)).toEqual([]);
    expect(names(crlf)).toEqual(["x"]);
  });
});
