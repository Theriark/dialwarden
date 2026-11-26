// Scheduled changes (dev-work-plan P9-A step 3, Paid feature schedules):
// list, make, read and remove. Every route declares config.entitlement, so
// the Free plan answers 402 (contract C1); the scheduler itself pauses every
// schedule on Free. A schedule writes to one server, so making or removing
// one needs write access there (an editor with a write grant, an admin or the
// owner); reading needs any grant, and the list shows only the schedules of
// the servers the caller may see.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RUN_HOOKS } from "../changes/types.js";
import { onBodyServer, onSchedule } from "../http/scope.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";
import { MAX_REVERT_MINUTES } from "../schedules/service.js";
import { actorOf } from "./changes.js";

// eslint-disable-next-line no-control-regex -- control characters are what is refused
const PRINTABLE = /^[^\x00-\x1f\x7f]*$/;

const RESULTS = [
  "applied",
  "pending",
  "conflict",
  "failed",
  "no_change",
  "missed",
] as const;

const scheduleSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  name: z.string(),
  author: z.string(),
  kind: z.enum(["once", "cron"]),
  runAt: z.string().nullable(),
  cron: z.string().nullable(),
  timezone: z.string(),
  revertAt: z.string().nullable(),
  revertAfterMinutes: z.number().int().nullable(),
  runHooks: z.enum(RUN_HOOKS),
  edits: z.array(z.object({ settingKey: z.string(), value: z.unknown() })),
  state: z.enum(["active", "paused", "done", "missed"]),
  pausedReason: z.literal("paid").nullable(),
  nextRunAt: z.string().nullable(),
  revertDueAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastResult: z.enum(RESULTS).nullable(),
  lastChangeSetId: z.string().nullable(),
  lastRevertAt: z.string().nullable(),
  lastRevertResult: z.enum(RESULTS).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const editSchema = z.object({
  settingKey: z.string().min(1).max(200),
  value: z.json(),
});

const createSchema = z.object({
  server: z.string().max(63).regex(SERVER_ID, "not a server id"),
  name: z.string().trim().min(1).max(80).regex(PRINTABLE),
  edits: z.array(editSchema).min(1).max(500),
  runHooks: z.enum(RUN_HOOKS).default("none"),
  /** Once, at this time (ISO 8601 with an offset). */
  runAt: z.iso.datetime({ offset: true }).optional(),
  /** Or on this cron pattern (five or six fields), in timezone. */
  cron: z.string().trim().min(9).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
  /** The revert of a run-at schedule, at this time. */
  revertAt: z.iso.datetime({ offset: true }).optional(),
  /** The revert of each cron run, this many minutes after it. */
  revertAfterMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_REVERT_MINUTES)
    .optional(),
});

const listQuery = z.object({
  server: z.string().max(63).regex(SERVER_ID, "not a server id").optional(),
});

const idParams = z.object({ id: z.uuid() });

export function scheduleRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const feature = { entitlement: "schedules" as const };
  const service = () => app.ctx.schedules;

  api.get(
    "/api/v1/schedules",
    {
      config: { auth: "user", ...feature },
      schema: {
        tags: ["schedules"],
        querystring: listQuery,
        response: { 200: z.object({ items: z.array(scheduleSchema) }) },
      },
    },
    async (request) => {
      const visible = app.ctx.team.visibleServers(request.principal);
      return { items: service().list(visible, request.query.server) };
    },
  );

  api.post(
    "/api/v1/schedules",
    {
      config: { ...onBodyServer("write"), ...feature },
      schema: {
        tags: ["schedules"],
        body: createSchema,
        response: { 201: scheduleSchema },
      },
    },
    async (request, reply) => {
      const schedule = service().create(request.body, actorOf(request));
      void reply.code(201);
      return schedule;
    },
  );

  api.get(
    "/api/v1/schedules/:id",
    {
      config: { ...onSchedule("read"), ...feature },
      schema: {
        tags: ["schedules"],
        params: idParams,
        response: { 200: scheduleSchema },
      },
    },
    async (request) => service().get(request.params.id),
  );

  api.delete(
    "/api/v1/schedules/:id",
    {
      config: { ...onSchedule("write"), ...feature },
      schema: { tags: ["schedules"], params: idParams },
    },
    async (request, reply) => {
      service().remove(request.params.id);
      return reply.code(204).send();
    },
  );
}
