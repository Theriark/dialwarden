// The outbound sides of the notification channels (P9-B): the generic
// webhook, the Discord webhook and SMTP e-mail. Every HTTP request goes
// through the network policy of oidc/network.ts: only the URL the admin
// configured, https only, every resolved address public unless the admin
// allowed a private host on that channel (loopback, link-local and metadata
// addresses never), a pinned connection, no redirect, 5 s to connect, 10 s
// in total. SMTP checks its host the same way, connects to the checked
// address and verifies the certificate against the configured host name.
//
// Failures become a DeliveryError with a short code (http_500, timeout,
// url_refused, auth_failed, ...), never the server's answer or the address,
// which can hold the webhook token. Only transient failures are retried:
// connection errors, timeouts, 408, 429 (after its Retry-After, at most 60 s)
// and 5xx; a refused URL, a 4xx or an SMTP authentication failure is a
// configuration problem and stops at once.
import { randomUUID } from "node:crypto";
import {
  checkHost,
  policyFetch,
  UrlRefusedError,
  type NetworkPolicy,
} from "../oidc/network.js";
import { DISCORD_LIMIT, discordText } from "../reports/service.js";
import { VERSION } from "../version.js";
import type { NotificationMessage } from "./message.js";
import { messageText } from "./message.js";
import { signatureHeader } from "./signature.js";

export const USER_AGENT = `Dialwarden/${VERSION}`;
/** Tries per delivery, the first included. */
export const MAX_ATTEMPTS = 3;
/** The pause before the second and the third try. */
export const RETRY_DELAYS_MS = [1_000, 5_000] as const;
/** The longest Retry-After or rate-limit reset Dialwarden waits for. */
export const MAX_WAIT_MS = 60_000;
const SMTP_CONNECT_TIMEOUT_MS = 5_000;
const SMTP_SOCKET_TIMEOUT_MS = 10_000;

export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    /** A wait the server asked for (429), in milliseconds. */
    readonly waitMs: number | null = null,
  ) {
    super(code);
    this.name = "DeliveryError";
  }
}

/** Waits, or rejects when the signal aborts (the app closes). */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DeliveryError("stopped", false));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DeliveryError("stopped", false));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export interface SendContext {
  readonly policy: NetworkPolicy;
  readonly now: () => Date;
  readonly sleep: Sleep;
  readonly signal: AbortSignal;
  /** False once the plan is Free: a queued or retried send stops. */
  readonly maySend: () => boolean;
}

/** A Retry-After value in milliseconds: seconds, or an HTTP date. */
function retryAfterMs(value: string | null, now: Date): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now.getTime());
}

/** The DeliveryError of a failed fetch. */
function fetchFailure(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  if (error instanceof UrlRefusedError) {
    // The policy refused the URL or an answer (a redirect, too large).
    return new DeliveryError("url_refused", false);
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new DeliveryError("timeout", true);
  }
  return new DeliveryError("connection", true);
}

/** The DeliveryError of an HTTP answer that is not 2xx. */
function statusFailure(answer: Response, now: Date): DeliveryError {
  const status = answer.status;
  const retryable = status === 408 || status === 429 || status >= 500;
  const wait =
    status === 429
      ? retryAfterMs(answer.headers.get("retry-after"), now)
      : null;
  return new DeliveryError(`http_${String(status)}`, retryable, wait);
}

/**
 * Runs one try, then retries transient failures with a pause, at most
 * MAX_ATTEMPTS tries in all. A 429 waits for its Retry-After (capped) when
 * that is longer than the pause.
 */
export async function withRetries<T>(
  context: SendContext,
  attempt: () => Promise<T>,
): Promise<T> {
  let last: DeliveryError = new DeliveryError("not_sent", false);
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    if (!context.maySend()) throw new DeliveryError("plan_free", false);
    try {
      return await attempt();
    } catch (error) {
      last = fetchFailure(error);
      const pause = RETRY_DELAYS_MS.at(index);
      if (!last.retryable || pause === undefined) throw last;
      const wanted = Math.min(last.waitMs ?? 0, MAX_WAIT_MS);
      await context.sleep(Math.max(pause, wanted), context.signal);
    }
  }
  throw last;
}

// ---- Generic webhook ----

export interface WebhookTarget {
  readonly url: string;
  /** The HMAC key; null sends no signature header. */
  readonly signingSecret: string | null;
}

/** The JSON body of a generic webhook delivery (documented in the PR). */
export interface WebhookBody {
  readonly version: 1;
  /** "event" for a C6 row, "test" for the send test. */
  readonly kind: "event" | "test";
  readonly channel: { readonly id: string; readonly name: string };
  /** The C6 row as it is ({ id, type, serverId, at, actor, data }). */
  readonly event: Record<string, unknown> | null;
  readonly title: string;
  readonly text: string;
  readonly lines: readonly string[];
  readonly server: NotificationMessage["server"];
  readonly actor: string;
}

/** Sends one webhook body; one delivery id for every try (idempotency). */
export async function sendWebhook(
  target: WebhookTarget,
  body: WebhookBody,
  eventType: string,
  context: SendContext,
): Promise<void> {
  const text = JSON.stringify(body);
  const delivery = randomUUID();
  await withRetries(context, async () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "x-dialwarden-event": eventType,
      "x-dialwarden-delivery": delivery,
    };
    if (target.signingSecret !== null) {
      const timestamp = Math.floor(context.now().getTime() / 1000);
      headers["x-dialwarden-signature"] = signatureHeader(
        target.signingSecret,
        text,
        timestamp,
      );
    }
    const answer = await policyFetch(
      target.url,
      { method: "POST", headers, body: text, signal: context.signal },
      context.policy,
    );
    if (answer.status < 200 || answer.status >= 300) {
      throw statusFailure(answer, context.now());
    }
  });
}

// ---- Discord webhook ----

/** Discord allows 5 requests per 2 seconds per webhook, 30 per minute. */
export const DISCORD_WINDOWS = [
  { limit: 5, ms: 2_000 },
  { limit: 30, ms: 60_000 },
] as const;

/**
 * The send pace of one Discord webhook: a sliding window per limit, plus a
 * pause the server asked for (a 429, or X-RateLimit-Remaining 0 with its
 * X-RateLimit-Reset-After).
 */
export class DiscordPace {
  readonly #sent: number[] = [];
  #blockedUntil = 0;

  /** Milliseconds to wait before the next request may go. */
  waitFor(now: number): number {
    let wait = Math.max(0, this.#blockedUntil - now);
    for (const window of DISCORD_WINDOWS) {
      const recent = this.#sent.filter((at) => at > now - window.ms);
      if (recent.length >= window.limit) {
        const oldest = recent[recent.length - window.limit] ?? now;
        wait = Math.max(wait, oldest + window.ms - now);
      }
    }
    return Math.min(wait, MAX_WAIT_MS);
  }

  sent(now: number): void {
    this.#sent.push(now);
    const longest = DISCORD_WINDOWS.at(-1)?.ms ?? 60_000;
    while ((this.#sent[0] ?? now) <= now - longest) this.#sent.shift();
  }

  blockFor(now: number, ms: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, now + ms);
  }
}

/**
 * The Discord message: the title in bold, the byline, then the lines as a
 * list, every user text escaped and every @ broken (reports/service.ts),
 * at most DISCORD_LIMIT characters. allowed_mentions with no parse types
 * keeps Discord from pinging anyone even if an @ came through.
 */
export function discordBody(message: NotificationMessage): {
  content: string;
  allowed_mentions: { parse: never[] };
} {
  const lines = [
    `**${discordText(message.title)}**`,
    discordText(message.byline),
  ];
  const room = DISCORD_LIMIT - 40;
  let used = lines.join("\n").length;
  let shown = 0;
  for (const line of message.lines) {
    const text = `- ${discordText(line)}`;
    const cut = text.length > 300 ? `${text.slice(0, 297)}...` : text;
    if (used + cut.length + 1 > room) break;
    lines.push(cut);
    used += cut.length + 1;
    shown += 1;
  }
  if (shown < message.lines.length) {
    lines.push(`... and ${String(message.lines.length - shown)} more lines`);
  }
  return { content: lines.join("\n"), allowed_mentions: { parse: [] } };
}

/** The seconds of Discord's retry_after (JSON body of a 429), or null. */
async function discordRetryAfter(answer: Response): Promise<number | null> {
  try {
    const body: unknown = await answer.clone().json();
    if (typeof body === "object" && body !== null) {
      const value = (body as Record<string, unknown>)["retry_after"];
      if (typeof value === "number" && value >= 0) return value * 1000;
    }
  } catch {
    // Not JSON: the Retry-After header decides.
  }
  return null;
}

/** Sends one Discord message at the webhook's pace. */
export async function sendDiscord(
  url: string,
  message: NotificationMessage,
  pace: DiscordPace,
  context: SendContext,
): Promise<void> {
  const text = JSON.stringify(discordBody(message));
  await withRetries(context, async () => {
    const wait = pace.waitFor(context.now().getTime());
    if (wait > 0) await context.sleep(wait, context.signal);
    if (!context.maySend()) throw new DeliveryError("plan_free", false);
    pace.sent(context.now().getTime());
    const answer = await policyFetch(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: text,
        signal: context.signal,
      },
      context.policy,
    );
    const now = context.now();
    const remaining = answer.headers.get("x-ratelimit-remaining");
    const resetAfter = retryAfterMs(
      answer.headers.get("x-ratelimit-reset-after"),
      now,
    );
    if (remaining === "0" && resetAfter !== null) {
      pace.blockFor(now.getTime(), Math.min(resetAfter, MAX_WAIT_MS));
    }
    if (answer.status >= 200 && answer.status < 300) return;
    const failure = statusFailure(answer, now);
    if (answer.status === 429) {
      const ms = (await discordRetryAfter(answer)) ?? failure.waitMs ?? 1_000;
      pace.blockFor(now.getTime(), Math.min(ms, MAX_WAIT_MS));
      throw new DeliveryError(failure.code, true, ms);
    }
    throw failure;
  });
}

// ---- SMTP e-mail ----

export type SmtpSecurity = "starttls" | "tls";

export interface SmtpTarget {
  readonly host: string;
  readonly port: number;
  /** starttls: plain connect, then STARTTLS is required. tls: TLS at once. */
  readonly security: SmtpSecurity;
  readonly username: string | null;
  readonly password: string | null;
  readonly from: string;
  readonly to: readonly string[];
}

/** Test seam only (BuildOptions.notificationTls): extra trusted CAs. */
export interface SmtpTlsOptions {
  readonly ca?: string | readonly string[];
}

/** Header text: no line breaks or other control characters. */
// eslint-disable-next-line no-control-regex -- control characters are what is replaced
const flat = (text: string): string => text.replace(/[\x00-\x1f\x7f]+/g, " ");

/** The DeliveryError of a nodemailer failure (its code, never its text). */
function smtpFailure(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  if (error instanceof UrlRefusedError) {
    return new DeliveryError("host_refused", false);
  }
  const code = (error as { code?: unknown }).code;
  const responseCode = (error as { responseCode?: unknown }).responseCode;
  if (code === "EAUTH") return new DeliveryError("auth_failed", false);
  if (code === "ETLS" || code === "ESOCKET") {
    const message = error instanceof Error ? error.message : "";
    // A certificate problem is configuration, not a passing failure.
    const tls = /certificate|self[- ]signed|altnames|STARTTLS/i.test(message);
    return new DeliveryError(tls ? "tls_failed" : "connection", !tls);
  }
  if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "EDNS") {
    return new DeliveryError(
      code === "ETIMEDOUT" ? "timeout" : "connection",
      true,
    );
  }
  if (typeof responseCode === "number") {
    // 4xx is a temporary refusal in SMTP (RFC 5321), 5xx a permanent one.
    return new DeliveryError(
      `smtp_${String(responseCode)}`,
      responseCode >= 400 && responseCode < 500,
    );
  }
  return new DeliveryError("smtp_failed", false);
}

/** Sends one plain-text e-mail through the configured SMTP server. */
export async function sendSmtp(
  target: SmtpTarget,
  message: NotificationMessage,
  context: SendContext,
  tls: SmtpTlsOptions = {},
): Promise<void> {
  // Loaded on first use, so an instance without an SMTP channel never loads
  // nodemailer (and the no-outbound test boots without it).
  const nodemailer = await import("nodemailer");
  await withRetries(context, async () => {
    let addresses: string[];
    try {
      addresses = await checkHost(target.host, context.policy);
    } catch (error) {
      throw smtpFailure(error);
    }
    const address = addresses[0] ?? "";
    const auth =
      target.username === null
        ? undefined
        : { user: target.username, pass: target.password ?? "" };
    const transport = nodemailer.createTransport({
      host: address,
      port: target.port,
      secure: target.security === "tls",
      requireTLS: target.security === "starttls",
      // The certificate is checked against the configured name, not the IP.
      servername: target.host,
      name: "dialwarden",
      auth,
      connectionTimeout: SMTP_CONNECT_TIMEOUT_MS,
      greetingTimeout: SMTP_CONNECT_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      dnsTimeout: SMTP_CONNECT_TIMEOUT_MS,
      tls: {
        servername: target.host,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(tls.ca === undefined ? {} : { ca: [tls.ca].flat() }),
      },
    });
    try {
      await transport.sendMail({
        from: target.from,
        to: [...target.to],
        subject: flat(`[Dialwarden] ${message.title}`).slice(0, 200),
        text: messageText(message),
        headers: { "Auto-Submitted": "auto-generated" },
      });
    } catch (error) {
      throw smtpFailure(error);
    } finally {
      transport.close();
    }
  });
}
