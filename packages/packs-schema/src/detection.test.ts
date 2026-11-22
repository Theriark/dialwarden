import { describe, expect, it } from "vitest";
import { acf, testPack } from "../test/kit.js";
import {
  AcfError,
  appManifestPath,
  buildSupported,
  detectGames,
  MAX_ACF_BYTES,
  parseAppManifest,
  parseKeyValues,
  type DetectionProbe,
} from "./detection.js";

const pack = testPack();
const MANIFEST = appManifestPath(4000001);

/** A server folder made of the given files (path to bytes). */
function folder(files: Record<string, Uint8Array | string>): DetectionProbe {
  const map = new Map(Object.entries(files));
  return {
    exists: async (path) => map.has(path),
    read: async (path) => {
      const found = map.get(path);
      if (found === undefined) return null;
      if (typeof found !== "string") return found;
      return new TextEncoder().encode(found);
    },
  };
}

function parseError(text: string): string {
  try {
    parseKeyValues(text);
  } catch (error) {
    if (error instanceof AcfError) return error.message;
    throw error;
  }
  return "no error";
}

describe("appmanifest_APPID.acf parser", () => {
  it("reads the app id, build id, name and install folder", () => {
    expect(parseAppManifest(acf("appmanifest_4000001.acf"))).toEqual({
      appId: 4000001,
      buildId: 12345,
      name: "Synthetic Test Server",
      installDir: "Synthetic Test Server",
    });
  });

  it("matches keys without case, reads escapes and allows no build id", () => {
    expect(parseAppManifest(acf("lowercase-no-build.acf"))).toEqual({
      appId: 4000001,
      buildId: null,
      name: 'Synthetic "Quoted" Server\\Path',
      installDir: "SyntheticTestServer",
    });
  });

  it("keeps nested blocks and the first of two equal keys", () => {
    const root = parseKeyValues('"a" { "b" "1" "b" "2" "c" { "d" e } }');
    const a = root.get("a");
    expect(a instanceof Map ? a.get("b") : a).toBe("1");
    expect(a instanceof Map ? a.get("c") : a).toEqual(new Map([["d", "e"]]));
  });

  it("refuses malformed files with a reason", () => {
    expect(() => parseAppManifest(acf("malformed-unclosed.acf"))).toThrow(
      AcfError,
    );
    expect(parseError('"a" { "b" "1"')).toBe("a block is not closed");
    expect(parseError('"a" "1" }')).toBe("a closing brace has no block");
    expect(parseError('"a" { { } }')).toBe("a block has no key");
    expect(parseError('"a"')).toBe("a has no value");
    expect(parseError('"a" }')).toBe("a has no value");
    expect(parseError('"a" "unclosed')).toBe("unclosed quoted string");
    const huge = "x ".repeat(MAX_ACF_BYTES);
    expect(parseError(huge)).toBe("the file is too large");
    const deep = `${'"k" { '.repeat(20)}${"} ".repeat(20)}`;
    expect(parseError(deep)).toBe("blocks are nested too deeply");
    expect(parseError('"a" "1" // comment')).toBe("no error");
  });

  it("needs an AppState block with a numeric app id", () => {
    expect(() => parseAppManifest('"Other" { }')).toThrow(
      "the file has no AppState block",
    );
    expect(() => parseAppManifest('"AppState" { "appid" "x" }')).toThrow(
      "AppState has no numeric appid",
    );
  });
});

describe("game detection", () => {
  it("detects by app manifest with the installed build", async () => {
    const files = { [MANIFEST]: acf("appmanifest_4000001.acf") };
    expect(await detectGames([pack], folder(files))).toEqual([
      {
        packId: "testpack",
        by: "appmanifest",
        os: null,
        buildId: 12345,
        buildSupported: true,
        warnings: [],
      },
    ]);
  });

  it("detects by marker files and reports detection warnings", async () => {
    const files = { "TestServer.exe": "", "Saved/override.sav": "" };
    const [found] = await detectGames([pack], folder(files));
    expect(found?.by).toBe("markers");
    expect(found?.os).toBe("windows");
    expect(found?.warnings).toEqual([
      "An override save file exists: the game reads it instead of most of Game.ini.",
    ]);
  });

  it("ignores a manifest of another app or a broken one", async () => {
    const other = acf("appmanifest_4000001.acf");
    const text = new TextDecoder().decode(other).replace("4000001", "4000009");
    const moved = folder({ [MANIFEST]: text });
    expect(await detectGames([pack], moved)).toEqual([]);
    const broken = { [MANIFEST]: acf("malformed-unclosed.acf") };
    expect(await detectGames([pack], folder(broken))).toEqual([]);
    expect(await detectGames([pack], folder({}))).toEqual([]);
  });

  it("checks the build against the pack's builds range", () => {
    expect(buildSupported(pack, null)).toBe(true);
    expect(buildSupported(pack, 99)).toBe(false);
    expect(buildSupported(pack, 100)).toBe(true);
    const closed = { ...pack, builds: { from: 100, to: 200 } };
    expect(buildSupported(closed, 200)).toBe(true);
    expect(buildSupported(closed, 201)).toBe(false);
  });

  it("needs every marker of one operating system", async () => {
    const noMarkers = { ...pack, detection: { markers: [] } };
    const files = { "TestServer.sh": "" };
    expect(await detectGames([noMarkers], folder(files))).toEqual([]);
    const [linux] = await detectGames([pack], folder(files));
    expect(linux?.os).toBe("linux");
  });
});
