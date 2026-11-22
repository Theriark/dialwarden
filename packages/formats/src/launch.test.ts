import { describe, expect, it } from "vitest";
import { bytes, edited, errorCode, text } from "../test/harness.js";
import { fixture } from "../test/kits.js";
import { launchAdapter as launch, type LaunchLocator } from "./index.js";

function flag(name: string): LaunchLocator {
  return { kind: "launch", flag: name };
}

describe("launch arguments: dash flags (Palworld)", () => {
  const data = fixture("launch/palworld.txt");
  const source = text(data);
  const doc = launch.parse(data);

  it("reads flags with values and bare flags", () => {
    expect(launch.lint(doc)).toEqual([]);
    expect(launch.get(doc, flag("-port"))).toBe("8211");
    expect(launch.get(doc, flag("-players"))).toBe("16");
    expect(launch.get(doc, flag("-useperfthreads"))).toBe(true);
    expect(launch.get(doc, flag("-noasyncloadingthread"))).toBe(true);
    expect(launch.get(doc, flag("-UseMultithreadForDS"))).toBe(true);
    expect(launch.get(doc, flag("-missing"))).toBeUndefined();
  });

  it("changes, switches off and adds flags", () => {
    const port = edited(launch, data, (d) =>
      launch.set(d, flag("-port"), 8212),
    );
    expect(port).toBe(source.replace("-port=8211", "-port=8212"));
    const off = edited(launch, data, (d) =>
      launch.set(d, flag("-useperfthreads"), false),
    );
    expect(off).toBe(source.replace(" -useperfthreads", ""));
    expect(launch.set(doc, flag("-useperfthreads"), true)).toEqual([]);
    const bare = edited(launch, data, (d) =>
      launch.insert(d, flag("-publiclobby"), true),
    );
    expect(bare).toBe(
      source.replace("EpicApp=PalServer\n", "EpicApp=PalServer -publiclobby\n"),
    );
    const valued = edited(launch, data, (d) =>
      launch.insert(d, flag("-logformat"), "text"),
    );
    expect(valued).toBe(
      source.replace("PalServer\n", "PalServer -logformat=text\n"),
    );
    const removed = edited(launch, data, (d) =>
      launch.remove(d, flag("-players")),
    );
    expect(removed).toBe(source.replace(" -players=16", ""));
  });

  it("refuses edits that do not fit", () => {
    const bare = flag("-useperfthreads");
    expect(errorCode(() => launch.set(doc, bare, "x"))).toBe("invalid-value");
    expect(errorCode(() => launch.insert(doc, flag("-port"), 1))).toBe(
      "exists",
    );
    expect(errorCode(() => launch.set(doc, flag("-nope"), 1))).toBe(
      "not-found",
    );
    expect(errorCode(() => launch.get(doc, flag("port")))).toBe(
      "invalid-locator",
    );
    expect(errorCode(() => launch.get(doc, flag("-")))).toBe("invalid-locator");
    expect(launch.insert(doc, flag("-new"), false)).toEqual([]);
  });
});

describe("launch arguments: ARK question-mark chain", () => {
  const data = fixture("launch/ark-chain.txt");
  const source = text(data);
  const doc = launch.parse(data);

  it("reads chain options in order", () => {
    expect(launch.lint(doc)).toEqual([]);
    expect(launch.get(doc, flag("?SessionName"))).toBe("Dune Riders");
    expect(launch.get(doc, flag("?MaxPlayers"))).toBe("20");
    expect(launch.get(doc, flag("?listen"))).toBe(true);
    expect(launch.get(doc, flag("?ServerAdminPassword"))).toBe("");
    expect(launch.get(doc, flag("?QueryPort"))).toBe("27015");
    expect(launch.get(doc, flag("-server"))).toBe(true);
  });

  it("edits an option inside or outside quotes", () => {
    const set = (name: string, value: string | number | boolean) =>
      edited(launch, data, (d) => launch.set(d, flag(name), value));
    expect(set("?MaxPlayers", 40)).toBe(
      source.replace("MaxPlayers=20", "MaxPlayers=40"),
    );
    expect(set("?SessionName", "Sand Kings")).toBe(
      source.replace('"Dune Riders"', '"Sand Kings"'),
    );
    expect(set("?ServerAdminPassword", "x1")).toBe(
      source.replace("ServerAdminPassword=?", "ServerAdminPassword=x1?"),
    );
    expect(set("?listen", false)).toBe(source.replace("?listen", ""));
    const doc2 = launch.parse(data);
    expect(errorCode(() => launch.set(doc2, flag("?MaxPlayers"), "a?b"))).toBe(
      "invalid-value",
    );
  });

  it("rewrites the chain word when an option spans quotes", () => {
    const out = edited(launch, data, (d) =>
      launch.remove(d, flag("?SessionName")),
    );
    const chain =
      '"TheIsland?listen?MaxPlayers=20?ServerAdminPassword=?QueryPort=27015"';
    const before =
      'TheIsland?listen?SessionName="Dune Riders"?MaxPlayers=20' +
      "?ServerAdminPassword=?QueryPort=27015";
    expect(out).toBe(source.replace(before, chain));
  });

  it("appends options to the end of the chain", () => {
    const valued = edited(launch, data, (d) =>
      launch.insert(d, flag("?NewOpt"), "v"),
    );
    expect(valued).toBe(
      source.replace("27015 -server", '27015"?NewOpt=v" -server'),
    );
    const after = launch.parse(bytes(valued));
    expect(launch.get(after, flag("?NewOpt"))).toBe("v");
    expect(launch.get(after, flag("?QueryPort"))).toBe("27015");
  });
});

describe("launch arguments: plus convars and quoting", () => {
  it("reads and edits plus convars and flag values", () => {
    const data = fixture("launch/source-plus.txt");
    const source = text(data);
    const doc = launch.parse(data);
    expect(launch.get(doc, flag("-game"))).toBe("csgo");
    expect(launch.get(doc, flag("+map"))).toBe("de_vertigo");
    expect(launch.get(doc, flag("+maxplayers"))).toBe("12");
    expect(launch.get(doc, flag("-console"))).toBe(true);
    const players = edited(launch, data, (d) =>
      launch.set(d, flag("+maxplayers"), 20),
    );
    expect(players).toBe(source.replace("+maxplayers 12", "+maxplayers 20"));
    expect(errorCode(() => launch.set(doc, flag("-game"), "-x"))).toBe(
      "invalid-value",
    );
    const lan = edited(launch, data, (d) =>
      launch.insert(d, flag("+sv_lan"), 1),
    );
    expect(lan).toBe(source.replace("12\n", "12 +sv_lan 1\n"));
    const map = edited(launch, data, (d) => launch.remove(d, flag("+map")));
    expect(map).toBe(source.replace(" +map de_vertigo", ""));
  });

  it("keeps quotes, continuations and CRLF", () => {
    const data = fixture("launch/quoted.txt");
    const source = text(data);
    const doc = launch.parse(data);
    expect(launch.get(doc, flag("-name"))).toBe("Moss & Stone");
    expect(launch.get(doc, flag("-world"))).toBe("Old Hearth");
    expect(launch.get(doc, flag("-password"))).toBe("");
    expect(launch.get(doc, flag("-public"))).toBe("1");
    const set = (name: string, value: string) =>
      edited(launch, data, (d) => launch.set(d, flag(name), value));
    expect(set("-name", "Fern & Ash")).toBe(
      source.replace('"Moss & Stone"', '"Fern & Ash"'),
    );
    expect(set("-world", "Hearth's End")).toBe(
      source.replace("'Old Hearth'", `"Hearth's End"`),
    );
    expect(set("-password", "x1")).toBe(
      source.replace('-password ""', "-password x1"),
    );
  });

  it("escapes values in single quotes", () => {
    const out = edited(launch, "-name='a b'\n", (d) =>
      launch.set(d, flag("-name"), "it's"),
    );
    expect(out).toBe(`-name=''"it's"''\n`);
    expect(launch.get(launch.parse(bytes(out)), flag("-name"))).toBe("it's");
  });

  it("reports an unclosed quote and duplicates", () => {
    const broken = launch.parse(fixture("launch/malformed-unclosed-quote.txt"));
    expect(launch.lint(broken).map((issue) => issue.code)).toEqual([
      "unclosed-quote",
    ]);
    expect(errorCode(() => launch.set(broken, flag("-name"), "x"))).toBe(
      "parse-error",
    );
    const twice = launch.parse(bytes("-a 1 -a 2\n"));
    expect(launch.lint(twice).map((issue) => issue.code)).toEqual([
      "duplicate-key",
    ]);
    expect(launch.get(twice, flag("-a"))).toBe("2");
    expect(errorCode(() => launch.set(twice, flag("-a"), 3))).toBe("ambiguous");
    expect(errorCode(() => launch.remove(twice, flag("-a")))).toBe("ambiguous");
  });

  it("doubles a lone backslash at the end before adding an argument", () => {
    const out = edited(launch, "-a \\", (d) => launch.insert(d, flag("-b"), 1));
    expect(out).toBe("-a \\\\ -b 1");
    const doc = launch.parse(bytes(out));
    expect(launch.get(doc, flag("-a"))).toBe("\\");
    expect(launch.get(doc, flag("-b"))).toBe("1");
    const chain = edited(launch, "Map?a\\", (d) =>
      launch.insert(d, flag("?b"), "x y"),
    );
    expect(chain).toBe('Map?a\\\\"?b=x y"');
    const after = launch.parse(bytes(chain));
    expect(launch.get(after, flag("?a\\"))).toBe(true);
    expect(launch.get(after, flag("?b"))).toBe("x y");
  });

  it("adds the first argument to an empty or comment-only file", () => {
    const empty = edited(launch, "", (d) => launch.insert(d, flag("-x"), true));
    expect(empty).toBe("-x");
    const comment = edited(launch, "# c", (d) =>
      launch.insert(d, flag("-x"), true),
    );
    expect(comment).toBe("-x # c");
    const none = launch.parse(bytes("./server"));
    expect(errorCode(() => launch.insert(none, flag("?A"), 1))).toBe(
      "not-found",
    );
  });
});
