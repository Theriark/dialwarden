// Pack drift report (dev-work-plan P7 step 5, Risk 14): compares the
// default config files an engineer provides against a pack and writes a
// Markdown report of new keys, removed keys and changed defaults. The
// nightly SteamCMD job that would feed it waits for Legal, so an engineer
// runs this by hand:
//
//   node tools/pack-drift/src/pack-drift.mjs --pack packs/rust \
//       --defaults /tmp/rust-defaults --out drift.md
//
// The tool reads the pack folder and the defaults folder from disk and
// writes one file; it downloads nothing and opens nothing. Publisher
// default files are used only in the engineer's runtime (legal-input-1 2):
// they are never committed, and the engineer deletes them after the run.
//
// Under pnpm the tool imports the workspace sources through the source
// condition (vitest, pnpm run); a hand run outside the workspace needs the
// built packages (pnpm run build first).
import {
  cfgLocators,
  getAdapter,
  iniLocators,
  jsonLocators,
  launchLocators,
  luaLocators,
  shellVarLocators,
  xmlLocators,
} from "@dialwarden/formats";
import { sameAsDefault } from "@dialwarden/packs-schema";
import { fixtureName, readPack } from "@dialwarden/packs-schema/node";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * A canonical string for one locator, whatever its adapter; undefined for
 * the adapters whose values have no key of their own (textlist, codec).
 */
function keyOf(locator) {
  switch (locator.kind) {
    case "ini":
      return `ini:${locator.section ?? ""}:${locator.key}`;
    case "struct":
      return `struct:${locator.key}:${locator.field}`;
    case "cfg":
      return `cfg:${locator.command.toLowerCase()}`;
    case "launch":
      return `launch:${locator.flag.toLowerCase()}${
        locator.key ? ` ${locator.key.toLowerCase()}` : ""
      }`;
    case "xml":
      return `xml:${locator.property}`;
    case "lua":
      return `lua:${locator.path.map(String).join(".")}`;
    case "shellvar":
      return `shellvar:${locator.name}`;
    case "json":
      return `json:${locator.pointer}`;
    default:
      return undefined;
  }
}

/** Every key of a parsed document, by adapter family. */
function keysOf(adapter, doc) {
  const all = [];
  switch (adapter.id) {
    case "ini":
    case "ueini":
      all.push(...iniLocators(doc));
      break;
    case "cfg":
      all.push(...cfgLocators(doc));
      break;
    case "launch":
      all.push(...launchLocators(doc));
      break;
    case "xml":
      all.push(...xmlLocators(doc));
      break;
    case "lua":
      all.push(...luaLocators(doc));
      break;
    case "shellvar":
    case "shellvar-systemd":
      all.push(...shellVarLocators(doc));
      break;
    case "json":
    case "jsonc":
      all.push(...jsonLocators(doc));
      break;
    default:
      break;
  }
  const seen = new Set();
  for (const locator of all) {
    const key = keyOf(locator);
    if (key !== undefined) seen.add(key);
  }
  return [...seen];
}

/** A value as the report shows it: exact text, in backticks. */
function show(value) {
  return `\`${JSON.stringify(value) ?? "null"}\``;
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The drift of one pack against one folder of default files. Every file of
 * the pack is compared with the defaults file of the same name (the last
 * part of the file's first path, the fixture-name convention); a defaults
 * file with no pack file is reported, so nothing is compared silently.
 * Returns the Markdown report and how many files were compared.
 */
export function packDrift(packDir, defaultsDir) {
  const packId = packDir.split("/").at(-1) ?? packDir;
  const check = readPack(packDir, packId);
  if (check.pack === null) {
    throw new Error(`the pack does not load: ${check.problems.join("; ")}`);
  }
  const pack = check.pack;
  const files = [];
  let compared = 0;
  for (const file of pack.files) {
    const name = fixtureName(file);
    const defaultsPath = join(defaultsDir, name);
    const settings = pack.settings.filter((setting) => setting.file === file.id);
    const adapter = getAdapter(file.adapter);
    if (adapter === undefined) {
      throw new Error(`no adapter ${file.adapter}`);
    }
    if (!existsSync(defaultsPath)) {
      files.push({ fileId: file.id, name, added: [], removed: [], changed: [], missing: true });
      continue;
    }
    compared += 1;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the defaults folder given on the command line
    const doc = adapter.parse(new Uint8Array(readFileSync(defaultsPath)));
    const own = new Map();
    for (const setting of settings) {
      const key = keyOf(setting.locator);
      if (key !== undefined) own.set(key, setting);
    }
    const added = keysOf(adapter, doc)
      .filter((key) => !own.has(key))
      .sort();
    const removed = [];
    const changed = [];
    for (const setting of own.values()) {
      // A key the pack itself says this game version ignores never counts
      // as drift.
      if (setting.removedIn !== undefined) continue;
      let raw;
      try {
        raw = adapter.get(doc, setting.locator);
      } catch {
        raw = undefined;
      }
      if (raw === undefined) {
        removed.push({
          key: setting.key,
          packDefault:
            setting.default === undefined ? "not declared" : show(setting.default),
        });
        continue;
      }
      if (
        setting.default !== undefined
        && !sameAsDefault(setting, raw, setting.default)
      ) {
        changed.push({
          key: setting.key,
          packDefault: show(setting.default),
          now: show(raw),
        });
      }
    }
    removed.sort(byKey);
    changed.sort(byKey);
    files.push({ fileId: file.id, name, added, removed, changed, missing: false });
  }

  // A defaults file nothing compares against is named, so an engineer
  // cannot mistake a naming miss for an empty report.
  const known = new Set(pack.files.map((file) => fixtureName(file)));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the defaults folder given on the command line
  const extra = readdirSync(defaultsDir)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- entries of the same folder
    .filter((name) => statSync(join(defaultsDir, name)).isFile())
    .filter((name) => !known.has(name))
    .sort();

  const lines = [];
  lines.push(`# Pack drift: ${pack.displayName}`);
  lines.push("");
  lines.push(
    `Compared pack ${pack.id} (version ${pack.version}) against the default` +
      ` files of ${defaultsDir}. Generated by tools/pack-drift; nothing was` +
      " downloaded or opened.",
  );
  lines.push("");
  const addedCount = files.reduce((sum, file) => sum + file.added.length, 0);
  const removedCount = files.reduce((sum, file) => sum + file.removed.length, 0);
  const changedCount = files.reduce((sum, file) => sum + file.changed.length, 0);
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Files compared: ${compared}`);
  lines.push(`- New keys (in the default files, not in the pack): ${addedCount}`);
  lines.push(`- Removed keys (in the pack, not in the default files): ${removedCount}`);
  lines.push(`- Changed defaults: ${changedCount}`);
  for (const file of files.filter((file) => file.missing)) {
    lines.push(
      `- No ${file.name} in the defaults folder: ${file.fileId} was not compared`,
    );
  }
  for (const name of extra) {
    lines.push(`- ${name} in the defaults folder matches no file of the pack`);
  }
  for (const file of files) {
    if (
      file.missing
      || (file.added.length === 0 && file.removed.length === 0 && file.changed.length === 0)
    ) {
      continue;
    }
    lines.push("");
    lines.push(`## ${file.fileId} (${file.name})`);
    if (file.added.length > 0) {
      lines.push("");
      lines.push("### New keys");
      lines.push("");
      lines.push("| Key |");
      lines.push("| --- |");
      for (const key of file.added) {
        lines.push(`| ${key} |`);
      }
    }
    if (file.removed.length > 0) {
      lines.push("");
      lines.push("### Removed keys");
      lines.push("");
      lines.push("| Key | Pack default |");
      lines.push("| --- | --- |");
      for (const gone of file.removed) {
        lines.push(`| ${gone.key} | ${gone.packDefault} |`);
      }
    }
    if (file.changed.length > 0) {
      lines.push("");
      lines.push("### Changed defaults");
      lines.push("");
      lines.push("| Key | Pack default | Default file |");
      lines.push("| --- | --- | --- |");
      for (const change of file.changed) {
        lines.push(`| ${change.key} | ${change.packDefault} | ${change.now} |`);
      }
    }
  }
  return { report: `${lines.join("\n")}\n`, compared };
}

/** The command line entry: --pack, --defaults, --out (stdout default). */
function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const pack = option("pack");
  const defaults = option("defaults");
  if (pack === undefined || defaults === undefined) {
    process.stderr.write(
      "usage: pack-drift --pack packs/GAME --defaults DIR [--out FILE]\n",
    );
    return 2;
  }
  const { report } = packDrift(pack, defaults);
  const out = option("out");
  if (out === undefined) {
    process.stdout.write(report);
  } else {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the --out path given on the command line
    writeFileSync(out, report, "utf-8");
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
