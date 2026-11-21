// The Dialwarden server (dev-work-plan P1-A): Fastify 5 with zod schemas,
// OpenAPI 3.1 at /api/v1/openapi.json, pino with redaction, SQLite through the
// store, authentication, the licence and entitlement gate, activity and the
// backup engine. buildApp() opens everything; app.close() closes it again.
import { hkdfSync, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import fastifyCookie from "@fastify/cookie";
import fastifySwagger from "@fastify/swagger";
import {
  EntitlementGate,
  loadKeyRing,
  readBuildInfo,
  REVOKED_LID_HASHES,
  ruleDates,
  type KeyRing,
} from "@dialwarden/entitlement";
import { fastify, type FastifyInstance } from "fastify";
import { ActivityService } from "./activity/service.js";
import { AuthService } from "./auth/service.js";
import { SessionService } from "./auth/sessions.js";
import { BackupService } from "./backup/service.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createAead } from "./crypto/aead.js";
import { loadAppKey } from "./crypto/app-key.js";
import { Settings } from "./db/settings.js";
import { Store } from "./db/store.js";
import type { AppContext } from "./http/context.js";
import { errorHandler } from "./http/errors.js";
import { registerGuard } from "./http/guard.js";
import {
  openApiTransform,
  serializerCompiler,
  validatorCompiler,
} from "./http/zod.js";
import { LicenceService } from "./licence/service.js";
import { loggerOptions } from "./log.js";
import { EditableServers } from "./plan/editable.js";
import { activityRoutes } from "./routes/activity.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { licenceRoutes } from "./routes/licence.js";
import { systemRoutes } from "./routes/system.js";
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

export async function buildApp(
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const config: AppConfig = { ...loadConfig(env), ...options.config };
  const now = options.now ?? (() => new Date());
  const build = readBuildInfo(env);
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
  const editable = new EditableServers(settings);
  const entitlement = new EntitlementGate(
    () => licences.current(),
    () => editable.effective(),
  );
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
    sessions: new SessionService(store, now),
    auth: new AuthService({ store, aead, appKey: appKey.key, activity, now }),
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
    maintenance: false,
    routes: [],
  };
  app.decorate("ctx", ctx);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      ctx.routes.push({
        method: String(method),
        url: route.url,
        auth: route.config?.auth ?? null,
        entitlement: route.config?.entitlement ?? null,
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
  registerGuard(app);

  healthRoutes(app);
  authRoutes(app);
  licenceRoutes(app);
  activityRoutes(app);
  systemRoutes(app);
  app.get(
    "/api/v1/openapi.json",
    { config: { auth: "public" }, schema: { hide: true } },
    async () => app.swagger(),
  );
  options.extend?.(app);

  await app.ready();
  return app;
}
