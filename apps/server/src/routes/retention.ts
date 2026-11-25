// The snapshot retention settings (dev-work-plan P8-A step 7): keep every
// snapshot within the 1 GB meter (the default), the newest N versions of every
// file, or the last N days. A privacy control, so it works on every plan
// (contract C1) and never answers 402; only the owner and admins set it. The
// daily job of the retention service prunes what the settings name.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "../http/zod.js";
import {
  RETENTION_MODES,
  type SnapshotRetention,
} from "../privacy/retention.js";

/** What the settings answer: the full retention, normalised. */
const retentionAnswer = z.object({
  snapshotRetention: z.object({
    mode: z.enum(RETENTION_MODES),
    days: z.number().int().nullable(),
    versions: z.number().int().nullable(),
  }),
});

export function retentionRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const admin = { auth: "admin" as const };

  api.get(
    "/api/v1/settings/snapshots",
    {
      config: admin,
      schema: { tags: ["privacy"], response: { 200: retentionAnswer } },
    },
    async () => ({ snapshotRetention: app.ctx.retention.snapshotRetention() }),
  );

  api.put(
    "/api/v1/settings/snapshots",
    {
      config: admin,
      schema: {
        tags: ["privacy"],
        body: z.object({
          snapshotRetention: z.object({
            mode: z.enum(RETENTION_MODES),
            days: z.number().int().min(1).max(3650).nullish(),
            versions: z.number().int().min(1).max(1000).nullish(),
          }),
        }),
        response: { 200: retentionAnswer },
      },
    },
    async (request) => {
      const sent = request.body.snapshotRetention;
      const change: Partial<SnapshotRetention> = { mode: sent.mode };
      if (sent.mode === "days") change.days = sent.days ?? null;
      if (sent.mode === "versions") change.versions = sent.versions ?? null;
      return {
        snapshotRetention: app.ctx.retention.setSnapshotRetention(change),
      };
    },
  );
}
