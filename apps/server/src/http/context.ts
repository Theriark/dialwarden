// What every route can reach (app.ctx), the request session, and the route
// config keys: auth (public, user or owner; every matched route defaults to
// user, so a route that should be open says auth "public") and
// entitlement (a FeatureKey; the route answers 402 on Free, contract C1).
import type {
  BuildInfo,
  EntitlementGate,
  FeatureKey,
} from "@dialwarden/entitlement";
import type { ActivityService } from "../activity/service.js";
import type { AuthService } from "../auth/service.js";
import type { ActiveSession, SessionService } from "../auth/sessions.js";
import type { BackupService } from "../backup/service.js";
import type { AppConfig } from "../config.js";
import type { Aead } from "../crypto/aead.js";
import type { AppKey } from "../crypto/app-key.js";
import type { Settings } from "../db/settings.js";
import type { Store } from "../db/store.js";
import type { LicenceService } from "../licence/service.js";
import type { EditableServers } from "../plan/editable.js";

export type AuthLevel = "public" | "user" | "owner";

export interface AppContext {
  config: AppConfig;
  version: string;
  build: BuildInfo;
  store: Store;
  settings: Settings;
  appKey: AppKey;
  aead: Aead;
  activity: ActivityService;
  licences: LicenceService;
  entitlement: EntitlementGate;
  editable: EditableServers;
  sessions: SessionService;
  auth: AuthService;
  backups: BackupService;
  /** True while a first-run import replaces the database: the API answers 503. */
  maintenance: boolean;
  /** True while a first-run import runs (one at a time). */
  importing: boolean;
  /** Every registered route (the registry test reads it). */
  routes: RouteInfo[];
}

export interface RouteInfo {
  method: string;
  url: string;
  auth: AuthLevel | null;
  entitlement: FeatureKey | null;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    session: ActiveSession | null;
  }
  interface FastifyContextConfig {
    auth?: AuthLevel;
    entitlement?: FeatureKey;
  }
}
