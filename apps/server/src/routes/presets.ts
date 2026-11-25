// The saved user presets (screen 7 of dev-work-plan P5): list, create from
// a server's current values or a selection of them, remove, and apply to one
// server of the same game as a draft change set of cause preset (contract
// C5). Presets are Always Free up to the limit(presets) of contract C1,
// three saved on Free and unlimited on Paid, so no route declares
// config.entitlement; PresetService answers 402 with the limit body instead,
// the upgrade hint the Presets screen renders. Applying is a change set on
// an editable server, so like the change-set routes it needs only a session;
// saving and removing the owner's presets is an owner action, like adding
// and removing servers. The bulk routes of P9-A are Paid (presets.bulk).
import { isPackId } from "@dialwarden/packs-schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CHANGE_SET_STATUSES, RUN_HOOKS } from "../changes/types.js";
import { onBodyServer } from "../http/scope.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";
import { serverLevel } from "../team/roles.js";
import { actorOf, changeSetSchema } from "./changes.js";
import { connectorFailure } from "./connectors.js";

// eslint-disable-next-line no-control-regex -- control characters are what is refused
const PRINTABLE = /^[^\x00-\x1f\x7f]*$/;

const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  packId: z.string(),
  createdAt: z.string(),
  values: z.record(z.string(), z.unknown()),
});

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(80).regex(PRINTABLE),
  description: z.string().trim().max(200).regex(PRINTABLE),
  packId: z.string().max(40).refine(isPackId, "not a game pack id"),
  values: z
    .record(z.string(), z.json())
    .refine((values) => Object.keys(values).length <= 500, {
      message: "at most 500 values",
    }),
});

const slug = z.string().max(63).regex(SERVER_ID, "not a server id");

const applyBodySchema = z.object({ server: slug });

const idParams = z.object({ id: z.uuid() });

const failureSchema = z.object({ code: z.string() }).loose();

const bulkDraftSchema = z.object({
  server: z.string(),
  changeSet: changeSetSchema.nullable(),
  error: failureSchema.nullable(),
});

const bulkReportSchema = z.object({
  items: z.array(
    z.object({
      changeSetId: z.string(),
      server: z.string().nullable(),
      status: z.enum([...CHANGE_SET_STATUSES, "refused"] as const),
      error: failureSchema.nullable(),
    }),
  ),
  applied: z.number().int(),
  pending: z.number().int(),
  failed: z.number().int(),
});

export function presetRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const owner = { auth: "owner" as const };
  const user = { auth: "user" as const };
  const service = () => app.ctx.presets;

  api.get(
    "/api/v1/presets",
    {
      config: user,
      schema: {
        tags: ["presets"],
        response: { 200: z.object({ items: z.array(presetSchema) }) },
      },
    },
    async () => ({ items: service().list() }),
  );

  api.post(
    "/api/v1/presets",
    {
      config: owner,
      schema: {
        tags: ["presets"],
        body: createBodySchema,
        response: { 201: presetSchema },
      },
    },
    async (request, reply) => {
      const preset = service().create(request.body);
      void reply.code(201);
      return preset;
    },
  );

  api.delete(
    "/api/v1/presets/:id",
    {
      config: owner,
      schema: { tags: ["presets"], params: idParams },
    },
    async (request, reply) => {
      service().remove(request.params.id);
      return reply.code(204).send();
    },
  );

  api.post(
    "/api/v1/presets/:id/apply",
    {
      config: onBodyServer("write"),
      schema: {
        tags: ["presets"],
        params: idParams,
        body: applyBodySchema,
        response: { 200: changeSetSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      try {
        return await service().apply(
          request.params.id,
          request.body.server,
          actor,
        );
      } catch (error) {
        throw connectorFailure(error);
      }
    },
  );

  // The bulk apply of P9-A (Paid, presets.bulk). An editor or more may ask;
  // each server is checked against the caller's grants in the service, and a
  // server the caller may not write answers server_not_found in its item.
  const bulk = {
    auth: "editor" as const,
    entitlement: "presets.bulk" as const,
  };

  /** Whether the caller may write on a server (P8 grants, Free fallback). */
  const writer = (request: FastifyRequest) => (serverId: string) => {
    const principal = request.principal;
    if (principal === null) return false;
    const grant = app.ctx.team.grantLevel(principal.userId, serverId);
    return serverLevel(principal, grant) === "write";
  };

  api.post(
    "/api/v1/presets/:id/bulk-drafts",
    {
      config: bulk,
      schema: {
        tags: ["presets"],
        params: idParams,
        body: z.object({ servers: z.array(slug).min(1).max(200) }),
        response: { 200: z.object({ items: z.array(bulkDraftSchema) }) },
      },
    },
    async (request) => {
      const items = await service().bulkDrafts(
        request.params.id,
        request.body.servers,
        actorOf(request),
        writer(request),
      );
      return { items };
    },
  );

  api.post(
    "/api/v1/presets/bulk-apply",
    {
      config: bulk,
      schema: {
        tags: ["presets"],
        body: z.object({
          changeSets: z.array(z.uuid()).min(1).max(200),
          runHooks: z.enum(RUN_HOOKS).default("none"),
        }),
        response: { 200: bulkReportSchema },
      },
    },
    async (request) =>
      service().bulkApply(
        request.body.changeSets,
        actorOf(request),
        request.body.runHooks,
        writer(request),
      ),
  );
}
