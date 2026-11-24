// The control resolver (contract C7, dev-work-plan P6-A): turns the probe
// declarations of a pack plus the per-server overrides into control clients.
// The pack names the settings that hold the port and the password, so the
// values are read from the game's own files at run time and Dialwarden keeps
// no second copy; a per-server password, when one is configured, is stored
// encrypted (context control.password) and is decrypted only here, in memory,
// for the one operation. Commands come only from the pack's allow-list.
//
// P6-B wires this to the servers API: the stopped-only policy, the hook run
// API and the activity events (change.pending, change.applied, hook.run)
// call these clients and never the sockets directly.
import type { JsonValue, Pack, Probe } from "@dialwarden/packs-schema";
import type { Aead } from "../crypto/aead.js";
import { A2sProbe, type A2sOptions } from "./a2s.js";
import { DockerProxy, type DockerProxyOptions } from "./docker-proxy.js";
import { PalworldRest, type PalworldRestOptions } from "./palworld-rest.js";
import { RustWebRcon, type RustWebRconOptions } from "./rust-webrcon.js";
import { SshCommand, type SshCommandOptions } from "./ssh-command.js";
import { SourceRcon, type SourceRconOptions } from "./source-rcon.js";
import { Telnet7dtd, type Telnet7dtdOptions } from "./telnet-7dtd.js";
import {
  ControlError,
  type ControlTimeouts,
  type GameControl,
  type ProbeOverride,
  type ProbeResult,
  type SettingValue,
} from "./types.js";

/** Where an encrypted control password is associated (Aead context). */
export const CONTROL_PASSWORD_CONTEXT = "control.password";

export function encryptControlPassword(aead: Aead, password: string): string {
  return aead.encrypt(password, CONTROL_PASSWORD_CONTEXT);
}

export function decryptControlPassword(aead: Aead, value: string): string {
  return aead.decryptText(value, CONTROL_PASSWORD_CONTEXT);
}

/** A status probe, whatever its kind (a GameControl or the A2S query). */
export interface StatusProbe {
  readonly kind: string;
  probe(): Promise<ProbeResult>;
}

/** Everything the resolver needs from the caller (P6-B wires it). */
export interface ControlContext {
  /** The live setting values of the server, read from its files. */
  readonly values: SettingValue;
  /** Decrypts a per-server control password (context control.password). */
  readonly secret: (encrypted: string) => string;
  readonly timeouts?: ControlTimeouts;
}

/** One probe declaration with its per-server override and the context. */
export interface ProbeInput {
  readonly probe: Probe;
  readonly override?: ProbeOverride;
  readonly context: ControlContext;
}

/** A field of a probe declaration, read without a computed member access. */
function rawField(probe: Probe, field: string): JsonValue | undefined {
  return new Map<string, JsonValue>(Object.entries(probe)).get(field);
}

function probeField(probe: Probe, field: string): JsonValue | undefined {
  const found = rawField(probe, field);
  return Array.isArray(found) || typeof found === "object"
    ? undefined
    : (found as JsonValue | undefined);
}

function probeText(probe: Probe, field: string): string | undefined {
  const found = probeField(probe, field);
  return typeof found === "string" && found !== "" ? found : undefined;
}

function probeNumber(probe: Probe, field: string): number | undefined {
  const found = probeField(probe, field);
  return typeof found === "number" && Number.isInteger(found) && found > 0
    ? found
    : undefined;
}

function probeWords(
  probe: Probe,
  field: string,
): readonly string[] | undefined {
  const found = rawField(probe, field);
  if (!Array.isArray(found)) return undefined;
  const words = found.filter(
    (item): item is string =>
      typeof item === "string" && item !== "" && item.length < 128,
  );
  return words.length === found.length ? words : undefined;
}

async function valueOf(
  input: ProbeInput,
  key: string | undefined,
): Promise<JsonValue | undefined> {
  if (key === undefined) return undefined;
  return input.context.values(key);
}

/** The host to contact: the override, else what the pack names, else local. */
function hostOf(input: ProbeInput): string {
  return input.override?.host ?? probeText(input.probe, "host") ?? "127.0.0.1";
}

/** The port to contact: the override, else the pack's setting value. */
async function portOf(input: ProbeInput): Promise<number> {
  const override = input.override?.port;
  if (override !== undefined) return override;
  // Valheim answers A2S on the game port plus one (pack-draft-valheim).
  const offset = probeNumber(input.probe, "portOffset") ?? 0;
  const fromSetting = await valueOf(
    input,
    probeText(input.probe, "portSetting"),
  );
  if (typeof fromSetting === "number" && Number.isInteger(fromSetting)) {
    return fromSetting + offset;
  }
  const given = probeNumber(input.probe, "port");
  if (given !== undefined) return given + offset;
  throw new ControlError("Refused", "the probe has no port");
}

/**
 * The password of a control endpoint: the pack's setting value (the game's
 * own file), or the encrypted per-server override.
 */
async function passwordOf(input: ProbeInput): Promise<string | undefined> {
  const override = input.override?.passwordEnc;
  if (override !== undefined) return input.context.secret(override);
  const fromSetting = await valueOf(
    input,
    probeText(input.probe, "passwordSetting"),
  );
  return typeof fromSetting === "string" && fromSetting !== ""
    ? fromSetting
    : undefined;
}

/** The command allow-list of a protocol probe. */
function allowOf(input: ProbeInput): readonly string[] {
  const allow = probeWords(input.probe, "allow");
  if (allow === undefined) {
    throw new ControlError("Refused", "the probe has no command allow-list");
  }
  return allow;
}

/** An allow-listed command the probe maps to a hook action. */
function commandOf(input: ProbeInput, field: string): string | undefined {
  const command = probeText(input.probe, field);
  if (command === undefined) return undefined;
  if (!allowOf(input).includes(command)) {
    throw new ControlError("Refused", "the probe command is not allowed");
  }
  return command;
}

/** A hook command, spread into client options only when the pack has it. */
function commandOption(
  input: ProbeInput,
  field: "saveCommand" | "stopCommand",
): { saveCommand?: string } | { stopCommand?: string } {
  const command = commandOf(input, field);
  return command === undefined ? {} : { [field]: command };
}

/**
 * The resolved options of one probe declaration, or null when the
 * declaration does not name a configured endpoint (for example Palworld
 * REST switched off). Throws ControlError when the declaration is not usable
 * at all, so a broken pack is loud instead of silent. The secrets are
 * resolved here, in memory, for the one operation that follows.
 */
export type ProbeOptions =
  | { readonly kind: "palworldRest"; readonly options: PalworldRestOptions }
  | { readonly kind: "sourceRcon"; readonly options: SourceRconOptions }
  | { readonly kind: "rustWebRcon"; readonly options: RustWebRconOptions }
  | { readonly kind: "telnet7dtd"; readonly options: Telnet7dtdOptions }
  | { readonly kind: "a2s"; readonly options: A2sOptions };

export async function probeOptions(
  input: ProbeInput,
): Promise<ProbeOptions | null> {
  const kind = input.probe.kind;
  const timeouts = input.context.timeouts ?? {};
  switch (kind) {
    case "palworldRest": {
      const enabled = await valueOf(
        input,
        probeText(input.probe, "enabledSetting"),
      );
      if (enabled !== undefined && enabled !== true && enabled !== 1) {
        return null;
      }
      const credential = await passwordOf(input);
      if (credential === undefined) return null;
      return {
        kind: "palworldRest",
        options: {
          host: hostOf(input),
          port: await portOf(input),
          user: probeText(input.probe, "user") ?? "admin",
          password: credential,
          infoPath: probeText(input.probe, "infoPath") ?? "/v1/api/info",
          ...(probeText(input.probe, "scheme") === "https"
            ? { scheme: "https" as const }
            : {}),
          ...timeouts,
        },
      };
    }
    case "sourceRcon": {
      const credential = await passwordOf(input);
      if (credential === undefined) return null;
      return {
        kind: "sourceRcon",
        options: {
          host: hostOf(input),
          port: await portOf(input),
          password: credential,
          allow: allowOf(input),
          ...commandOption(input, "saveCommand"),
          ...commandOption(input, "stopCommand"),
          ...timeouts,
        },
      };
    }
    case "rustWebRcon": {
      const credential = await passwordOf(input);
      if (credential === undefined) return null;
      return {
        kind: "rustWebRcon",
        options: {
          host: hostOf(input),
          port: await portOf(input),
          password: credential,
          allow: allowOf(input),
          ...commandOption(input, "saveCommand"),
          ...commandOption(input, "stopCommand"),
          ...timeouts,
        },
      };
    }
    case "telnet7dtd": {
      const credential = await passwordOf(input);
      if (credential === undefined) return null;
      return {
        kind: "telnet7dtd",
        options: {
          host: hostOf(input),
          port: await portOf(input),
          password: credential,
          allow: allowOf(input),
          ...commandOption(input, "saveCommand"),
          ...commandOption(input, "stopCommand"),
          ...timeouts,
        },
      };
    }
    case "a2s": {
      return {
        kind: "a2s",
        options: {
          host: hostOf(input),
          port: await portOf(input),
          ...(probeField(input.probe, "players") === true
            ? { players: true }
            : {}),
          ...timeouts,
        },
      };
    }
    case "sshCommand":
    case "dockerProxy":
      // These are per-server hook configurations, not pack probes.
      return null;
  }
}

/**
 * The client of one probe declaration, or null when it names no configured
 * endpoint.
 */
export async function probeClient(
  input: ProbeInput,
): Promise<StatusProbe | null> {
  const resolved = await probeOptions(input);
  if (resolved === null) return null;
  switch (resolved.kind) {
    case "palworldRest":
      return new PalworldRest(resolved.options);
    case "sourceRcon":
      return new SourceRcon(resolved.options);
    case "rustWebRcon":
      return new RustWebRcon(resolved.options);
    case "telnet7dtd":
      return new Telnet7dtd(resolved.options);
    case "a2s":
      return new A2sProbe(resolved.options);
  }
}

/**
 * The status probes of a pack that resolve to a client, in pack order. The
 * first one is the status chip; a protocol probe with hook commands is also
 * the hook client of that pack (P6-B decides through hooksSupported).
 */
export async function probeClients(
  pack: Pack,
  override: ProbeOverride | undefined,
  context: ControlContext,
): Promise<readonly StatusProbe[]> {
  const clients: StatusProbe[] = [];
  for (const probe of pack.probes) {
    const client = await probeClient(
      override === undefined
        ? { probe, context }
        : { probe, override, context },
    );
    if (client !== null) clients.push(client);
  }
  return clients;
}

/**
 * The hook client of a per-server control configuration. The sshCommand hook
 * reuses the server's own SSH access, so its connection options come from
 * the caller (P6-B passes the connector spec and the confirmed host key).
 */
export function hookClient(
  config:
    | { readonly kind: "sshCommand"; readonly options: SshCommandOptions }
    | { readonly kind: "dockerProxy"; readonly options: DockerProxyOptions },
): GameControl {
  if (config.kind === "sshCommand") return new SshCommand(config.options);
  return new DockerProxy(config.options);
}
