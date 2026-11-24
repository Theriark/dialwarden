// The saved user presets (screen 7 of dev-work-plan P5): list, create from
// a server's current values or a selection of them, remove, and apply to one
// server of the same game as a draft change set of cause preset (contract
// C5). Presets are Always Free up to the limit(presets) of contract C1,
// three saved on Free and unlimited on Paid, so no route declares
// config.entitlement; PresetService answers 402 with the limit body instead,
// the upgrade hint the Presets screen renders. Applying is a change set on
// an editable server, so like the change-set routes it needs only a session;
// saving and removing the owner's presets is an owner action, like adding
// and removing servers.
import { isPackId } from "@dialwarden/packs-schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";
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

const applyBodySchema = z.object({
  server: z.string().max(63).regex(SERVER_ID, "not a server id"),
});

const idParams = z.object({ id: z.uuid() });

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
      config: user,
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
}
