// The hooks and status API (dev-work-plan P6-B, contracts C5 and C7). Hooks
// and server status are Always Free in contract C1, so no route declares
// config.entitlement. Every user with a grant on the server reads its state
// and the hook kinds; editors with a write grant trigger hook actions, and
// only the owner or an admin sets or changes the hook configuration and sees
// the command string and the proxy URL (P8-A, D20: they can carry
// credentials). Commands come only from the pack allow-list or the fixed
// per-server string, never free text. Reading the status writes pending
// change sets only for a caller who could write them (D19).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ControlError } from "../control/types.js";
import type { HookService, ProbeInput } from "../control/hooks.js";
import { controlFailure } from "../control/hooks.js";
import { ConnectorError } from "../connectors/types.js";
import type { ApiError } from "../http/errors.js";
import { onSlug } from "../http/scope.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";
import type { ServerRecord, ServerService } from "../servers/service.js";
import { actorLabel } from "../team/labels.js";
import { atLeast } from "../team/roles.js";
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

/** What editors and viewers see instead of a command string or a URL. */
const HIDDEN = "********";

/** True when the caller may see the hook configuration in full. */
function seesConfig(request: FastifyRequest): boolean {
  return atLeast(request.principal?.role ?? "", "admin");
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
  /** Resolves the updatedBy actor id to its display label (D7). */
  readonly labelOf: (id: string | null) => string | null;
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
  full: boolean,
): Promise<z.infer<typeof hooksViewSchema>> {
  const { servers, hooks } = deps;
  const hook = hooks.hookConfig(server.id);
  let shown = hook;
  if (!full && hook?.kind === "sshCommand") {
    shown = { ...hook, command: HIDDEN };
  } else if (!full && hook?.kind === "dockerProxy") {
    shown = { ...hook, url: HIDDEN };
  }
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
    const known =
      error instanceof ConnectorError || error instanceof ControlError;
    if (!known) throw error;
  }
  return {
    packId: pack.id,
    hooksSupported: [...pack.hooksSupported],
    hook: shown,
    probes,
    available,
    updatedAt: updated?.updatedAt ?? null,
    updatedBy: deps.labelOf(updated?.updatedBy ?? null),
  };
}

export function hookRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const deps = (): HooksDeps => ({
    servers: app.ctx.servers,
    hooks: app.ctx.hooks,
    labelOf: (id) => (id === null ? null : actorLabel(app.ctx.store, id)),
  });

  api.get(
    "/api/v1/servers/:slug/hooks",
    {
      config: onSlug("read"),
      schema: {
        tags: ["hooks"],
        params: slugParams,
        response: { 200: hooksViewSchema },
      },
    },
    async (request) => {
      const server = deps().servers.require(request.params.slug);
      return hooksView(deps(), server, seesConfig(request));
    },
  );

  api.put(
    "/api/v1/servers/:slug/hooks",
    {
      config: onSlug("admin"),
      schema: {
        tags: ["hooks"],
        params: slugParams,
        body: putHooksBody,
        response: { 200: hooksViewSchema },
      },
    },
    async (request) => {
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
      return hooksView(deps(), server, true);
    },
  );

  api.post(
    "/api/v1/servers/:slug/hooks/run",
    {
      config: onSlug("write"),
      schema: {
        tags: ["hooks"],
        params: slugParams,
        body: runBody,
        response: { 200: runAnswerSchema },
      },
    },
    async (request) => {
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
      config: onSlug("read"),
      schema: {
        tags: ["hooks"],
        params: slugParams,
        response: { 200: statusSchema },
      },
    },
    async (request) => {
      const { servers, hooks } = deps();
      const server = servers.require(request.params.slug);
      const writer = request.serverLevel === "write";
      let answer;
      let pending = 0;
      try {
        answer = await hooks.status(server);
        pending = app.ctx.changes.pending(server).length;
        if (writer && answer.state === "stopped" && pending > 0) {
          // The server was seen stopped: the pending change sets are written
          // and the start hook runs once after them (contract C5). Only a
          // caller with a write grant triggers the write (D19).
          await app.ctx.changes.flushPending(server, "system");
          pending = app.ctx.changes.pending(server).length;
        }
      } catch (error) {
        throw hookFailure(error);
      }
      return {
        ...answer,
        at: new Date().toISOString(),
        pending,
      };
    },
  );
}
