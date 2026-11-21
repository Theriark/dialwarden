// Runtime configuration from the environment (dev-work-plan Runtime). Secrets
// are kept in this object only; nothing here is logged.
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
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"];
const HEX64 = /^[0-9a-fA-F]{64}$/;
const PROXY_ENTRY = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/;
const ZERO_PREFIX = /\/0+$/;

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
  };
}
