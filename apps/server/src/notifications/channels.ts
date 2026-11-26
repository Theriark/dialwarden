// Notification channels (dev-work-plan P9-B, Paid feature notifications):
// in-app, generic webhook (JSON, optional HMAC signature), Discord webhook
// (the chips as text, at Discord's pace) and SMTP e-mail (nodemailer,
// STARTTLS or TLS). Each channel names the C6 activity types it receives and
// is registered on the P9-A dispatch seam (dispatch.ts), which hands it
// nothing on Free; the channels stay stored and start again when Paid
// returns. No channel exists by default, so the image still makes no
// outbound call with its default settings.
//
// Secrets (the webhook URL, which carries the Discord token, the signing
// secret and the SMTP password) are one JSON value encrypted with
// APP_SECRET_KEY (ENCRYPTED_COLUMNS). No answer ever carries them: a URL is
// shown as its scheme and host with the path masked, the others as has...
// flags. Logs and the stored last result name a code only.
//
// Deliveries of one channel run one after another (in event order), at most
// MAX_QUEUE waiting; a full queue drops the new event with a log line. Each
// delivery reads the channel again, so an edit, a disable or a delete applies
// to what is still waiting. The send test runs beside the queue.
import { randomUUID } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import type { Pack } from "@dialwarden/packs-schema";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  ACTIVITY_TYPES,
  type ActivityEvent,
  type ActivityType,
} from "../activity/service.js";
import type { Aead } from "../crypto/aead.js";
import {
  notificationChannels,
  notificationInbox,
  notificationReads,
} from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError } from "../http/errors.js";
import {
  addressAllowed,
  policyOf,
  type NetworkPolicy,
  type OidcNetworkOptions,
} from "../oidc/network.js";
import type { ReportService } from "../reports/service.js";
import type { ServerService } from "../servers/service.js";
import { actorLabels } from "../team/labels.js";
import { atLeast, type Principal } from "../team/roles.js";
import type { NotificationDispatcher } from "./dispatch.js";
import {
  bylineOf,
  messageOf,
  testMessage,
  type NotificationMessage,
} from "./message.js";
import {
  assertMaySend,
  DeliveryError,
  DiscordPace,
  realSleep,
  sendDiscord,
  sendSmtp,
  sendWebhook,
  type SendContext,
  type Sleep,
  type SmtpSecurity,
  type SmtpTlsOptions,
  type WebhookBody,
} from "./transports.js";

/** The AEAD context of the secrets column (its ENCRYPTED_COLUMNS entry). */
export const SECRET_CONTEXT = "notification_channels.secret";
export const CHANNEL_KINDS = ["in_app", "webhook", "discord", "smtp"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
/** Events one channel may hold waiting. */
export const MAX_QUEUE = 100;
/** The in-app rows kept; older ones are removed. */
export const INBOX_KEEP = 1000;
export const MAX_CHANNELS = 50;
/** What a masked URL path reads as. */
export const MASK = "***";

// ---- Stored shapes ----

interface UrlConfig {
  host: string;
  allowPrivateHost: boolean;
}

interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  from: string;
  to: string[];
  allowPrivateHost: boolean;
}

interface Secrets {
  url?: string;
  signingSecret?: string | null;
  password?: string | null;
}

// ---- Input and view (the routes validate the input with zod) ----

export type ChannelSettingsInput =
  | { kind: "in_app" }
  | {
      kind: "webhook";
      /** Required on create; omitted or the masked value keeps the stored. */
      url?: string | undefined;
      /** Omitted keeps the stored; null removes it. */
      signingSecret?: string | null | undefined;
      allowPrivateHost: boolean;
    }
  | {
      kind: "discord";
      url?: string | undefined;
      allowPrivateHost: boolean;
    }
  | {
      kind: "smtp";
      host: string;
      port: number;
      security: SmtpSecurity;
      username: string | null;
      /** Omitted keeps the stored; null removes it. */
      password?: string | null | undefined;
      from: string;
      to: string[];
      allowPrivateHost: boolean;
    };

export interface ChannelInput {
  name: string;
  enabled: boolean;
  types: ActivityType[];
  settings: ChannelSettingsInput;
}

export type ChannelSettingsView =
  | { kind: "in_app" }
  | {
      kind: "webhook";
      url: string;
      host: string;
      hasSigningSecret: boolean;
      allowPrivateHost: boolean;
    }
  | { kind: "discord"; url: string; host: string; allowPrivateHost: boolean }
  | {
      kind: "smtp";
      host: string;
      port: number;
      security: SmtpSecurity;
      username: string | null;
      hasPassword: boolean;
      from: string;
      to: string[];
      allowPrivateHost: boolean;
    };

export interface ChannelView {
  id: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  types: ActivityType[];
  settings: ChannelSettingsView;
  lastDeliveryAt: string | null;
  lastResult: "ok" | "failed" | null;
  lastError: string | null;
  failures: number;
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  ok: boolean;
  error: string | null;
}

export interface InboxItem {
  id: number;
  /** A C6 type, or "test" for the send test. */
  type: ActivityType | "test";
  serverId: string | null;
  at: string;
  title: string;
  lines: string[];
}

export interface InboxPage {
  items: InboxItem[];
  unread: number;
  nextBefore: number | null;
}

type Row = typeof notificationChannels.$inferSelect;

/**
 * What a channel keeps between deliveries. It lives as long as the channel:
 * an edit only swaps the dispatcher subscription, so the queue (event
 * order) and the Discord pace carry over.
 */
interface Runtime {
  unregister: () => void;
  queue: Promise<void>;
  waiting: number;
  pace: DiscordPace;
  /** A send test is running (one at a time per channel). */
  testing: boolean;
}

/** The URL with its path, query and fragment masked. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/${MASK}`;
  } catch {
    return MASK;
  }
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function typesOf(text: string): ActivityType[] {
  const value = parseJson<unknown>(text, []);
  if (!Array.isArray(value)) return [];
  return ACTIVITY_TYPES.filter((type) => value.includes(type));
}

export interface ChannelServiceOptions {
  store: Store;
  aead: Aead;
  entitlement: EntitlementGate;
  dispatcher: NotificationDispatcher;
  servers: ServerService;
  packs: ReadonlyMap<string, Pack>;
  reports: ReportService;
  log: FastifyBaseLogger;
  /** Test seam (BuildOptions.notificationNetwork), never from the env. */
  network?: OidcNetworkOptions | undefined;
  /** Test seam (BuildOptions.notificationTls): CAs the SMTP check trusts. */
  tls?: SmtpTlsOptions | undefined;
  sleep?: Sleep;
  now?: () => Date;
}

export class ChannelService {
  readonly #store: Store;
  readonly #aead: Aead;
  readonly #entitlement: EntitlementGate;
  readonly #dispatcher: NotificationDispatcher;
  readonly #servers: ServerService;
  readonly #packs: ReadonlyMap<string, Pack>;
  readonly #reports: ReportService;
  readonly #log: FastifyBaseLogger;
  readonly #network: OidcNetworkOptions;
  readonly #tls: SmtpTlsOptions;
  readonly #sleep: Sleep;
  readonly #now: () => Date;
  readonly #runtime = new Map<string, Runtime>();
  readonly #abort = new AbortController();

  constructor(options: ChannelServiceOptions) {
    this.#store = options.store;
    this.#aead = options.aead;
    this.#entitlement = options.entitlement;
    this.#dispatcher = options.dispatcher;
    this.#servers = options.servers;
    this.#packs = options.packs;
    this.#reports = options.reports;
    this.#log = options.log;
    this.#network = options.network ?? {};
    this.#tls = options.tls ?? {};
    this.#sleep = options.sleep ?? realSleep;
    this.#now = options.now ?? (() => new Date());
  }

  /** Registers every stored enabled channel on the dispatcher (app start). */
  start(): void {
    for (const row of this.#rows()) this.#register(row);
  }

  /**
   * Registers the channels of the database as it is now (after a first-run
   * import swapped it): channels that are gone are dropped, the others
   * registered again. Unlike stop(), the service keeps running.
   */
  reload(): void {
    const rows = this.#rows();
    const ids = new Set(rows.map((row) => row.id));
    for (const id of [...this.#runtime.keys()]) {
      if (!ids.has(id)) this.#unregister(id);
    }
    for (const row of rows) this.#register(row);
  }

  /** Unregisters every channel and drops what is waiting (app close). */
  stop(): void {
    this.#abort.abort();
    for (const runtime of this.#runtime.values()) runtime.unregister();
  }

  // ---- Configuration ----

  list(): ChannelView[] {
    return this.#rows().map((row) => this.#view(row));
  }

  get(id: string): ChannelView {
    return this.#view(this.#require(id));
  }

  create(input: ChannelInput, actor: string): ChannelView {
    const all = this.#rows();
    if (all.length >= MAX_CHANNELS) {
      throw new ApiError(409, "channel_limit", { max: MAX_CHANNELS });
    }
    if (
      input.settings.kind === "in_app" &&
      all.some((row) => row.kind === "in_app")
    ) {
      throw new ApiError(409, "in_app_exists");
    }
    const { config, secrets } = this.#prepare(input.settings, null);
    const now = this.#now().toISOString();
    const row: Row = {
      id: randomUUID(),
      name: input.name,
      kind: input.settings.kind,
      enabled: input.enabled ? 1 : 0,
      types: JSON.stringify(this.#ordered(input.types)),
      config: JSON.stringify(config),
      secretEnc: this.#seal(secrets),
      lastDeliveryAt: null,
      lastResult: null,
      lastError: null,
      failures: 0,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };
    this.#store.db.insert(notificationChannels).values(row).run();
    this.#register(row);
    return this.#view(row);
  }

  update(id: string, input: ChannelInput): ChannelView {
    const row = this.#require(id);
    if (input.settings.kind !== row.kind) {
      throw new ApiError(422, "kind_immutable");
    }
    const { config, secrets } = this.#prepare(input.settings, row);
    const changes = {
      name: input.name,
      enabled: input.enabled ? 1 : 0,
      types: JSON.stringify(this.#ordered(input.types)),
      config: JSON.stringify(config),
      secretEnc: this.#seal(secrets),
      updatedAt: this.#now().toISOString(),
    };
    this.#store.db
      .update(notificationChannels)
      .set(changes)
      .where(eq(notificationChannels.id, id))
      .run();
    const updated = { ...row, ...changes };
    this.#register(updated);
    return this.#view(updated);
  }

  remove(id: string): void {
    this.#require(id);
    this.#unregister(id);
    this.#store.db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .run();
  }

  /**
   * The send test: one test message now, whatever the channel's types. It
   * does not wait behind the queued deliveries, so a busy or failing channel
   * answers within the bound of one send; one test runs at a time.
   */
  async test(id: string): Promise<TestResult> {
    const row = this.#require(id);
    const runtime = this.#runtimeOf(row.id);
    if (runtime.testing) return { ok: false, error: "test_running" };
    runtime.testing = true;
    try {
      return await this.#send(row.id, testMessage(row.name, this.#now()), null);
    } finally {
      runtime.testing = false;
    }
  }

  // ---- The in-app channel ----

  inbox(
    principal: Principal,
    visible: (serverId: string) => boolean,
    query: { before?: number | undefined; limit: number },
  ): InboxPage {
    const scope = this.#inboxScope(principal, visible);
    if (scope === null) return { items: [], unread: 0, nextBefore: null };
    const conditions = [...scope];
    if (query.before !== undefined) {
      conditions.push(lt(notificationInbox.id, query.before));
    }
    const rows = this.#store.db
      .select()
      .from(notificationInbox)
      .where(and(...conditions))
      .orderBy(desc(notificationInbox.id))
      .limit(query.limit + 1)
      .all();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    // The byline is built here from the actor id, as the activity feed does,
    // so an erased user shows with the erased label (D7).
    const labels = actorLabels(
      this.#store,
      page.flatMap((row) => (row.actor === null ? [] : [row.actor])),
    );
    return {
      items: page.map((row) => {
        const lines = parseJson<string[]>(row.lines, []);
        return {
          id: row.id,
          type: row.type as ActivityType | "test",
          serverId: row.serverId,
          at: row.at,
          title: row.title,
          lines:
            row.actor === null
              ? lines
              : [
                  bylineOf(labels.get(row.actor) ?? row.actor, row.at),
                  ...lines,
                ],
        };
      }),
      unread: this.#unread(principal.userId, scope),
      nextBefore:
        rows.length > query.limit && last !== undefined ? last.id : null,
    };
  }

  /** Marks the in-app rows up to upTo as read for this user. */
  markRead(
    principal: Principal,
    visible: (serverId: string) => boolean,
    upTo: number,
  ): { unread: number } {
    const newest =
      this.#store.db
        .select({ id: sql<number>`max(${notificationInbox.id})` })
        .from(notificationInbox)
        .get()?.id ?? 0;
    const value = Math.min(upTo, newest);
    const current = this.#lastRead(principal.userId);
    if (value > current) {
      this.#store.db
        .insert(notificationReads)
        .values({ userId: principal.userId, lastReadId: value })
        .onConflictDoUpdate({
          target: notificationReads.userId,
          set: { lastReadId: value },
        })
        .run();
    }
    const scope = this.#inboxScope(principal, visible);
    return {
      unread: scope === null ? 0 : this.#unread(principal.userId, scope),
    };
  }

  /**
   * The conditions of the rows a user sees: owner and admin every row;
   * editors and viewers only the rows of the servers they see (rows without
   * a server, such as backups or the licence, are for owner and admin). An
   * admin's viewer-scoped API token is a viewer of every server (P10-A
   * G7.5). Null: nothing at all.
   */
  #inboxScope(
    principal: Principal,
    visible: (serverId: string) => boolean,
  ): SQL[] | null {
    if (atLeast(principal.role, "admin")) return [];
    const ids = this.#servers
      .list()
      .map((server) => server.id)
      .filter(visible);
    if (ids.length === 0) return null;
    return [inArray(notificationInbox.serverId, ids)];
  }

  #lastRead(userId: string): number {
    return (
      this.#store.db
        .select()
        .from(notificationReads)
        .where(eq(notificationReads.userId, userId))
        .get()?.lastReadId ?? 0
    );
  }

  #unread(userId: string, scope: SQL[]): number {
    const after = gt(notificationInbox.id, this.#lastRead(userId));
    return (
      this.#store.db
        .select({ n: count() })
        .from(notificationInbox)
        .where(and(after, ...scope))
        .get()?.n ?? 0
    );
  }

  // ---- Delivery ----

  /** Subscribes the channel as stored now, keeping its runtime (queue, pace). */
  #register(row: Row): void {
    const existing = this.#runtime.get(row.id);
    if (existing !== undefined) {
      existing.unregister();
      existing.unregister = () => undefined;
    }
    const types = typesOf(row.types);
    if (row.enabled !== 1 || types.length === 0) return;
    const runtime = this.#runtimeOf(row.id);
    runtime.unregister = this.#dispatcher.register({
      name: `${row.kind}:${row.id}`,
      types,
      deliver: async (event) => {
        await this.#enqueue(row, () => this.#deliverEvent(row.id, event));
      },
    });
  }

  #unregister(id: string): void {
    const runtime = this.#runtime.get(id);
    if (runtime === undefined) return;
    runtime.unregister();
    this.#runtime.delete(id);
  }

  /** The runtime of a channel, made on first use (not yet subscribed). */
  #runtimeOf(id: string): Runtime {
    let runtime = this.#runtime.get(id);
    if (runtime === undefined) {
      runtime = {
        unregister: () => undefined,
        queue: Promise.resolve(),
        waiting: 0,
        pace: new DiscordPace(),
        testing: false,
      };
      this.#runtime.set(id, runtime);
    }
    return runtime;
  }

  /**
   * Runs a job after the channel's earlier ones; undefined when the queue
   * is full (the job is dropped and logged).
   */
  async #enqueue<T>(row: Row, job: () => Promise<T>): Promise<T | undefined> {
    const runtime = this.#runtimeOf(row.id);
    if (runtime.waiting >= MAX_QUEUE) {
      this.#log.warn(
        { channel: row.id, kind: row.kind },
        "notification queue full, event dropped",
      );
      return undefined;
    }
    runtime.waiting += 1;
    const current = runtime;
    const run = current.queue.then(job);
    current.queue = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      current.waiting -= 1;
    }
  }

  async #deliverEvent(id: string, event: ActivityEvent): Promise<void> {
    const row = this.#find(id);
    // Edited, disabled or removed while the event waited.
    if (row === null || row.enabled !== 1) return;
    if (!typesOf(row.types).includes(event.type)) return;
    let message: NotificationMessage;
    try {
      message = messageOf(event, {
        store: this.#store,
        servers: this.#servers,
        packs: this.#packs,
        reports: this.#reports,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown";
      this.#log.warn(
        { channel: id, eventId: event.id, type: event.type, reason },
        "notification message failed",
      );
      return;
    }
    await this.#send(id, message, event);
  }

  /** Sends one message on a channel and stores the result. */
  async #send(
    id: string,
    message: NotificationMessage,
    event: ActivityEvent | null,
  ): Promise<TestResult> {
    const row = this.#find(id);
    if (row === null) return { ok: false, error: "channel_not_found" };
    try {
      await this.#transport(row, message, event);
      this.#result(row.id, null);
      return { ok: true, error: null };
    } catch (error) {
      const failure =
        error instanceof DeliveryError
          ? error
          : new DeliveryError("failed", false);
      if (failure.code !== "stopped" && failure.code !== "plan_free") {
        this.#result(row.id, failure.code);
      }
      this.#log.warn(
        {
          channel: row.id,
          kind: row.kind,
          eventId: event?.id ?? null,
          type: event?.type ?? "test",
          code: failure.code,
        },
        "notification delivery failed",
      );
      return { ok: false, error: failure.code };
    }
  }

  async #transport(
    row: Row,
    message: NotificationMessage,
    event: ActivityEvent | null,
  ): Promise<void> {
    const kind = row.kind as ChannelKind;
    const context = this.#context(this.#policyOf(row));
    if (kind === "in_app") {
      // Nothing leaves the host, but an event still queued when the plan
      // dropped to Free is not stored either (the test route answers 402).
      if (event !== null) assertMaySend(context);
      this.#toInbox(row.id, message, event);
      return;
    }
    const secrets = this.#open(row);
    const runtime = this.#runtime.get(row.id);
    if (kind === "webhook") {
      if (secrets.url === undefined) throw new DeliveryError("no_url", false);
      const body: WebhookBody = {
        version: 1,
        kind: event === null ? "test" : "event",
        channel: { id: row.id, name: row.name },
        event: event === null ? null : { ...event },
        title: message.title,
        text: [message.title, message.byline, ...message.lines].join("\n"),
        lines: message.lines,
        server: message.server,
        actor: message.actor,
      };
      await sendWebhook(
        { url: secrets.url, signingSecret: secrets.signingSecret ?? null },
        body,
        event?.type ?? "test",
        context,
      );
      return;
    }
    if (kind === "discord") {
      if (secrets.url === undefined) throw new DeliveryError("no_url", false);
      await sendDiscord(
        secrets.url,
        message,
        runtime?.pace ?? new DiscordPace(),
        context,
      );
      return;
    }
    const config = parseJson<SmtpConfig | null>(row.config, null);
    if (config === null) throw new DeliveryError("bad_config", false);
    await sendSmtp(
      {
        host: config.host,
        port: config.port,
        security: config.security,
        username: config.username,
        password: secrets.password ?? null,
        from: config.from,
        to: config.to,
      },
      message,
      context,
      this.#tls,
    );
  }

  #toInbox(
    channelId: string,
    message: NotificationMessage,
    event: ActivityEvent | null,
  ): void {
    const db = this.#store.db;
    db.insert(notificationInbox)
      .values({
        channelId,
        eventId: event?.id ?? 0,
        type: event?.type ?? "test",
        serverId: event?.serverId ?? message.server?.id ?? null,
        at: event?.at ?? this.#now().toISOString(),
        // An event names its actor by id; inbox() adds the byline. A test
        // byline names the channel only, so it is stored as it is.
        actor: event?.actor ?? null,
        title: message.title,
        lines: JSON.stringify(
          event === null ? [message.byline, ...message.lines] : message.lines,
        ),
      })
      .run();
    const cutoff = db
      .select({ id: notificationInbox.id })
      .from(notificationInbox)
      .orderBy(desc(notificationInbox.id))
      .limit(1)
      .offset(INBOX_KEEP)
      .get();
    if (cutoff !== undefined) {
      db.delete(notificationInbox)
        .where(sql`${notificationInbox.id} <= ${cutoff.id}`)
        .run();
    }
  }

  #context(policy: NetworkPolicy): SendContext {
    return {
      policy,
      now: this.#now,
      sleep: this.#sleep,
      signal: this.#abort.signal,
      maySend: () => this.#entitlement.can("notifications"),
    };
  }

  #policyOf(row: Row): NetworkPolicy {
    const config = parseJson<{ allowPrivateHost?: unknown }>(row.config, {});
    return policyOf(config.allowPrivateHost === true, this.#network);
  }

  #result(id: string, code: string | null): void {
    const now = this.#now().toISOString();
    this.#store.db
      .update(notificationChannels)
      .set(
        code === null
          ? {
              lastDeliveryAt: now,
              lastResult: "ok",
              lastError: null,
              failures: 0,
            }
          : {
              lastDeliveryAt: now,
              lastResult: "failed",
              lastError: code,
              failures: sql`${notificationChannels.failures} + 1`,
            },
      )
      .where(eq(notificationChannels.id, id))
      .run();
  }

  // ---- Storage helpers ----

  #rows(): Row[] {
    return this.#store.db
      .select()
      .from(notificationChannels)
      .orderBy(notificationChannels.createdAt, notificationChannels.id)
      .all();
  }

  #find(id: string): Row | null {
    return (
      this.#store.db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, id))
        .get() ?? null
    );
  }

  #require(id: string): Row {
    const row = this.#find(id);
    if (row === null) throw new ApiError(404, "channel_not_found");
    return row;
  }

  #ordered(types: readonly ActivityType[]): ActivityType[] {
    return ACTIVITY_TYPES.filter((type) => types.includes(type));
  }

  #seal(secrets: Secrets): string | null {
    const kept = Object.entries(secrets).filter(
      ([, value]) => value !== undefined && value !== null,
    );
    if (kept.length === 0) return null;
    return this.#aead.encrypt(
      JSON.stringify(Object.fromEntries(kept)),
      SECRET_CONTEXT,
    );
  }

  #open(row: Row): Secrets {
    if (row.secretEnc === null) return {};
    return parseJson<Secrets>(
      this.#aead.decryptText(row.secretEnc, SECRET_CONTEXT),
      {},
    );
  }

  /**
   * Checks a URL the admin typed: https (http only through the test seam),
   * no user name or password in it, and an IP literal host must be allowed
   * under the channel's policy (a name is resolved and checked at each send).
   */
  #checkUrl(url: string, allowPrivateHost: boolean): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(422, "url_refused", { reason: "not a URL" });
    }
    const policy = policyOf(allowPrivateHost, this.#network);
    const httpOk = policy.allowHttp && parsed.protocol === "http:";
    if (parsed.protocol !== "https:" && !httpOk) {
      throw new ApiError(422, "url_refused", { reason: "https only" });
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new ApiError(422, "url_refused", {
        reason: "credentials in the URL",
      });
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (/^[0-9.]+$|:/.test(host) && !addressAllowed(host, policy)) {
      throw new ApiError(422, "url_refused", { reason: "address not allowed" });
    }
    return parsed;
  }

  #prepare(
    settings: ChannelSettingsInput,
    row: Row | null,
  ): { config: object; secrets: Secrets } {
    const stored = row === null ? {} : this.#open(row);
    switch (settings.kind) {
      case "in_app":
        return { config: {}, secrets: {} };
      case "webhook":
      case "discord": {
        const keep =
          settings.url === undefined ||
          (stored.url !== undefined && settings.url === maskUrl(stored.url));
        const url = keep ? stored.url : settings.url;
        if (url === undefined) {
          throw new ApiError(422, "url_required");
        }
        const parsed = this.#checkUrl(url, settings.allowPrivateHost);
        const config: UrlConfig = {
          host: parsed.host,
          allowPrivateHost: settings.allowPrivateHost,
        };
        const secrets: Secrets = { url: parsed.href };
        if (settings.kind === "webhook") {
          secrets.signingSecret =
            settings.signingSecret === undefined
              ? (stored.signingSecret ?? null)
              : settings.signingSecret;
        }
        return { config, secrets };
      }
      case "smtp": {
        const config: SmtpConfig = {
          host: settings.host.toLowerCase(),
          port: settings.port,
          security: settings.security,
          username: settings.username,
          from: settings.from,
          to: settings.to,
          allowPrivateHost: settings.allowPrivateHost,
        };
        const policy = policyOf(settings.allowPrivateHost, this.#network);
        const literal = /^[0-9.]+$|:/.test(config.host);
        if (literal && !addressAllowed(config.host, policy)) {
          throw new ApiError(422, "host_refused", {
            reason: "address not allowed",
          });
        }
        // The stored password goes only to the server it was given for
        // (P10-A L10): a new host, port or user name needs it sent again,
        // so an admin cannot point the channel elsewhere and capture it.
        const before = parseJson<Partial<SmtpConfig>>(row?.config ?? "{}", {});
        const sameTarget =
          before.host === config.host &&
          before.port === config.port &&
          before.username === config.username;
        const kept = stored.password ?? null;
        if (settings.password === undefined && kept !== null && !sameTarget) {
          throw new ApiError(422, "password_required");
        }
        const password =
          settings.password === undefined ? kept : settings.password;
        return { config, secrets: { password } };
      }
    }
  }

  #view(row: Row): ChannelView {
    const kind = row.kind as ChannelKind;
    const secrets = this.#open(row);
    let settings: ChannelSettingsView;
    if (kind === "webhook" || kind === "discord") {
      const config = parseJson<UrlConfig>(row.config, {
        host: "",
        allowPrivateHost: false,
      });
      const url = secrets.url === undefined ? MASK : maskUrl(secrets.url);
      settings =
        kind === "webhook"
          ? {
              kind,
              url,
              host: config.host,
              hasSigningSecret:
                typeof secrets.signingSecret === "string" &&
                secrets.signingSecret !== "",
              allowPrivateHost: config.allowPrivateHost,
            }
          : {
              kind,
              url,
              host: config.host,
              allowPrivateHost: config.allowPrivateHost,
            };
    } else if (kind === "smtp") {
      const config = parseJson<SmtpConfig>(row.config, {
        host: "",
        port: 587,
        security: "starttls",
        username: null,
        from: "",
        to: [],
        allowPrivateHost: false,
      });
      settings = {
        kind,
        host: config.host,
        port: config.port,
        security: config.security,
        username: config.username,
        hasPassword:
          typeof secrets.password === "string" && secrets.password !== "",
        from: config.from,
        to: config.to,
        allowPrivateHost: config.allowPrivateHost,
      };
    } else {
      settings = { kind: "in_app" };
    }
    return {
      id: row.id,
      name: row.name,
      kind,
      enabled: row.enabled === 1,
      types: typesOf(row.types),
      settings,
      lastDeliveryAt: row.lastDeliveryAt,
      lastResult:
        row.lastResult === "ok" || row.lastResult === "failed"
          ? row.lastResult
          : null,
      lastError: row.lastError,
      failures: row.failures,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
