// The hook service (contract C7, dev-work-plan P6-B): wires the control
// clients to the servers API. It owns the per-server hook configuration
// (an SSH command string or a docker-socket-proxy, set only by the owner or
// an admin) and the per-kind probe overrides (host, port and an encrypted
// password), resolves the status probes and the hook clients of a server,
// runs single hook actions for the hook run API, and stops, waits and
// starts for the stopped-only policy of the apply step. Commands come only
// from the pack allow-list or the fixed per-server string; nothing from the
// UI is ever sent to a game or a shell.
//
// Every protocol client here runs against recorded byte fixtures or a local
// stub, never a live game (the Theriark Mock Server has no Palworld REST
// scenario; results are labelled simulated).
import { eq } from "drizzle-orm";
import type { Aead } from "../crypto/aead.js";
import { serverHooks } from "../db/schema.js";
import type { Store } from "../db/store.js";
import type { ActivityService } from "../activity/service.js";
import type { ChangeSetService } from "../changes/service.js";
import type {
  ConnectorService,
  ConnectionSpec,
} from "../connectors/service.js";
import type { SftpAuth } from "../connectors/sftp.js";
import { ApiError } from "../http/errors.js";
import type { ServerRecord, ServerService } from "../servers/service.js";
import {
  decryptControlPassword,
  encryptControlPassword,
  hookClient,
  probeClient,
} from "./control.js";
import { DockerProxy } from "./docker-proxy.js";
import type { SshCommandOptions } from "./ssh-command.js";
import {
  ControlError,
  LIMITS,
  checkLineSafePassword,
  lineSafe,
  usableHost,
  usablePort,
  type ControlAction,
  type ControlConfig,
  type ControlContext,
  type ControlState,
  type GameControl,
  type ProbeOverride,
  type SettingValue,
  type StatusProbe,
} from "./types.js";

/** How long a stop or start waits for the probe to see the new state. */
export const HOOK_WAIT_MS = 10_000;

/** How often the probe is asked while a stop takes effect. */
const HOOK_POLL_MS = 500;

/** The hook configuration as the API stores and shows it. */
export type HookConfig = ControlConfig;

/** A probe override as the set route takes it: the password is plain here. */
export interface ProbeInput {
  readonly host?: string;
  readonly port?: number;
  readonly password?: string;
}

/** What the set route may change: the hook and any probe overrides. */
export interface HookSetInput {
  readonly hook?: HookConfig | null;
  readonly probes?: { readonly [kind: string]: ProbeInput | null };
}

/** The probe overrides of a server, by probe kind. */
export type ProbeOverrides = ReadonlyMap<string, ProbeOverride>;

/** What the status probe reports about a server. */
export interface StatusAnswer {
  readonly state: ControlState;
  /** Connected players, when the probe reports the count. */
  readonly players: number | null;
  /** The probe kind that answered, or null when nothing resolves. */
  readonly source: string | null;
}

/** The control clients of a server, resolved once for one request. */
export interface HookSources {
  /** Every pack probe that resolves, in pack order (the first is the chip). */
  readonly probes: readonly StatusProbe[];
  /** The pack's protocol client: the first probe with hook actions. */
  readonly packHook: GameControl | null;
  /** The configured hook client: the SSH command or the docker proxy. */
  readonly configured: GameControl | null;
}

/** One hook action that ran, and where it ran. */
export interface RunAnswer {
  readonly action: ControlAction;
  /** The client kind that ran it. */
  readonly source: string;
  readonly at: string;
  /** How many pending change sets the stop wrote (action stop only). */
  readonly flushed: number | null;
  /** Whether the probe saw the server stopped after a stop action. */
  readonly stopped: boolean | null;
}

/** Where an action comes from: the client and its method. */
interface Where {
  readonly client: GameControl;
  readonly method: () => Promise<void>;
  readonly source: string;
}

type HookRow = typeof serverHooks.$inferSelect;

/** A control error as an API error, with its code for the UI. */
export function controlFailure(error: unknown): ApiError {
  if (!(error instanceof ControlError)) throw error;
  const status: Record<string, number> = {
    Connection: 502,
    Timeout: 502,
    Auth: 502,
    Protocol: 502,
    HostKey: 502,
    Refused: 422,
    Failed: 500,
    Unsupported: 501,
  };
  // The key is a ControlErrorCode of this module's own union.
  // eslint-disable-next-line security/detect-object-injection
  return new ApiError(status[error.code], "control_error", {
    code: error.code,
    message: error.message,
  });
}

/** True when a probe client also carries hook actions. */
function isHook(client: StatusProbe): client is GameControl {
  const control = client as GameControl;
  return (
    typeof control.save === "function" ||
    typeof control.stop === "function" ||
    typeof control.start === "function" ||
    typeof control.restart === "function"
  );
}

export interface HookServiceOptions {
  readonly store: Store;
  readonly aead: Aead;
  readonly activity: ActivityService;
  readonly servers: ServerService;
  readonly connectors: ConnectorService;
  /** How long a stop or start waits for the probe (default HOOK_WAIT_MS). */
  readonly waitMs?: number;
  readonly now?: () => Date;
}

/**
 * The hooks of every server (contract C7). The change set service calls
 * probe, sources and runFrom while it holds a server's lock; the routes call
 * context, status and run outside it. setChanges wires the two together in
 * app.ts, after both services exist.
 */
export class HookService {
  readonly #store: Store;
  readonly #aead: Aead;
  readonly #activity: ActivityService;
  readonly #servers: ServerService;
  readonly #connectors: ConnectorService;
  readonly #waitMs: number;
  readonly #now: () => Date;
  #changes: ChangeSetService | null = null;

  constructor(options: HookServiceOptions) {
    this.#store = options.store;
    this.#aead = options.aead;
    this.#activity = options.activity;
    this.#servers = options.servers;
    this.#connectors = options.connectors;
    this.#waitMs = options.waitMs ?? HOOK_WAIT_MS;
    this.#now = options.now ?? (() => new Date());
  }

  /** app.ts wires the change set service in after both are constructed. */
  setChanges(changes: ChangeSetService): void {
    this.#changes = changes;
  }

  #changesOf(): ChangeSetService {
    if (this.#changes === null) {
      throw new Error("the hook service has no change set service");
    }
    return this.#changes;
  }

  /** The stored row of a server, or null when no configuration exists. */
  #row(serverId: string): HookRow | null {
    const row = this.#store.db
      .select()
      .from(serverHooks)
      .where(eq(serverHooks.serverId, serverId))
      .get();
    return row === undefined ? null : row;
  }

  /** The stored hook configuration of a server (contract C7). */
  hookConfig(serverId: string): HookConfig | null {
    const row = this.#row(serverId);
    if (row === null || row.hook === null) return null;
    return JSON.parse(row.hook) as HookConfig;
  }

  /** The probe overrides of a server, by probe kind. */
  overrides(serverId: string): ProbeOverrides {
    const row = this.#row(serverId);
    if (row === null) return new Map();
    const parsed = JSON.parse(row.overrides) as Record<string, ProbeOverride>;
    return new Map(Object.entries(parsed));
  }

  /** Who set the configuration and when, for the settings page. */
  updated(serverId: string): {
    readonly updatedAt: string;
    readonly updatedBy: string | null;
  } | null {
    const row = this.#row(serverId);
    if (row === null) return null;
    return { updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  }

  /**
   * Sets the hook configuration and the probe overrides of a server. Only
   * the owner or an admin reaches this (the route checks the role); an SSH
   * command hook needs the server's own SSH access, so a local server cannot
   * have one.
   */
  setConfig(
    server: ServerRecord,
    input: HookSetInput,
    actor: string,
  ): void {
    const pack = this.#servers.pack(server);
    const row = this.#row(server.id);
    let hook: string | null;
    if (input.hook === undefined) {
      hook = row?.hook ?? null;
    } else if (input.hook === null) {
      hook = null;
    } else {
      hook = JSON.stringify(this.#checkedHook(server, input.hook));
    }
    let overrideText = row?.overrides ?? "{}";
    if (input.probes !== undefined) {
      const current = new Map(this.overrides(server.id));
      for (const [kind, value] of Object.entries(input.probes)) {
        if (!pack.probes.some((probe) => probe.kind === kind)) {
          throw new ApiError(422, "unknown_probe", { kind });
        }
        if (value === null) current.delete(kind);
        else current.set(kind, this.#checkedOverride(kind, value));
      }
      overrideText = JSON.stringify(Object.fromEntries(current));
    }
    const values = {
      hook,
      overrides: overrideText,
      updatedAt: this.#now().toISOString(),
      updatedBy: actor,
    };
    this.#store.db
      .insert(serverHooks)
      .values({ serverId: server.id, ...values })
      .onConflictDoUpdate({ target: serverHooks.serverId, set: values })
      .run();
  }

  /** A hook configuration as far as it can be checked at set time. */
  #checkedHook(server: ServerRecord, hook: HookConfig): HookConfig {
    if (hook.kind === "sshCommand") {
      if (server.connector.kind !== "sftp") {
        throw new ApiError(422, "hook_needs_sftp", { kind: hook.kind });
      }
      const command = hook.command;
      if (
        command.trim() === "" ||
        command.length > LIMITS.maxSshCommandLength ||
        !lineSafe(command)
      ) {
        throw new ApiError(422, "hook_command_not_usable");
      }
      return { kind: "sshCommand", command };
    }
    // The docker proxy client refuses a URL or a label it cannot use, and
    // does so without touching the network.
    try {
      new DockerProxy({ url: hook.url, containerLabel: hook.containerLabel });
    } catch (error) {
      if (error instanceof ControlError) {
        throw new ApiError(422, "hook_command_not_usable", {
          message: error.message,
        });
      }
      throw error;
    }
    return {
      kind: "dockerProxy",
      url: hook.url,
      containerLabel: hook.containerLabel,
    };
  }

  /** A probe override as far as it can be checked at set time. */
  #checkedOverride(kind: string, input: ProbeInput): ProbeOverride {
    const override: { host?: string; port?: number; passwordEnc?: string } =
      {};
    if (input.host !== undefined) {
      if (!usableHost(input.host)) {
        throw new ApiError(422, "probe_host_not_usable", { kind });
      }
      override.host = input.host;
    }
    if (input.port !== undefined) {
      if (!usablePort(input.port)) {
        throw new ApiError(422, "probe_port_not_usable", { kind });
      }
      override.port = input.port;
    }
    if (input.password !== undefined) {
      checkLineSafePassword(input.password);
      override.passwordEnc = encryptControlPassword(
        this.#aead,
        input.password,
      );
    }
    return override;
  }

  /**
   * The control context of a server: the live setting values its caller read
   * (the change set service holds the server lock while it applies), the
   * decrypter of per-server passwords, and the host of its own connection as
   * the probe fallback (a local server has none).
   */
  contextFor(server: ServerRecord, values: SettingValue): ControlContext {
    const host =
      server.connector.kind === "sftp" ? server.connector.host : undefined;
    return {
      values,
      secret: (encrypted) => decryptControlPassword(this.#aead, encrypted),
      ...(host === undefined ? {} : { host }),
    };
  }

  /**
   * The context of a server for a route: the change set service reads the
   * values from the files. Never call this while a change set holds the
   * server's lock.
   */
  async context(server: ServerRecord): Promise<ControlContext> {
    const values = await this.#changesOf().controlValues(server);
    return this.contextFor(server, values);
  }

  /**
   * Every control client of a server: the pack probes with their per-kind
   * overrides, the pack hook (the first probe with hook actions) and the
   * configured hook. A probe that names no endpoint stays silent.
   */
  async sources(
    server: ServerRecord,
    context: ControlContext,
  ): Promise<HookSources> {
    const pack = this.#servers.pack(server);
    const overrides = this.overrides(server.id);
    const probes: StatusProbe[] = [];
    for (const probe of pack.probes) {
      const override = overrides.get(probe.kind);
      const input = { probe, context, ...(override ? { override } : {}) };
      const client = await probeClient(input);
      if (client !== null) probes.push(client);
    }
    const configured = await this.#configuredClient(server);
    return { probes, packHook: probes.find(isHook) ?? null, configured };
  }

  /**
   * The configured hook client of a server: the SSH command reuses the
   * server's own SSH access (its host, its user, its authentication and the
   * host key the owner confirmed), so a local server has none; the docker
   * proxy needs only its base URL and label.
   */
  async #configuredClient(server: ServerRecord): Promise<GameControl | null> {
    const config = this.hookConfig(server.id);
    if (config === null) return null;
    if (config.kind === "dockerProxy") {
      return hookClient({
        kind: "dockerProxy",
        options: { url: config.url, containerLabel: config.containerLabel },
      });
    }
    const stored = server.connector;
    if (stored.kind !== "sftp") return null;
    const spec: ConnectionSpec = this.#servers.specOf(server);
    if (spec.kind !== "sftp") return null;
    let auth: SftpAuth;
    if (spec.panel) {
      // A panel server without its password can never authenticate; the
      // connector refuses the same spec, so the hook stays unavailable.
      if (spec.password === undefined) return null;
      auth = { method: "password", password: spec.password };
    } else {
      auth = { method: "key", privateKey: this.#connectors.key.privateKey() };
    }
    const options: SshCommandOptions = {
      host: stored.host,
      port: stored.port,
      username: stored.username,
      auth,
      pinnedFingerprint:
        this.#connectors.knownHosts.get(stored.host, stored.port)
          ?.fingerprint ?? null,
      command: config.command,
    };
    return hookClient({ kind: "sshCommand", options });
  }

  /**
   * Asks the probes in turn: the first answer that says running or stopped
   * is the status (the pack probes first, the configured hook last), so a
   * docker proxy can answer for a game whose own protocol stays silent.
   */
  async probe(
    server: ServerRecord,
    context: ControlContext,
    sources?: HookSources,
  ): Promise<StatusAnswer> {
    const resolved = sources ?? (await this.sources(server, context));
    const clients = [...resolved.probes];
    if (resolved.configured !== null) clients.push(resolved.configured);
    let first: string | null = null;
    for (const client of clients) {
      const answer = await client.probe();
      const kind = client.kind;
      if (first === null) first = kind;
      if (answer.state !== "unknown") {
        return {
          state: answer.state,
          players: answer.players ?? null,
          source: kind,
        };
      }
    }
    return { state: "unknown", players: null, source: first };
  }

  /**
   * Waits until the probe sees the server stopped, or the bound passes. The
   * values the context holds stay the ones read before the stop: the files
   * do not change while the server shuts down.
   */
  async awaitStopped(
    server: ServerRecord,
    context: ControlContext,
    sources: HookSources,
  ): Promise<boolean> {
    const bound = this.#now().getTime() + this.#waitMs;
    for (;;) {
      const answer = await this.probe(server, context, sources);
      if (answer.state === "stopped") return true;
      if (this.#now().getTime() >= bound) return false;
      await new Promise((sleep) => setTimeout(sleep, HOOK_POLL_MS));
    }
  }

  /** The pack's own client for an action, when the pack supports it. */
  #packWhere(
    server: ServerRecord,
    sources: HookSources,
    action: ControlAction,
  ): Where | null {
    const pack = this.#servers.pack(server);
    const hook = sources.packHook;
    if (hook === null || !pack.hooksSupported.includes(action)) return null;
    if (action === "save" && typeof hook.save === "function") {
      return { client: hook, method: hook.save, source: hook.kind };
    }
    if (action === "stop" && typeof hook.stop === "function") {
      return { client: hook, method: hook.stop, source: hook.kind };
    }
    return null;
  }

  /**
   * Where one action comes from. The pack's own protocol stops the game
   * gently when it can; the start of an SSH command hook is its fixed
   * restart string, the only thing that can bring a service back up.
   */
  #where(
    server: ServerRecord,
    sources: HookSources,
    action: ControlAction,
  ): Where | null {
    if (action === "save" || action === "stop") {
      const pack = this.#packWhere(server, sources, action);
      if (pack !== null) return pack;
    }
    const configured = sources.configured;
    if (configured === null || action === "save") return null;
    if (action === "stop" && typeof configured.stop === "function") {
      return {
        client: configured,
        method: configured.stop,
        source: configured.kind,
      };
    }
    if (action === "start" && typeof configured.start === "function") {
      return {
        client: configured,
        method: configured.start,
        source: configured.kind,
      };
    }
    if (action === "restart" && typeof configured.restart === "function") {
      return {
        client: configured,
        method: configured.restart,
        source: configured.kind,
      };
    }
    if (action === "start" && typeof configured.restart === "function") {
      // The fixed command restarts the service, so it also starts it: the
      // start of a stopped service is its restart string.
      return {
        client: configured,
        method: configured.restart,
        source: configured.kind,
      };
    }
    return null;
  }

  /** The actions a server can run today, with the client kind that runs it. */
  async actions(
    server: ServerRecord,
    sources: HookSources,
  ): Promise<Record<ControlAction, string | null>> {
    const entries = (["save", "stop", "start", "restart"] as const).map(
      (action): [ControlAction, string | null] => {
        const where = this.#where(server, sources, action);
        return [action, where === null ? null : where.source];
      },
    );
    return Object.fromEntries(entries) as Record<ControlAction, string | null>;
  }

  /**
   * Runs one hook action and records hook.run (contract C6), whether it
   * worked or not. The fixed strings and allow-listed commands are the only
   * thing that ever goes out; the caller's words never do.
   */
  async runFrom(
    server: ServerRecord,
    sources: HookSources,
    action: ControlAction,
    actor: string,
    extra: Record<string, unknown> = {},
  ): Promise<RunAnswer> {
    const where = this.#where(server, sources, action);
    if (where === null) {
      throw new ApiError(409, "hook_not_configured", { action });
    }
    try {
      await where.method();
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      this.#activity.record("hook.run", {
        serverId: server.id,
        actor,
        data: { action, source: where.source, ok: false, error: error.code },
      });
      throw controlFailure(error);
    }
    this.#activity.record("hook.run", {
      serverId: server.id,
      actor,
      data: { action, source: where.source, ok: true, ...extra },
    });
    return {
      action,
      source: where.source,
      at: this.#now().toISOString(),
      flushed: null,
      stopped: null,
    };
  }

  /** The client kind that would run an action, or null when none can. */
  canRun(
    server: ServerRecord,
    sources: HookSources,
    action: ControlAction,
  ): string | null {
    const where = this.#where(server, sources, action);
    return where === null ? null : where.source;
  }

  /**
   * The status route answer: reads the live values and asks the probes. The
   * route writes the pending change sets after it, when the answer says
   * stopped (the server was seen stopped).
   */
  async status(server: ServerRecord): Promise<StatusAnswer> {
    const context = await this.context(server);
    return this.probe(server, context);
  }

  /**
   * The hook run API: reads the live values, resolves the clients and runs
   * one action. A stop also waits for the probe to see the server down and
   * then writes the pending change sets and runs their start hooks, which is
   * the stopped-only policy of contract C5: a pending change is written
   * after the stop hook.
   */
  async run(
    server: ServerRecord,
    action: ControlAction,
    actor: string,
  ): Promise<RunAnswer> {
    const context = await this.context(server);
    const sources = await this.sources(server, context);
    if (action !== "stop") {
      return this.runFrom(server, sources, action, actor);
    }
    const answer = await this.runFrom(server, sources, "stop", actor);
    const stopped = await this.awaitStopped(server, context, sources);
    const flushed = stopped
      ? await this.#changesOf().flushPending(server, actor)
      : [];
    return { ...answer, stopped, flushed: flushed.length };
  }
}
