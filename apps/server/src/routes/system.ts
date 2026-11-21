// Owner-only system endpoints: status (with the back-up-your-key banner),
// backups (list, run now, restore drill) and the passphrase export.
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MIN_PASSPHRASE_LENGTH } from "../backup/archive.js";
import { BACKUP_ID } from "../backup/engine.js";
import { SETTING_KEYS } from "../db/settings.js";
import type { ZodTypeProvider } from "../http/zod.js";

const checkSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

const backupItemSchema = z.object({
  id: z.string(),
  createdAt: z.string().nullable(),
  sizeBytes: z.number().int(),
  blobCount: z.number().int(),
  appVersion: z.string().nullable(),
  integrity: z.enum(["ok", "incomplete"]),
});

const idParams = z.object({ id: z.string().regex(BACKUP_ID) });

export function systemRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const owner = { auth: "owner" as const };

  api.get(
    "/api/v1/system/status",
    {
      config: owner,
      schema: {
        tags: ["system"],
        response: {
          200: z.object({
            version: z.string(),
            revision: z.string(),
            buildDate: z.string().nullable(),
            featureBaseline: z.string().nullable(),
            appSecret: z.object({
              source: z.enum(["environment", "file"]),
              keyId: z.string(),
              backupAcknowledged: z.boolean(),
              showBackupBanner: z.boolean(),
            }),
            backups: z.object({
              running: z.boolean(),
              schedule: z.string(),
              timezone: z.string(),
            }),
          }),
        },
      },
    },
    async () => {
      const ctx = app.ctx;
      const acknowledged = ctx.settings.getBoolean(SETTING_KEYS.appKeyBackedUp);
      return {
        version: ctx.version,
        revision: ctx.build.revision,
        buildDate: ctx.build.buildDate,
        featureBaseline: ctx.build.featureBaseline,
        appSecret: {
          source: ctx.appKey.source,
          keyId: ctx.aead.kid,
          backupAcknowledged: acknowledged,
          showBackupBanner: ctx.appKey.source === "file" && !acknowledged,
        },
        backups: {
          running: ctx.backups.running,
          schedule: ctx.config.backupSchedule,
          timezone: ctx.config.backupTimezone,
        },
      };
    },
  );

  api.post(
    "/api/v1/system/app-secret/acknowledge",
    { config: owner, schema: { tags: ["system"] } },
    async (_request, reply) => {
      app.ctx.settings.set(SETTING_KEYS.appKeyBackedUp, true);
      return reply.code(204).send();
    },
  );

  api.get(
    "/api/v1/system/backups",
    {
      config: owner,
      schema: {
        tags: ["backup"],
        response: { 200: z.object({ items: z.array(backupItemSchema) }) },
      },
    },
    async () => ({ items: await app.ctx.backups.list() }),
  );

  api.post(
    "/api/v1/system/backups",
    {
      config: owner,
      schema: {
        tags: ["backup"],
        response: { 201: backupItemSchema },
      },
    },
    async (request, reply) => {
      const actor = request.session?.user.email ?? "system";
      const result = await app.ctx.backups.run(actor);
      const manifest = result.manifest;
      const blobBytes = manifest.blobs.reduce((sum, b) => sum + b.size, 0);
      void reply.code(201);
      return {
        id: result.id,
        createdAt: manifest.createdAt,
        sizeBytes: manifest.database.size + blobBytes,
        blobCount: manifest.blobs.length,
        appVersion: manifest.appVersion,
        integrity: "ok" as const,
      };
    },
  );

  api.post(
    "/api/v1/system/backups/:id/drill",
    {
      config: owner,
      schema: {
        tags: ["backup"],
        params: idParams,
        response: {
          200: z.object({
            backupId: z.string(),
            startedAt: z.string(),
            durationMs: z.number(),
            ok: z.boolean(),
            checks: z.array(checkSchema),
          }),
        },
      },
    },
    async (request) => app.ctx.backups.drill(request.params.id),
  );

  api.post(
    "/api/v1/system/backup-export",
    {
      config: owner,
      schema: {
        tags: ["backup"],
        body: z.object({
          passphrase: z.string().min(MIN_PASSPHRASE_LENGTH).max(1024),
        }),
      },
    },
    async (request, reply) => {
      const actor = request.session?.user.email ?? "system";
      const { id, stream } = await app.ctx.backups.export(
        actor,
        request.body.passphrase,
      );
      const name = `dialwarden-${id}.dwbx`;
      void reply.header("content-type", "application/octet-stream");
      void reply.header("content-disposition", `attachment; filename="${name}"`);
      void reply.header("cache-control", "no-store");
      return reply.send(Readable.from(stream));
    },
  );
}
