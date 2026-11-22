import { describe, expect, it } from "vitest";
import { bytes, edited, errorCode, text } from "../test/harness.js";
import { fixture } from "../test/kits.js";
import {
  shellVarAdapter as shell,
  systemdEnvAdapter as systemd,
  type ShellVarLocator,
} from "./index.js";

function name(variable: string): ShellVarLocator {
  return { kind: "shellvar", name: variable };
}

describe("shell variables: LinuxGSM cfg", () => {
  const data = fixture("shellvar/linuxgsm.cfg");
  const source = text(data);
  const doc = shell.parse(data);

  it("reads values as text, the last assignment winning", () => {
    expect(shell.lint(doc).map((i) => [i.code, i.severity, i.line])).toEqual([
      ["expansion", "info", 9],
      ["duplicate-key", "warning", 12],
    ]);
    expect(shell.get(doc, name("servername"))).toBe("Quarry Lane Survivors");
    expect(shell.get(doc, name("serverpassword"))).toBe("");
    expect(shell.get(doc, name("maxplayers"))).toBe("20");
    expect(shell.get(doc, name("startparameters"))).toBe(
      "-name '${servername}' -port ${port}",
    );
    expect(shell.get(doc, name("branch"))).toBe("public");
    expect(shell.get(doc, name("unknownsetting"))).toBe("kept");
    expect(shell.get(doc, name("missing"))).toBeUndefined();
  });

  it("keeps the quoting style of the value it replaces", () => {
    const set = (variable: string, value: string | number) =>
      edited(shell, data, (d) => shell.set(d, name(variable), value));
    expect(set("servername", "Stone Hall")).toBe(
      source.replace('"Quarry Lane Survivors"', '"Stone Hall"'),
    );
    expect(set("maxplayers", 24)).toBe(
      source.replace('maxplayers="20"', 'maxplayers="24"'),
    );
    expect(set("branch", "beta")).toBe(source.replace("'public'", "'beta'"));
    expect(set("branch", "it's")).toBe(source.replace("'public'", `"it's"`));
    expect(set("unknownsetting", "a b")).toBe(
      source.replace("=kept  #", '="a b"  #'),
    );
    expect(set("servername", 'say "hi" $HOME')).toBe(
      source.replace('"Quarry Lane Survivors"', '"say \\"hi\\" \\$HOME"'),
    );
  });

  it("keeps variable references when a value is written back", () => {
    const value = shell.get(doc, name("startparameters"));
    const out = edited(shell, data, (d) =>
      shell.set(d, name("startparameters"), value ?? ""),
    );
    expect(out).toBe(source);
  });

  it("never writes a live command into a value that uses references", () => {
    // LinuxGSM sources the cfg with bash: only plain $NAME and ${NAME} stay
    // live; command substitution, arithmetic and ${...} operators are text.
    const set = (value: string) =>
      edited(shell, data, (d) => shell.set(d, name("startparameters"), value));
    const line = (value: string) =>
      source.replace(
        `"-name '\${servername}' -port \${port}"`,
        () => `"${value}"`,
      );
    expect(set("-port 2456 $(touch /tmp/x)")).toBe(
      line("-port 2456 \\$(touch /tmp/x)"),
    );
    expect(set("-port `id` $((1+1))")).toBe(line("-port \\`id\\` \\$((1+1))"));
    expect(set("-port ${port:-$(id)}")).toBe(line("-port \\${port:-\\$(id)}"));
    expect(set("-port ${port} -name $servername $1 $")).toBe(
      line("-port ${port} -name $servername \\$1 \\$"),
    );
    const out = set("-port 2456 $(touch /tmp/x) `id`");
    const after = shell.parse(bytes(out));
    expect(shell.get(after, name("startparameters"))).toBe(
      "-port 2456 $(touch /tmp/x) `id`",
    );
    expect(shell.lint(after).map((i) => i.code)).not.toContain("expansion");
  });

  it("appends, refuses and removes", () => {
    const added = edited(shell, data, (d) =>
      shell.insert(d, name("newsetting"), 5),
    );
    expect(added).toBe(`${source}newsetting="5"\n`);
    expect(errorCode(() => shell.insert(doc, name("port"), 1))).toBe("exists");
    expect(errorCode(() => shell.get(doc, name("1abc")))).toBe(
      "invalid-locator",
    );
    expect(errorCode(() => shell.set(doc, name("port"), "a\nb"))).toBe(
      "invalid-value",
    );
    expect(errorCode(() => shell.set(doc, name("nope"), "x"))).toBe(
      "not-found",
    );
    const both = edited(shell, data, (d) =>
      shell.remove(d, name("maxplayers")),
    );
    expect(both).toBe(
      source.replace('maxplayers="16"\n', "").replace('maxplayers="20"\n', ""),
    );
    const commented = edited(shell, data, (d) =>
      shell.remove(d, name("unknownsetting")),
    );
    expect(commented).toBe(
      source.replace("unknownsetting=kept  # trailing comment\n", ""),
    );
  });
});

describe("shell variables: .env", () => {
  const data = fixture("shellvar/sample.env");
  const source = text(data);
  const doc = shell.parse(data);

  it("unquotes and unescapes values", () => {
    expect(shell.lint(doc)).toEqual([]);
    expect(shell.get(doc, name("SERVER_NAME"))).toBe("Birch Hill");
    expect(shell.get(doc, name("MOTD"))).toBe('Line with "quotes" and $dollar');
    expect(shell.get(doc, name("EMPTY"))).toBe("");
    expect(shell.get(doc, name("SINGLE"))).toBe("literal $HOME");
  });

  it("writes plain words bare and the rest in double quotes", () => {
    const set = (variable: string, value: string) =>
      edited(shell, data, (d) => shell.set(d, name(variable), value));
    expect(set("SERVER_NAME", "Oak")).toBe(
      source.replace("Birch\\ Hill", "Oak"),
    );
    expect(set("SERVER_NAME", "Oak Hill")).toBe(
      source.replace("Birch\\ Hill", '"Oak Hill"'),
    );
    expect(set("EMPTY", "x")).toBe(source.replace("EMPTY=\n", "EMPTY=x\n"));
    const motd = shell.get(doc, name("MOTD"));
    expect(set("MOTD", String(motd))).toBe(source);
  });
});

describe("shell variables: systemd EnvironmentFile", () => {
  const data = fixture("shellvar/environmentfile.conf");
  const source = text(data);
  const doc = systemd.parse(data);

  it("reads unquoted values to the end of the line", () => {
    expect(systemd.lint(doc)).toEqual([]);
    expect(systemd.get(doc, name("SERVER_ARGS"))).toBe(
      "-batchmode -nographics",
    );
    expect(systemd.get(doc, name("GAME_TITLE"))).toBe("Copper Ridge");
    expect(systemd.get(doc, name("LITERAL"))).toBe("no $expansion here");
    expect(systemd.get(doc, name("INDENTED"))).toBe("spaced out");
  });

  it("writes in systemd's quoting", () => {
    const set = (variable: string, value: string) =>
      edited(systemd, data, (d) => systemd.set(d, name(variable), value));
    expect(set("SERVER_ARGS", "-a -b")).toBe(
      source.replace("-batchmode -nographics", "-a -b"),
    );
    expect(set("GAME_TITLE", 'x "y"')).toBe(
      source.replace('"Copper Ridge"', '"x \\"y\\""'),
    );
    expect(set("INDENTED", " pad")).toBe(
      source.replace("spaced out  ", '" pad"  '),
    );
    expect(set("LITERAL", "it's")).toBe(
      source.replace("'no $expansion here'", "it's"),
    );
    const added = edited(systemd, data, (d) =>
      systemd.insert(d, name("NEW"), 1),
    );
    expect(added).toBe(`${source}NEW=1\n`);
  });

  it("reads and writes backslashes as systemd does", () => {
    // Unquoted, \ keeps the next character: the service sees pass.
    const escaped = systemd.parse(bytes('A=pa\\ss\nB=c\\\\d\nC="e\\\\f"\n'));
    expect(systemd.lint(escaped)).toEqual([]);
    expect(systemd.get(escaped, name("A"))).toBe("pass");
    expect(systemd.get(escaped, name("B"))).toBe("c\\d");
    expect(systemd.get(escaped, name("C"))).toBe("e\\f");
    // A value with a \ is written in double quotes, the \ escaped.
    const out = edited(systemd, data, (d) =>
      systemd.set(d, name("SERVER_ARGS"), "pa\\ss"),
    );
    expect(out).toBe(source.replace("-batchmode -nographics", '"pa\\\\ss"'));
    expect(systemd.get(systemd.parse(bytes(out)), name("SERVER_ARGS"))).toBe(
      "pa\\ss",
    );
    const added = edited(systemd, data, (d) =>
      systemd.insert(d, name("NEW"), "x\\y"),
    );
    expect(added).toBe(`${source}NEW="x\\\\y"\n`);
  });

  it("follows each dialect's comment and line rules", () => {
    const broken = shell.lint(shell.parse(data));
    expect(broken.some((i) => i.severity === "error")).toBe(true);
    const lgsm = systemd.parse(fixture("shellvar/linuxgsm.cfg"));
    expect(systemd.lint(lgsm).some((i) => i.severity === "error")).toBe(true);
    const codes = (input: string) =>
      systemd.lint(systemd.parse(bytes(input))).map((i) => i.code);
    expect(codes("A=one \\\n")).toEqual(["syntax"]);
    expect(codes('A="open\n')).toEqual(["syntax"]);
    expect(codes("A='a'b'\n")).toEqual(["syntax"]);
    expect(codes('A="a"b"\n')).toEqual(["syntax"]);
  });
});

describe("shell variables: malformed files", () => {
  it("refuses an unclosed quote and unsupported lines", () => {
    const doc = shell.parse(fixture("shellvar/malformed-unclosed-quote.cfg"));
    expect(shell.lint(doc).map((issue) => issue.code)).toEqual(["syntax"]);
    expect(errorCode(() => shell.set(doc, name("servername"), "x"))).toBe(
      "parse-error",
    );
    const codes = (input: string) =>
      shell.lint(shell.parse(bytes(input))).map((issue) => issue.code);
    expect(codes("A=1 B=2\n")).toEqual(["syntax"]);
    expect(codes("echo hi\n")).toEqual(["syntax"]);
    expect(codes("A='open\n")).toEqual(["syntax"]);
    expect(codes("A=`date`\n")).toEqual(["expansion"]);
    expect(shell.get(shell.parse(bytes("A=x\\\ny\n")), name("A"))).toBe("xy");
  });

  it("ends a line continuation before appending a variable", () => {
    const out = edited(shell, "A=x\\\n", (d) => shell.insert(d, name("B"), 1));
    expect(out).toBe('A=x\\\n\nB="1"\n');
    const doc = shell.parse(bytes(out));
    expect(shell.get(doc, name("A"))).toBe("x");
    expect(shell.get(doc, name("B"))).toBe("1");
  });

  it("ends a lone \\ at the file end before appending a variable", () => {
    const out = edited(shell, 'A=""\\', (d) => shell.insert(d, name("B"), 1));
    expect(out).toBe('A=""\\\n\nB="1"');
    const doc = shell.parse(bytes(out));
    expect(shell.get(doc, name("A"))).toBe("");
    expect(shell.get(doc, name("B"))).toBe("1");
    const escaped = edited(shell, "A=x\\\\", (d) =>
      shell.insert(d, name("B"), 1),
    );
    expect(escaped).toBe('A=x\\\\\nB="1"');
  });
});
