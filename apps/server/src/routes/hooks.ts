// The hooks and status API (dev-work-plan P6-B, contracts C5 and C7). Hooks
// and server status are Always Free in contract C1, so no route declares
// config.entitlement. Any signed-in user reads the state and the
// configuration; editors can trigger hook actions, and only the owner or an
// admin sets or changes the hook configuration (the roles arrive with P8;
// today the owner is the only account the app can make). Commands come only
// from the pack allow-list or the fixed per-server string, never free text.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ControlError } from "../control/types.js";
import type { HookService, ProbeInput } from "../control/hooks.js";
import { controlFailure } from "../control/hooks.js";
import { ConnectorError } from "../connectors/types.js";
import { ApiError } from "../http/errors.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";
import type { ServerRecord, ServerService } from "../servers/service.js";
import { actorOf } from "./changes.js";
import { connectorFailure } from "./connectors.js";

/**
 * A control or connector failure as its API error: the hooks read a server's
 * files through its connector and talk to its control endpoints, so both
 * kinds reach these routes. Anything else is rethrown untouched.
 */
export function hookFailure(error: unknown): ApiError {
  if (error instanceof ControlError) return controlFailure(error);
  return connectorFailure(error);
}

/** The roles that may set the hook configuration. */
const CONFIG_ROLES = new Set(["owner", "admin"]);

/** The roles that may trigger a hook action. */
const RUN_ROLES = new Set(["owner", "admin", "editor"]);

function requireRole(request: FastifyRequest, roles: Set<string>): void {
  const role = request.session?.user.role ?? "";
  if (!roles.has(role)) {
    throw new ApiError(403, "forbidden");
  }
}

const slugParams = z.object({
  slug: z.string().max(63).regex(SERVER_ID, "not a server id"),
});

const hookConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sshCommand"), command: z.string() }),
  z.object({
    kind: z.literal("dockerProxy"),
    url: z.string(),
    containerLabel: z.string(),
  }),
]);

const probeOverrideSchema = z.object({
  kind: z.string(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  hasPassword: z.boolean(),
});

const actionsSchema = z.object({
  save: z.string().nullable(),
  stop: z.string().nullable(),
  start: z.string().nullable(),
  restart: z.string().nullable(),
});

const hooksViewSchema = z.object({
  packId: z.string(),
  hooksSupported: z.array(z.string()),
  hook: hookConfigSchema.nullable(),
  probes: z.array(probeOverrideSchema),
  available: actionsSchema,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const probeInputSchema = z.object({
  host: z.string().min(1).max(253).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  password: z.string().min(1).max(256).optional(),
});

const putHooksBody = z.object({
  hook: hookConfigSchema.nullable().optional(),
  probes: z.record(z.string(), probeInputSchema.nullable()).optional(),
});

const runBody = z.object({
  action: z.enum(["save", "stop", "start", "restart"]),
});

const runAnswerSchema = z.object({
  action: z.enum(["save", "stop", "start", "restart"]),
  source: z.string(),
  at: z.string(),
  stopped: z.boolean().nullable(),
  flushed: z.number().int().nullable(),
});

const statusSchema = z.object({
  state: z.enum(["running", "stopped", "unknown"]),
  players: z.number().int().nullable(),
  source: z.string().nullable(),
  at: z.string(),
  pending: z.number().int(),
});

interface HooksDeps {
  readonly servers: ServerService;
  readonly hooks: HookService;
}

const EMPTY_ACTIONS = {
  save: null,
  stop: null,
  start: null,
  restart: null,
} as const;

/**
 * The hook configuration view of a server: what is set, what the pack
 * supports, and which client would run each action today. The actions need
 * the live values; a server whose files cannot be read still shows its
 * configuration, with no action available.
 */
async function hooksView(
  deps: HooksDeps,
  server: ServerRecord,
): Promise<z.infer<typeof hooksViewSchema>> {
  const { servers, hooks } = deps;
  const pack = servers.pack(server);
  const overrides = hooks.overrides(server.id);
  const updated = hooks.updated(server.id);
  const probes = pack.probes.map((probe) => {
    const override = overrides.get(probe.kind);
    return {
      kind: probe.kind,
      host: override?.host ?? null,
      port: override?.port ?? null,
      hasPassword: override?.passwordEnc !== undefined,
    };
  });
  let available: z.infer<typeof actionsSchema> = { ...EMPTY_ACTIONS };
  try {
    const context = await hooks.context(server);
    const sources = await hooks.sources(server, context);
    available = await hooks.actions(server, sources);
  } catch (error) {
    if (!(error instanceof ConnectorError)) throw error;
  }
  return {
    packId: pack.id,
    hooksSupported: [...pack.hooksSupported],
    hook: hooks.hookConfig(server.id),
    probes,
    available,
    updatedAt: updated?.updatedAt ?? null,
    updatedBy: updated?.updatedBy ?? null,
  };
}

export function hookRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const user = { auth: "user" as const };
  const deps = (): HooksDeps => ({
    servers: app.ctx.servers,
    hooks: app.ctx.hooks,
  });

  api.get(
    "/api/v1/servers/:slug/hooks",
    {
      config: user,
      schema: {
        tags: ["hooks"],
        params: slugParams,
        response: { 200: hooksViewSchema },
      },
    },
    async (request) => {
      const server = deps().servers.require(request.params.slug);
      return hooksView(deps(), server);
    },
  );

  api.put(
    "/api/v1/servers/:slug/hooks",
    {
      config: user,
      schema: {
        tags: ["hooks"],
        params: slugParams,
        body: putHooksBody,
        response: { 200: hooksViewSchema },
      },
    },
    async (request) => {
      requireRole(request, CONFIG_ROLES);
      const { servers, hooks } = deps();
      const server = servers.require(request.params.slug);
      const body = request.body;
      const input: {
        hook?: z.infer<typeof hookConfigSchema> | null;
        probes?: Record<string, ProbeInput | null>;
      } = {};
      if (body.hook !== undefined) input.hook = body.hook;
      if (body.probes !== undefined) input.probes = body.probes;
      hooks.setConfig(server, input, actorOf(request));
      return hooksView(deps(), server);
    },
  );

  api.post(
    "/api/v1/servers/:slug/hooks/run",
    {
      config: user,
      schema: {
        tags: ["hooks"],
        params: slugParams,
        body: runBody,
        response: { 200: runAnswerSchema },
      },
    },
    async (request) => {
      requireRole(request, RUN_ROLES);
      const { servers, hooks } = deps();
      const server = servers.require(request.params.slug);
      try {
        return await hooks.run(server, request.body.action, actorOf(request));
      } catch (error) {
        throw hookFailure(error);
      }
    },
  );

  api.get(
    "/api/v1/servers/:slug/status",
    {
      config: user,
      schema: {
        tags: ["hooks"],
        params: slugParams,
        response: { 200: statusSchema },
      },
    },
    async (request) => {
      const { servers, hooks } = deps();
      const server = servers.require(request.params.slug);
      let answer;
      try {
        answer = await hooks.status(server);
      } catch (error) {
        throw hookFailure(error);
      }
      let pending = app.ctx.changes.pending(server).length;
      if (answer.state === "stopped" && pending > 0) {
        // The server was seen stopped: the pending change sets are written
        // and their start hooks run (contract C5).
        await app.ctx.changes.flushPending(server, "system");
        pending = app.ctx.changes.pending(server).length;
      }
      return {
        ...answer,
        at: new Date().toISOString(),
        pending,
      };
    },
  );
}
