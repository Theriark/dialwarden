// Launch sources (dev-work-plan P6-A step 5): where the argument line of a
// game lives. The app-managed dialwarden-args.txt is read and written by the
// launch adapter itself; a LinuxGSM instance cfg and a container env file
// hold the line inside shell variables, so the values are composed through
// the shellvar adapter: a flag mapped to its own variable is read and
// written there (LinuxGSM interpolates it into startparameters at launch),
// and every other flag is edited inside the variable that holds the rest of
// the line. A panel-managed source is read-only: the app renders the line
// to copy into the panel and warns about the keys panels often rewrite.
//
// The server (P6-B) picks the source per server and calls these functions
// with the bytes of the source file; the browser (P6-C) shows the snippets
// and the copy-to-panel text of the same shapes.
import {
  FormatError,
  getAdapter,
  type FormatAdapter,
  type LaunchLocator,
} from "@dialwarden/formats";
import { fromFileValue } from "./coerce.js";
import {
  packFileOf,
  readFileValues,
  settingsOfFile,
  writeFileValues,
} from "./files.js";
import type { JsonValue, LaunchSource, Os, Pack, Setting } from "./types.js";

/** The launch sources of a launch file, always starting with args. */
export interface LaunchSourceView {
  readonly kind: LaunchSource["kind"];
  readonly paths: {
    readonly linux?: readonly string[];
    readonly windows?: readonly string[];
  };
  /** False for the panel source: the app never writes it. */
  readonly writable: boolean;
}

/** The sources a pack declares for a launch file, in pack order. */
export function launchSourceViews(
  pack: Pack,
  fileId: string,
): readonly LaunchSourceView[] {
  const file = packFileOf(pack, fileId);
  const declared = file.launchSources ?? [{ kind: "args" }];
  const views: LaunchSourceView[] = [];
  for (const source of declared) {
    if (source.kind === "args") {
      views.push({ kind: "args", paths: file.paths, writable: true });
      continue;
    }
    views.push({
      kind: source.kind,
      paths: source.paths,
      writable: source.kind !== "panel",
    });
  }
  return views;
}

/** Every path of a source for one operating system. */
export function launchSourcePaths(
  pack: Pack,
  fileId: string,
  source: LaunchSource,
  os: Os,
): readonly string[] {
  const paths =
    source.kind === "args" ? packFileOf(pack, fileId).paths : source.paths;
  return (os === "linux" ? paths.linux : paths.windows) ?? [];
}

/**
 * The one-line snippets that wire dialwarden-args.txt into a start command.
 * The shell forms hand the line to eval, so the quoting the launch adapter
 * writes ("Quarry Lane") reaches the game as one argument; plain word
 * splitting of the file would break it apart. eval is safe here because the
 * validator refuses every shell character in a launch value (validate.ts)
 * and the pack lint of the args file refuses one anywhere in it, which also
 * blocks the write of a raw patch (files.ts lintFile with formats
 * launchShellIssues), so the file holds only words and quotes. set -f keeps an unquoted ? * or [ (ARK
 * question-mark chains) from being read as a file pattern. Docker Compose
 * and systemd read $ themselves, so their forms write it as $$. PowerShell
 * passes the line to the game as its raw Windows command line, which keeps
 * double quotes.
 */
export function launchSnippets(
  fileName: string,
  executable: string,
): {
  readonly bash: string;
  readonly powershell: string;
  readonly compose: string;
  readonly systemd: string;
} {
  const line = (dollar: string) =>
    `set -f; eval "exec ${executable} ${dollar}(cat ${fileName})"`;
  return {
    bash: line("$"),
    powershell: `Start-Process -FilePath ${executable} -ArgumentList (Get-Content ${fileName} -Raw) -NoNewWindow -Wait`,
    compose: `command: sh -c '${line("$$")}'`,
    systemd: `ExecStart=/bin/sh -c '${line("$$")}'`,
  };
}

/** The settings of a launch file, with their flag and key word. */
function launchSettings(pack: Pack, fileId: string): Setting[] {
  return settingsOfFile(pack, fileId).filter(
    (setting) => setting.locator.kind === "launch",
  );
}

function locatorOf(setting: Setting): LaunchLocator {
  const locator = setting.locator;
  if (locator.kind !== "launch") {
    throw new FormatError("invalid-locator", "not a launch setting");
  }
  return locator;
}

/**
 * The variable reader of a source. A LinuxGSM cfg is sourced by bash, so it
 * follows the shell; a container env file is read line by line (Docker's
 * env_file), where an unquoted value runs to the end of the line, which is
 * the systemd EnvironmentFile reading of the shellvar-systemd adapter.
 */
function shellAdapter(source: LaunchSource): FormatAdapter {
  const id = source.kind === "env" ? "shellvar-systemd" : "shellvar";
  const adapter = getAdapter(id);
  if (adapter === undefined) {
    throw new FormatError("wrong-document", "no shell variable adapter");
  }
  return adapter;
}

/** True when the env source spells a 1 or 0 as true or false. */
function boolWord(text: string): boolean | undefined {
  const word = text.trim().toLowerCase();
  if (word === "true" || word === "yes" || word === "on") return true;
  if (word === "false" || word === "no" || word === "off") return false;
  return undefined;
}

/** The value of a variable as a file value, with the env true/false words. */
function varValue(setting: Setting, text: string): JsonValue | undefined {
  const typed = fromFileValue(setting, text);
  if (typed !== undefined) return typed;
  const word = boolWord(text);
  if (word === undefined) return undefined;
  return fromFileValue(setting, word ? 1 : 0);
}

/** The text to write into a variable, keeping the style it holds today. */
function varText(setting: Setting, value: JsonValue, current: string): string {
  if (typeof value === "number" && boolWord(current) !== undefined) {
    return value === 1 ? "true" : "false";
  }
  if (typeof value === "boolean" && boolWord(current) !== undefined) {
    return value ? "true" : "false";
  }
  return String(value);
}

/** Where one flag of a source lives. */
type Target =
  | { readonly target: "var"; readonly name: string }
  | { readonly target: "line"; readonly name: string | undefined };

/** The variable a flag is routed to for one source. */
function targetVar(source: LaunchSource, setting: Setting): Target {
  if (source.kind === "args" || source.kind === "panel") {
    return { target: "line", name: undefined };
  }
  const locator = locatorOf(setting);
  const mapped =
    source.flagVars !== undefined ? source.flagVars[locator.flag] : undefined;
  if (mapped !== undefined) return { target: "var", name: mapped };
  if (source.kind === "linuxgsm" && source.modifiersVar !== undefined) {
    // The modifiers variable holds a launch line of its own
    // (-preset casual -modifier combat easy), edited flag by flag.
    const family = locator.flag === "-preset" || locator.key !== undefined;
    if (family) return { target: "line", name: source.modifiersVar };
  }
  return { target: "line", name: source.argsVar };
}

/**
 * The typed values of every launch setting of the file through one source.
 * sourceBytes are the bytes of the physical file the source names (the args
 * file itself for the args source); they may be empty when nothing exists
 * yet, in which case only the defaults are read.
 */
export function readLaunchSourceValues(
  pack: Pack,
  fileId: string,
  source: LaunchSource,
  sourceBytes: Uint8Array,
): Map<string, JsonValue> {
  const settings = launchSettings(pack, fileId);
  if (source.kind === "args") {
    const read = readFileValues(pack, fileId, sourceBytes);
    return read.values;
  }
  const shell = shellAdapter(source);
  const doc = shell.parse(sourceBytes);
  const values = new Map<string, JsonValue>();
  for (const setting of settings) {
    const locator = locatorOf(setting);
    const target = targetVar(source, setting);
    let value: JsonValue | undefined;
    if (target.target === "var") {
      const text = shell.get(doc, { kind: "shellvar", name: target.name });
      if (typeof text === "string") value = varValue(setting, text);
    } else if (target.name !== undefined) {
      // The rest of the line lives inside the variable: read the flag out
      // of the launch line the variable holds.
      const rest = shell.get(doc, { kind: "shellvar", name: target.name });
      if (typeof rest === "string") {
        value = valueOfLine(setting, locator, rest);
      }
    }
    const keyedSwitch = setting.type === "bool" && locator.key !== undefined;
    if (value === undefined && keyedSwitch) {
      // A keyed boolean (-setkey) the line does not name is off.
      value = false;
    }
    if (value !== undefined) values.set(setting.key, value);
  }
  return values;
}

/** The value of one flag, read from the text of a launch line. */
function valueOfLine(
  setting: Setting,
  locator: LaunchLocator,
  line: string,
): JsonValue | undefined {
  const launch = getAdapter("launch");
  if (launch === undefined) return undefined;
  const doc = launch.parse(new TextEncoder().encode(line));
  const raw = launch.get(doc, locator);
  if (raw === undefined) return undefined;
  if (raw === true) return true;
  return fromFileValue(setting, raw);
}

/**
 * The new bytes of the source file after the edits, or a FormatError when
 * the edit cannot be made. The panel source is never written: its answer is
 * the refusal that tells the caller to hand out the copy-to-panel text.
 */
export function writeLaunchSourceValues(
  pack: Pack,
  fileId: string,
  source: LaunchSource,
  sourceBytes: Uint8Array,
  edits: readonly { readonly key: string; readonly value: JsonValue }[],
): Uint8Array {
  if (source.kind === "panel") {
    throw new FormatError(
      "invalid-value",
      "the panel manages this launch line; copy the text into it instead",
    );
  }
  if (source.kind === "args") {
    return writeFileValues(pack, fileId, sourceBytes, edits);
  }
  const shell = shellAdapter(source);
  const own = new Map(launchSettings(pack, fileId).map((s) => [s.key, s]));
  let bytes = sourceBytes;
  for (const edit of edits) {
    const setting = own.get(edit.key);
    if (setting === undefined) {
      throw new FormatError(
        "invalid-locator",
        `${edit.key} is not a launch setting`,
      );
    }
    const target = targetVar(source, setting);
    // Each edit works on the bytes the one before it wrote.
    const doc = shell.parse(bytes);
    if (target.target === "var") {
      const locator = { kind: "shellvar" as const, name: target.name };
      const current = shell.get(doc, locator);
      const text =
        edit.value === null
          ? undefined
          : varText(
              setting,
              edit.value,
              typeof current === "string" ? current : "",
            );
      // A variable the file does not hold yet is added, not set.
      const splices =
        text === undefined
          ? shell.remove(doc, locator)
          : current === undefined
            ? shell.insert(doc, locator, text)
            : shell.set(doc, locator, text);
      bytes = shell.apply(bytes, splices);
      continue;
    }
    // Edit the flag inside the launch line the variable holds.
    if (target.name === undefined) {
      throw new FormatError(
        "invalid-value",
        "the source names no line variable",
      );
    }
    const lineVar = { kind: "shellvar" as const, name: target.name };
    const line = shell.get(doc, lineVar);
    if (line === undefined && source.kind === "linuxgsm") {
      // A LinuxGSM instance cfg starts empty and the whole line lives in
      // _default.cfg; the instance value wins over the default one, so adding
      // the variable here would drop every other flag of the default line
      // (name, password, world, save folder).
      throw new FormatError(
        "invalid-value",
        `the LinuxGSM instance config holds no ${target.name} line; copy the ${target.name} line from _default.cfg into it first`,
      );
    }
    const current = typeof line === "string" ? line : "";
    const next = editLaunch(setting, current, edit.value);
    const splices =
      line === undefined
        ? shell.insert(doc, lineVar, next)
        : shell.set(doc, lineVar, next);
    bytes = shell.apply(bytes, splices);
  }
  return bytes;
}

/** The launch line after one flag of it is edited. */
function editLaunch(
  setting: Setting,
  line: string,
  value: JsonValue | null,
): string {
  const launch = getAdapter("launch");
  if (launch === undefined) {
    throw new FormatError("wrong-document", "no launch adapter");
  }
  const locator = locatorOf(setting);
  const doc = launch.parse(new TextEncoder().encode(line));
  const splices =
    value === null
      ? launch.remove(doc, locator)
      : launch.get(doc, locator) === undefined
        ? launch.insert(doc, locator, value)
        : launch.set(doc, locator, value);
  const bytes = launch.apply(new TextEncoder().encode(line), splices);
  return new TextDecoder().decode(bytes).trim();
}

/**
 * The copy-to-panel text: the launch line as it would be written for these
 * edits, rendered from the current bytes of the app-managed args file (which
 * may be empty), for the user to paste into the panel.
 */
export function renderLaunchLine(
  pack: Pack,
  fileId: string,
  bytes: Uint8Array,
  edits: readonly { readonly key: string; readonly value: JsonValue }[],
): string {
  const written = writeFileValues(pack, fileId, bytes, edits);
  return new TextDecoder().decode(written).trim();
}

/**
 * The warnings of the panel source: the launch settings this pack flags as
 * panel-managed, the keys panels tend to rewrite (dev-work-plan P6-A).
 */
export function launchPanelWarnings(
  pack: Pack,
  fileId: string,
): { readonly key: string; readonly message: string }[] {
  const out: { key: string; message: string }[] = [];
  for (const setting of settingsOfFile(pack, fileId)) {
    if (setting.panelManaged !== true) continue;
    out.push({
      key: setting.key,
      message: `${setting.key} is often set by the panel, so the panel may overwrite a change made here.`,
    });
  }
  return out;
}
