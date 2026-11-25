// Runtime configuration from the environment (dev-work-plan Runtime). Secrets
// are kept in this object only; nothing here is logged.
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ipaddr from "ipaddr.js";
import { z } from "zod";

export interface AppConfig {
  dataDir: string;
  host: string;
  port: number;
  /** BASE_URL; https makes the session cookie Secure. */
  baseUrl: string | null;
  logLevel: string;
  /** TRUSTED_PROXIES as Fastify trustProxy (comma list), or false. */
  trustProxy: string | false;
  /** APP_SECRET_KEY (64 hex characters), or null to use /data/app-secret.key. */
  appSecretKey: string | null;
  /** SESSION_SECRET (64 hex characters), or null to derive one. */
  sessionSecret: string | null;
  /** DIALWARDEN_LICENCE, read once at start and held in memory only. */
  envLicence: string | null;
  backupSchedule: string;
  backupTimezone: string;
  /** The privacy retention job (P8-A): RETENTION_SCHEDULE and RETENTION_TZ. */
  retentionSchedule: string;
  retentionTimezone: string;
  demoSeed: boolean;
  /** DEMO_SERVERS_DIR: where the demo seed makes its game folders. */
  demoServersDir: string;
  /** WEB_DIST: the built web app the server serves (contract C8). */
  webDist: string;
  /** PACKS_DIR: the game packs folder (default: @dialwarden/packs). */
  packsDir: string;
  /**
   * HOOK_WAIT_MS: how long a stop or start waits for the status probe to
   * see the new state (P6-B). Games that save a large world on shutdown can
   * need more than the default.
   */
  hookWaitMs: number;
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"];
const HEX64 = /^[0-9a-fA-F]{64}$/;
const PROXY_ENTRY = /^[0-9a-fA-F.:]+(?:\/\d|\/\d\d|\/\d\d\d)?$/;

// The folder public next to the server build (dist/config.js), which is
// /app/public in the image. From the sources it is apps/server/public, which
// does not exist, so tests and API-only runs serve no web UI.
const DEFAULT_WEB_DIST = fileURLToPath(new URL("../public/", import.meta.url));

// The folder of the @dialwarden/packs package: packs/ in the workspace, and
// node_modules/@dialwarden/packs in the image, where pnpm deploy copies the
// pack.json files and fixtures of every pack (packs/package.json "files").
function defaultPacksDir(): string {
  try {
    const resolver = createRequire(import.meta.url);
    return dirname(resolver.resolve("@dialwarden/packs/package.json"));
  } catch {
    // Not installed: the loader logs that the folder is missing.
    return fileURLToPath(new URL("../packs/", import.meta.url));
  }
}

const nonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

const hex64 = (name: string, value: string | undefined): string | null => {
  const found = nonEmpty(value);
  if (found !== null && !HEX64.test(found)) {
    throw new Error(`${name} must be 64 hexadecimal characters`);
  }
  return found === null ? null : found.toLowerCase();
};

/**
 * An IPv6 range that lies inside ::/80 (the IPv4-mapped ::ffff:0:0/96 and
 * the old IPv4-compatible ::/96 included). The proxy check compares an IPv4
 * peer with an IPv6 range in its mapped form, so such a range is an IPv4
 * range in disguise.
 */
function insideLow80(address: string): boolean {
  const bytes = ipaddr.IPv6.parse(address).toByteArray();
  return bytes.slice(0, 10).every((byte) => byte === 0);
}

/**
 * An IP address or CIDR range. A wide range trusts nearly everyone, like a
 * wildcard: IPv4 ranges need at least /8 and IPv6 ranges at least /32 (D22),
 * so 0.0.0.0/0 and pairs such as 0.0.0.0/1 plus 128.0.0.0/1 are refused. An
 * IPv6 range inside ::/80 holds IPv4 peers, so it needs at least /104 (an
 * IPv4 /8): ::ffff:0:0/96 or ::/32 would trust every IPv4 client.
 */
function proxyEntry(entry: string): boolean {
  if (!PROXY_ENTRY.test(entry)) return false;
  const [address = "", prefix] = entry.split("/");
  const kind = isIP(address);
  if (kind === 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  if (kind === 4) return bits >= 8 && bits <= 32;
  const least = insideLow80(address) ? 104 : 32;
  return bits >= least && bits <= 128;
}

/** IP addresses and CIDR ranges only; a wildcard is refused. */
function trustProxy(value: string | undefined): string | false {
  const found = nonEmpty(value);
  if (found === null) {
    return false;
  }
  const entries = found.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !proxyEntry(entry))) {
    throw new Error("TRUSTED_PROXIES must list IP addresses or CIDR ranges");
  }
  return entries.join(",");
}

const portSchema = z.coerce.number().int().min(1).max(65535);
const waitSchema = z.coerce.number().int().min(1).max(120_000);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseUrl = nonEmpty(env["BASE_URL"]);
  if (baseUrl !== null && !/^https?:\/\/[^\s/]+/.test(baseUrl)) {
    throw new Error("BASE_URL must be an http or https URL");
  }
  const level = nonEmpty(env["LOG_LEVEL"]) ?? "info";
  return {
    dataDir: nonEmpty(env["DATA_DIR"]) ?? "/data",
    host: nonEmpty(env["HOST"]) ?? "0.0.0.0",
    port: portSchema.parse(nonEmpty(env["PORT"]) ?? "8080"),
    baseUrl,
    logLevel: LOG_LEVELS.includes(level) || level === "silent" ? level : "info",
    trustProxy: trustProxy(env["TRUSTED_PROXIES"]),
    appSecretKey: hex64("APP_SECRET_KEY", env["APP_SECRET_KEY"]),
    sessionSecret: hex64("SESSION_SECRET", env["SESSION_SECRET"]),
    envLicence: nonEmpty(env["DIALWARDEN_LICENCE"]),
    backupSchedule: nonEmpty(env["BACKUP_SCHEDULE"]) ?? "30 3 * * *",
    backupTimezone: nonEmpty(env["BACKUP_TZ"]) ?? "Europe/Lisbon",
    retentionSchedule: nonEmpty(env["RETENTION_SCHEDULE"]) ?? "50 3 * * *",
    retentionTimezone: nonEmpty(env["RETENTION_TZ"]) ?? "Europe/Lisbon",
    demoSeed: env["DEMO_SEED"] === "true",
    demoServersDir: nonEmpty(env["DEMO_SERVERS_DIR"]) ?? "/demo-servers",
    webDist: nonEmpty(env["WEB_DIST"]) ?? DEFAULT_WEB_DIST,
    packsDir: nonEmpty(env["PACKS_DIR"]) ?? defaultPacksDir(),
    hookWaitMs: waitSchema.parse(nonEmpty(env["HOOK_WAIT_MS"]) ?? "10000"),
  };
}
