// Game auto-detect and import over a real folder (dev-work-plan P4-A step
// 3): the P3 detection rules run through a connector, including the
// WorldOption.sav warning that needs list() (the P3 gap), and the import
// stores the first read of every pack file with cause import.
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacks } from "@dialwarden/packs-schema/node";
import type { Pack } from "@dialwarden/packs-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectorProbe,
  detectServer,
  importFiles,
  serverOs,
  type ImportedFile,
} from "./detect.js";
import { LocalConnector } from "./local.js";

/* eslint-disable security/detect-non-literal-fs-filename -- temporary test folders and the repository packs */

const PACKS = fileURLToPath(new URL("../../../../packs/", import.meta.url));
const packs = loadPacks(PACKS).packs;
const SETTINGS = "Pal/Saved/Config/LinuxServer/PalWorldSettings.ini";
const SAVES = "Pal/Saved/SaveGames/0";
const WORLD = "0A1B2C3D4E5F60718293A4B5C6D7E8F9";

function packOf(id: string): Pack {
  const pack = packs.get(id);
  if (pack === undefined) throw new Error(`no ${id} pack`);
  return pack;
}

let base: string;
let local: LocalConnector;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "dialwarden-detect-"));
  local = new LocalConnector({ root: base });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, content: string | null, from?: string) {
  const path = join(base, rel);
  await mkdir(join(path, ".."), { recursive: true });
  if (from !== undefined) await copyFile(from, path);
  else await writeFile(path, content ?? "");
}

/** A Linux Palworld server folder from the pack's synthetic fixture. */
async function palworldServer() {
  await put("PalServer.sh", "#!/bin/sh\n");
  await put(
    SETTINGS,
    null,
    join(PACKS, "palworld/fixtures/PalWorldSettings.ini"),
  );
  await mkdir(join(base, SAVES, WORLD), { recursive: true });
}

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("game detection through a connector", () => {
  it("finds Palworld by its marker, without a warning", async () => {
    await palworldServer();
    const found = await detectServer(packs.values(), local);
    expect(found).toEqual([
      {
        packId: "palworld",
        by: "markers",
        os: "linux",
        buildId: null,
        buildSupported: true,
        warnings: [],
      },
    ]);
  });

  it("warns about WorldOption.sav in a world folder it finds with list()", async () => {
    await palworldServer();
    await put(`${SAVES}/${WORLD}/WorldOption.sav`, "synthetic");
    const [found] = await detectServer(packs.values(), local);
    const message = packOf("palworld").detection.warnings?.at(0)?.message;
    expect(message).toContain("WorldOption.sav");
    expect(found?.warnings).toEqual([message]);
  });

  it("reads the build from the app manifest and finds the system from the files", async () => {
    await palworldServer();
    await put(
      "steamapps/appmanifest_2394010.acf",
      '"AppState"\n{\n\t"appid"\t\t"2394010"\n\t"buildid"\t\t"16521234"\n}\n',
    );
    const [found] = await detectServer(packs.values(), local);
    expect(found).toMatchObject({
      packId: "palworld",
      by: "appmanifest",
      os: null,
      buildId: 16521234,
    });
    if (found === undefined) throw new Error("not detected");
    expect(await serverOs(packOf("palworld"), found, local)).toBe("linux");
  });

  it("finds Enshrouded by its marker", async () => {
    await put("enshrouded_server.exe", "synthetic");
    await put(
      "enshrouded_server.json",
      null,
      join(PACKS, "enshrouded/fixtures/enshrouded_server.json"),
    );
    const found = await detectServer(packs.values(), local);
    expect(found.map((d) => d.packId)).toEqual(["enshrouded"]);
  });

  it("finds nothing in an empty folder", async () => {
    expect(await detectServer(packs.values(), local)).toEqual([]);
  });

  it("fails, rather than finding nothing, on a root the connector refuses", async () => {
    const refused = new LocalConnector({ root: base, deny: [base] });
    await expect(detectServer(packs.values(), refused)).rejects.toMatchObject({
      code: "PathEscape",
    });
    const missing = new LocalConnector({ root: join(base, "missing") });
    await expect(detectServer(packs.values(), missing)).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  it("answers absent, not an error, for a path that leaves the root", async () => {
    const probe = connectorProbe(local);
    expect(await probe.exists("../outside")).toBe(false);
    expect(await probe.read("../outside")).toBeNull();
    expect(await probe.list?.("../outside")).toBeNull();
  });
});

describe("import of existing files", () => {
  it("stores the first read of every file with cause import", async () => {
    await palworldServer();
    const stored: ImportedFile[] = [];
    const result = await importFiles(packOf("palworld"), "linux", local, {
      store: (file) => {
        stored.push(file);
      },
    });
    expect(stored).toHaveLength(1);
    const [settings] = stored;
    expect(settings).toMatchObject({
      fileId: "settings",
      path: SETTINGS,
      cause: "import",
    });
    expect(settings?.sha256).toBe(sha(settings?.bytes ?? new Uint8Array()));
    expect(result).toEqual({
      os: "linux",
      files: [
        {
          fileId: "settings",
          path: SETTINGS,
          sha256: settings?.sha256,
          size: settings?.bytes.length,
        },
      ],
      // The app-managed launch file is created on the first save.
      missing: [{ fileId: "launch", paths: ["dialwarden-args.txt"] }],
    });
  });

  it("fails the import when the sink fails, instead of skipping the file", async () => {
    await palworldServer();
    const sink = {
      store: () => {
        throw new Error("snapshot store full");
      },
    };
    await expect(
      importFiles(packOf("palworld"), "linux", local, sink),
    ).rejects.toThrow("snapshot store full");
  });
});
