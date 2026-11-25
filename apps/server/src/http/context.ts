// What every route can reach (app.ctx), the request session and principal,
// and the route config keys: auth (public, user, viewer, editor, admin or
// owner; every matched route defaults to user, any signed-in user, so a route
// that should be open says auth "public"), server (where the route finds its
// game server and the access it needs there, P8-A), tokens (false for the
// identity routes an API token may never reach), entitlement (a FeatureKey;
// the route answers 402 on Free, contract C1) and web (the route of the
// built web app, contract C8).
import type {
  BuildInfo,
  EntitlementGate,
  FeatureKey,
} from "@dialwarden/entitlement";
import type { Pack } from "@dialwarden/packs-schema";
import type { ActivityService } from "../activity/service.js";
import type { AuditService } from "../audit/service.js";
import type { ChangeSetService } from "../changes/service.js";
import type { AuthService } from "../auth/service.js";
import type { SetupToken } from "../auth/first-run.js";
import type { ActiveSession, SessionService } from "../auth/sessions.js";
import type { BackupService } from "../backup/service.js";
import type { AppConfig } from "../config.js";
import type { ConnectorService } from "../connectors/service.js";
import type { HookService } from "../control/hooks.js";
import type { Aead } from "../crypto/aead.js";
import type { AppKey } from "../crypto/app-key.js";
import type { Settings } from "../db/settings.js";
import type { Store } from "../db/store.js";
import type { LicenceService } from "../licence/service.js";
import type { EditableServers } from "../plan/editable.js";
import type { PresetService } from "../presets/service.js";
import type { ServerService } from "../servers/service.js";
import type { SnapshotStore } from "../snapshots/store.js";
import type { TokenService } from "../team/api-access.js";
import type { GrantLevel, Principal } from "../team/roles.js";
import type { TeamService } from "../team/service.js";

export type AuthLevel =
  "public" | "user" | "viewer" | "editor" | "admin" | "owner";

/**
 * Where a route finds its game server: the slug path parameter, the change
 * set or snapshot of the id path parameter, or the server field of the body.
 */
export type ServerSource = "slug" | "changeSet" | "snapshot" | "bodyServer";

/**
 * The access a server-scoped route needs: read (any grant), write (an
 * editor or more with a write grant), admin or owner.
 */
export type ServerAccess = "read" | "write" | "admin" | "owner";

export interface ServerScope {
  from: ServerSource;
  access: ServerAccess;
}

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
  /** The one-time first-run setup token (DATA_DIR/setup-token). */
  setupToken: SetupToken;
  backups: BackupService;
  /** Connectors, the instance SSH key and the pinned host keys (C4). */
  connectors: ConnectorService;
  /** The game packs loaded at start, by pack id (contract C3). */
  packs: ReadonlyMap<string, Pack>;
  /** Game servers: the servers API, limits and connectors per server. */
  servers: ServerService;
  /** The hooks of every server: configuration, status probes and runs (C7). */
  hooks: HookService;
  /** Change sets, the write path, outside edits and history (C5). */
  changes: ChangeSetService;
  /** The saved user presets and their apply as change sets (P5 screen 7). */
  presets: PresetService;
  /** Content-addressed snapshot blobs under DATA_DIR/snapshots. */
  snapshots: SnapshotStore;
  /** Users, roles, grants, invitations and the privacy controls (P8-A). */
  team: TeamService;
  /** API tokens: hashed values, role-capped principals (P8-A step 6). */
  tokens: TokenService;
  /** The hash-chained audit log and its settings (P8-A). */
  audit: AuditService;
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
  server: ServerScope | null;
  tokens: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    session: ActiveSession | null;
    /** Who acts: the signed-in user or an API token (null: anonymous). */
    principal: Principal | null;
    /** The access the principal holds on the route's server, if scoped. */
    serverLevel: GrantLevel | null;
    /** The game server of a server-scoped route (the audit log names it). */
    serverId: string | null;
  }
  interface FastifyContextConfig {
    auth?: AuthLevel;
    entitlement?: FeatureKey;
    server?: ServerScope;
    /** False: an API token may not use this route (identity routes). */
    tokens?: boolean;
    /** The web app route: static files only, so no session is read. */
    web?: boolean;
  }
}
