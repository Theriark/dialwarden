// The audit log API (dev-work-plan P8-A steps 3 and 4), for the owner and
// admins. Recording never stops and the owner can always read and verify
// the log; the CSV export is the Paid part (feature audit, R&D default D5).
// The retention and IP settings are privacy controls and work on every plan.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCsv } from "../audit/csv.js";
import { IP_MODES } from "../audit/ip.js";
import { ApiError } from "../http/errors.js";
import type { ZodTypeProvider } from "../http/zod.js";

const filterSchema = z.object({
  actorId: z.string().max(100).optional(),
  action: z.string().max(200).optional(),
  serverId: z.string().max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

const entrySchema = z.object({
  id: z.number().int(),
  at: z.string(),
  actor: z.object({ id: z.string(), label: z.string(), erased: z.boolean() }),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  serverId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
});

const verifySchema = z.union([
  z.object({
    valid: z.literal(true),
    count: z.number().int(),
    headHash: z.string(),
  }),
  z.object({
    valid: z.literal(false),
    firstBrokenId: z.number().int().nullable(),
    reason: z.string(),
  }),
]);

export const auditSettingsSchema = z.object({
  ipMode: z.enum(IP_MODES),
  retentionDays: z.number().int().min(1).max(3650).nullable(),
});

/**
 * True when a retention change keeps the log for less time than now: from
 * forever (null) to any number of days, or to fewer days.
 */
export function shortensRetention(
  current: number | null,
  next: number | null,
): boolean {
  return next !== null && (current === null || next < current);
}

/** The filters without the fields left out (exactOptionalPropertyTypes). */
function filtersOf(query: z.infer<typeof filterSchema>) {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined),
  ) as { [K in keyof typeof query]?: string };
}

export function auditRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const admin = { auth: "admin" as const };

  api.get(
    "/api/v1/audit",
    {
      config: admin,
      schema: {
        tags: ["audit"],
        querystring: filterSchema.extend({
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: z.object({
            items: z.array(entrySchema),
            nextBefore: z.number().int().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { before, limit, ...filters } = request.query;
      return app.ctx.audit.list({
        limit,
        ...(before === undefined ? {} : { before }),
        ...filtersOf(filters),
      });
    },
  );

  api.get(
    "/api/v1/audit/verify",
    {
      config: admin,
      schema: { tags: ["audit"], response: { 200: verifySchema } },
    },
    async () => app.ctx.audit.verify(),
  );

  api.get(
    "/api/v1/audit/export.csv",
    {
      config: { ...admin, entitlement: "audit" },
      schema: { tags: ["audit"], querystring: filterSchema },
    },
    async (request, reply) => {
      const rows = app.ctx.audit.all(filtersOf(request.query));
      void reply.header("content-type", "text/csv; charset=utf-8");
      void reply.header(
        "content-disposition",
        'attachment; filename="dialwarden-audit.csv"',
      );
      void reply.header("cache-control", "no-store");
      return reply.send(auditCsv(rows));
    },
  );

  api.get(
    "/api/v1/settings/audit",
    {
      config: admin,
      schema: { tags: ["audit"], response: { 200: auditSettingsSchema } },
    },
    async () => app.ctx.audit.settingsOf(),
  );

  api.put(
    "/api/v1/settings/audit",
    {
      config: admin,
      schema: {
        tags: ["audit", "privacy"],
        body: auditSettingsSchema.partial(),
        response: { 200: auditSettingsSchema },
      },
    },
    async (request) => {
      const { ipMode, retentionDays } = request.body;
      // Only the owner shortens the retention (P10-A L24): an admin cannot
      // purge the trail of their own actions; raising it stays open to admins.
      const current = app.ctx.audit.settingsOf().retentionDays;
      const shorter =
        retentionDays !== undefined &&
        shortensRetention(current, retentionDays);
      if (shorter && request.principal?.role !== "owner") {
        throw new ApiError(403, "forbidden");
      }
      return app.ctx.audit.setSettings({
        ...(ipMode === undefined ? {} : { ipMode }),
        ...(retentionDays === undefined ? {} : { retentionDays }),
      });
    },
  );
}
