// The pack-drift dry run of dev-work-plan P7 (Tests): a synthetic older
// fixture set with one key added and one key removed against a real pack
// gives the expected Markdown report. The defaults folder stands for the
// publisher default files an engineer provides; none of it is committed
// and the tool downloads nothing and opens nothing.
import { loadPack } from "../../../packs/kit.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packDrift } from "./pack-drift.mjs";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders */

const PACKS = fileURLToPath(new URL("../../../packs/", import.meta.url));

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "dialwarden-drift-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The value text the fixture style writes for one default. */
function valueOf(default: unknown): string {
  if (default === true) return "true";
  if (default === false) return "false";
  if (typeof default === "string" && (default === "" || default.includes(" "))) {
    return `"${default}"`;
  }
  return String(default);
}

describe("pack drift report", () => {
  it("reports the dry run: one added key, one removed, one changed", async () => {
    const defaults = join(base, "rust-defaults");
    await mkdir(defaults, { recursive: true });
    const pack = loadPack("rust");
    // A synthetic older default file: every pack convar at its default,
    // without server.idlekick (removed since), with
    // server.maxconnectionsperip at 9 (changed since) and the unknown
    // server.staydown key added since.
    const lines: string[] = [];
    for (const setting of pack.settings) {
      if (setting.file !== "servercfg" || setting.default === undefined) {
        continue;
      }
      if (setting.key === "server.idlekick") continue;
      const value = setting.key === "server.maxconnectionsperip"
        ? "9"
        : valueOf(setting.default);
      lines.push(`${setting.key} ${value}`);
    }
    lines.push("server.staydown true");
    await writeFile(join(defaults, "server.cfg"), `${lines.join("\n")}\n`);
    await writeFile(join(defaults, "users.cfg"), "");
    const args = readFileSync(
      join(PACKS, "rust/fixtures/dialwarden-args.txt"),
      "utf8",
    );
    await writeFile(
      join(defaults, "dialwarden-args.txt"),
      args.replace(" +server.identity rustserver", ""),
    );

    const { report, compared } = packDrift(join(PACKS, "rust"), defaults);
    expect(compared).toBe(3);
    // The report names the pack, the folder and the tool's promise.
    expect(report).toContain("# Pack drift: Rust");
    expect(report).toContain(
      `Compared pack rust (version ${pack.version}) against the default`,
    );
    expect(report).toContain("nothing was downloaded or opened");
    expect(report).toContain(`- Files compared: 3`);
    expect(report).toContain(
      "- New keys (in the default files, not in the pack): 1",
    );
    expect(report).toContain(
      "- Removed keys (in the pack, not in the default files): 1",
    );
    expect(report).toContain("- Changed defaults: 1");
    expect(report).toContain("## servercfg (server.cfg)");
    expect(report).toContain("| cfg:server.staydown |");
    expect(report).toContain("| server.idlekick | `30` |");
    expect(report).toContain(
      "| server.maxconnectionsperip | `5` | `\"9\"` |",
    );
  });

  it("names a defaults file no pack file matches, and one it lacks", async () => {
    const defaults = join(base, "palworld-defaults");
    await mkdir(defaults, { recursive: true });
    await writeFile(
      join(defaults, "unrelated.ini"),
      "Something=else\n",
      "utf8",
    );
    const { report, compared } = packDrift(join(PACKS, "palworld"), defaults);
    expect(compared).toBe(0);
    expect(report).toContain(
      "- unrelated.ini in the defaults folder matches no file of the pack",
    );
    expect(report).toContain(
      "- No PalWorldSettings.ini in the defaults folder: settings was not compared",
    );
    expect(report).toContain(
      "- No dialwarden-args.txt in the defaults folder: launch was not compared",
    );
  });
});
