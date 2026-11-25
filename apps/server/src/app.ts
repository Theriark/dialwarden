// The Dialwarden server (dev-work-plan P1-A): Fastify 5 with zod schemas,
// OpenAPI 3.1 at /api/v1/openapi.json, pino with redaction, SQLite through the
// store, authentication, the licence and entitlement gate, activity, the
// backup engine, connectors, servers, change sets and snapshots (P4), and the
// built web app with its security headers (contract C8). buildApp() opens
// everything; app.close() closes it again.
import { hkdfSync, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import fastifyCookie from "@fastify/cookie";
import fastifySwagger from "@fastify/swagger";
import {
  EntitlementGate,
  loadKeyRing,
  REVOKED_LID_HASHES,
  ruleDates,
  type KeyRing,
} from "@dialwarden/entitlement";
import { loadPacks } from "@dialwarden/packs-schema/node";
import { fastify, type FastifyInstance } from "fastify";
import { ActivityService } from "./activity/service.js";
import { registerAuditRecording } from "./audit/record.js";
import { AuditService } from "./audit/service.js";
import { bootstrapOwner, openFirstRunSetup } from "./auth/bootstrap.js";
import { SetupToken } from "./auth/first-run.js";
import { LoginLimiter } from "./auth/limiter.js";
import { AuthService } from "./auth/service.js";
import { SessionService } from "./auth/sessions.js";
import { BackupService } from "./backup/service.js";
import { loadBuildInfo } from "./build-info.js";
import { ChangeSetService } from "./changes/service.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ConnectorService } from "./connectors/service.js";
import { createAead } from "./crypto/aead.js";
import { loadAppKey } from "./crypto/app-key.js";
import { HookService } from "./control/hooks.js";
import { Settings } from "./db/settings.js";
import { Store } from "./db/store.js";
import type { AppContext } from "./http/context.js";
import { errorHandler } from "./http/errors.js";
import { registerGuard } from "./http/guard.js";
import { registerSecurityHeaders } from "./http/headers.js";
import { loadWebDist, webRoutes } from "./http/web.js";
import {
  openApiTransform,
  serializerCompiler,
  validatorCompiler,
} from "./http/zod.js";
import { LicenceService } from "./licence/service.js";
import { loggerOptions } from "./log.js";
import { EditableServers } from "./plan/editable.js";
import { PresetService } from "./presets/service.js";
import { activityRoutes } from "./routes/activity.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { changeRoutes } from "./routes/changes.js";
import { connectorRoutes } from "./routes/connectors.js";
import { gameRoutes } from "./routes/games.js";
import { healthRoutes } from "./routes/health.js";
import { hookRoutes } from "./routes/hooks.js";
import { invitationRoutes } from "./routes/invitations.js";
import { licenceRoutes } from "./routes/licence.js";
import { presetRoutes } from "./routes/presets.js";
import { serverRoutes } from "./routes/servers.js";
import { systemRoutes } from "./routes/system.js";
import { userRoutes } from "./routes/users.js";
import { seedDemoServers } from "./servers/demo.js";
import { ServerService } from "./servers/service.js";
import { SnapshotStore } from "./snapshots/store.js";
import { TeamService } from "./team/service.js";
import { VERSION } from "./version.js";

export { VERSION };

export interface BuildOptions {
  /** Environment to read (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Overrides on top of the environment (tests). */
  config?: Partial<AppConfig>;
  /** Public keys; tests inject throwaway keys here (default: the slots). */
  keys?: KeyRing;
  /** Revoked lid hashes (default: the compiled list). */
  revoked?: readonly string[];
  now?: () => Date;
  /** Where log lines go (tests read them); default standard output. */
  logStream?: NodeJS.WritableStream;
  /** Registers more routes before the app is ready (tests, later modules). */
  extend?: (app: FastifyInstance) => void;
  /** The build information file read in production (tests pass their own). */
  buildInfoFile?: string;
  /** Where the first-run setup line goes (default standard output). */
  out?: NodeJS.WritableStream;
  /**
   * Tests only, never read from the environment: requests that carry the
   * role-matrix header answer 299 once every access check passed.
   */
  authProbe?: boolean;
}

function cookieSecret(config: AppConfig, appKey: Buffer): string {
  if (config.sessionSecret !== null) {
    return config.sessionSecret;
  }
  const derived = hkdfSync(
    "sha256",
    appKey,
    Buffer.alloc(0),
    "dialwarden-session-cookie",
    32,
  );
  return Buffer.from(derived).toString("hex");
}

/**
 * The demo seed of DEMO_SEED (dev-work-plan P4-B step 5), before the server
 * listens. A failure is logged and never stops the server.
 */
async function seedDemo(app: FastifyInstance): Promise<void> {
  const { config, packs, servers, changes, connectors } = app.ctx;
  try {
    const created = await seedDemoServers({
      demoSeed: config.demoSeed,
      demoServersDir: config.demoServersDir,
      packsDir: config.packsDir,
      packs,
      servers,
      changes,
      connectors,
    });
    if (created.length > 0) {
      app.log.info({ servers: created }, "demo servers seeded");
    }
  } catch (error) {
    app.log.error({ err: error }, "demo seed failed");
  }
}

export async function buildApp(
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const config: AppConfig = { ...loadConfig(env), ...options.config };
  const now = options.now ?? (() => new Date());
  const build = loadBuildInfo(env, options.buildInfoFile);
  const startedAt = now();

  const app = fastify({
    logger: loggerOptions(config.logLevel, options.logStream),
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the configured data folder
  mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
  const appKey = loadAppKey(config.dataDir, config.appSecretKey);
  if (appKey.generated) {
    app.log.warn(
      "generated DATA_DIR/app-secret.key: back it up, a backup restores only with the same key",
    );
  }
  const aead = createAead(appKey.key);
  const store = new Store(config.dataDir, now);
  const migration = await store.open();
  if (migration.applied.length > 0) {
    app.log.info(
      { applied: migration.applied, copy: migration.preMigrationCopy },
      "database migrated",
    );
  }

  const settings = new Settings(store);
  const activity = new ActivityService(store, now);
  const licences = new LicenceService({
    store,
    settings,
    aead,
    activity,
    rule: {
      keys: options.keys ?? loadKeyRing(),
      build: ruleDates(build, startedAt),
      revoked: options.revoked ?? REVOKED_LID_HASHES,
    },
    build,
    envLicence: config.envLicence,
    log: app.log,
    now,
  });
  // Game packs (contract C3): a broken pack is refused with a log line and
  // never stops the server.
  const packs = loadPacks(config.packsDir, app.log);
  const editable = new EditableServers(settings);
  const entitlement = new EntitlementGate(
    () => licences.current(),
    () => editable.effective(),
  );
  const connectors = new ConnectorService({
    store,
    aead,
    dataDir: config.dataDir,
    now,
  });
  const servers = new ServerService({
    store,
    aead,
    connectors,
    packs: packs.packs,
    entitlement,
    now,
  });
  // The Free fallback of P1 learns which servers exist and which were
  // edited last (rnd-report-1 3.4).
  editable.setProviders({
    recentlyEdited: () => servers.recentlyEdited(),
    exists: (id) => servers.exists(id),
  });
  const snapshots = new SnapshotStore(store, config.dataDir, now);
  // The hooks of P6-B (contract C7): the per-server hook configuration, the
  // status probes and the hook runs. The change set service holds a server's
  // lock while it applies, so the hook service never reads a server's files
  // from inside an apply.
  const hooks = new HookService({
    store,
    aead,
    activity,
    servers,
    connectors,
    waitMs: config.hookWaitMs,
    now,
  });
  const changes = new ChangeSetService({
    store,
    aead,
    servers,
    snapshots,
    activity,
    entitlement,
    hooks,
    now,
  });
  hooks.setChanges(changes);
  const presets = new PresetService({
    store,
    packs: packs.packs,
    servers,
    changes,
    entitlement,
    now,
  });
  // One login limiter for sign-in, invitation accepts and reset links, so
  // failed attempts of every kind count against the same client address.
  const limiter = new LoginLimiter(() => now().getTime());
  const sessions = new SessionService(store, now);
  const team = new TeamService({
    store,
    activity,
    entitlement,
    sessions,
    limiter,
    baseUrl: config.baseUrl,
    now,
  });
  const audit = new AuditService({ store, settings, appKey: appKey.key, now });
  const ctx: AppContext = {
    config,
    version: VERSION,
    build,
    store,
    settings,
    appKey,
    aead,
    activity,
    licences,
    entitlement,
    editable,
    sessions,
    auth: new AuthService({ store, aead, activity, now, limiter }),
    setupToken: new SetupToken(config.dataDir),
    backups: new BackupService({
      store,
      activity,
      aead,
      appKey: appKey.key,
      log: app.log,
      appVersion: VERSION,
      revision: build.revision,
      now,
    }),
    connectors,
    packs: packs.packs,
    servers,
    hooks,
    changes,
    presets,
    snapshots,
    team,
    audit,
    maintenance: false,
    importing: false,
    routes: [],
  };
  app.decorate("ctx", ctx);
  // Before the server listens: the owner from DEV_SEED_OWNER_*, then the
  // setup token while no owner exists (R&D decision THE-2141).
  await bootstrapOwner(ctx, env, app.log, now);
  openFirstRunSetup(ctx, options.out ?? process.stdout);
  await seedDemo(app);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      ctx.routes.push({
        method: String(method),
        url: route.url,
        auth: route.config?.auth ?? null,
        entitlement: route.config?.entitlement ?? null,
        server: route.config?.server ?? null,
        tokens: route.config?.tokens ?? true,
      });
    }
  });
  app.addHook("onClose", async () => {
    await ctx.backups.stop();
    ctx.store.close();
  });

  await app.register(fastifyCookie, {
    secret: cookieSecret(config, appKey.key),
  });
  // The first-run import streams its body (see routes/auth.ts).
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => {
      done(null, payload);
    },
  );
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Dialwarden API",
        version: VERSION,
        description:
          "Session cookie dw_session plus the X-CSRF-Token header on every state-changing request.",
      },
    },
    transform: openApiTransform,
  });
  registerGuard(app, { authProbe: options.authProbe === true });
  registerAuditRecording(app);
  // Contract C8: the built web app (none in tests and API-only runs) and the
  // security headers of every response.
  const web = loadWebDist(config.webDist, app.log);
  registerSecurityHeaders(app, web?.scriptHashes ?? []);

  healthRoutes(app);
  authRoutes(app);
  licenceRoutes(app);
  activityRoutes(app);
  systemRoutes(app);
  gameRoutes(app);
  connectorRoutes(app);
  serverRoutes(app);
  changeRoutes(app);
  presetRoutes(app);
  hookRoutes(app);
  userRoutes(app);
  invitationRoutes(app);
  auditRoutes(app);
  app.get(
    "/api/v1/openapi.json",
    { config: { auth: "public" }, schema: { hide: true } },
    async () => app.swagger(),
  );
  if (web !== null) {
    webRoutes(app, web);
  }
  options.extend?.(app);

  await app.ready();
  return app;
}
