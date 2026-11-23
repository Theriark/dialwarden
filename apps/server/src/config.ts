// Runtime configuration from the environment (dev-work-plan Runtime). Secrets
// are kept in this object only; nothing here is logged.
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  demoSeed: boolean;
  /** DEMO_SERVERS_DIR: where the demo seed makes its game folders. */
  demoServersDir: string;
  /** WEB_DIST: the built web app the server serves (contract C8). */
  webDist: string;
  /** PACKS_DIR: the game packs folder (default: @dialwarden/packs). */
  packsDir: string;
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"];
const HEX64 = /^[0-9a-fA-F]{64}$/;
const PROXY_ENTRY = /^[0-9a-fA-F.:]+(?:\/\d|\/\d\d|\/\d\d\d)?$/;
const ZERO_PREFIX = /\/0+$/;

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

/** An IP address or CIDR range; a /0 range trusts everyone, like a wildcard. */
function proxyEntry(entry: string): boolean {
  return PROXY_ENTRY.test(entry) && !ZERO_PREFIX.test(entry);
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
    demoSeed: env["DEMO_SEED"] === "true",
    demoServersDir: nonEmpty(env["DEMO_SERVERS_DIR"]) ?? "/demo-servers",
    webDist: nonEmpty(env["WEB_DIST"]) ?? DEFAULT_WEB_DIST,
    packsDir: nonEmpty(env["PACKS_DIR"]) ?? defaultPacksDir(),
  };
}
