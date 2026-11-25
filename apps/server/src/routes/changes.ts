// Change sets, restore and the snapshot meter (dev-work-plan P4-B, contract
// C5). Typed and raw edits, diffs, lint, apply and outside-edit detection
// are Always Free in contract C1, so no route declares config.entitlement;
// the services enforce the plan limits instead (the editable three servers
// and the 5 visible history entries on Free answer 402).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CAUSES, CHANGE_SET_STATUSES } from "../changes/types.js";
import { ControlError } from "../control/types.js";
import { controlFailure } from "../control/hooks.js";
import { ApiError } from "../http/errors.js";
import { onChangeSet, onSlug, onSnapshot } from "../http/scope.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";
import { atLeast } from "../team/roles.js";
import { connectorFailure } from "./connectors.js";

const CHIP_KINDS = [
  "changed",
  "added",
  "removed",
  "masked",
  "lines",
  "external",
  "import",
] as const;

export const chipSchema = z.object({
  kind: z.enum(CHIP_KINDS),
  fileId: z.string(),
  settingKey: z.string().nullable(),
  label: z.string(),
  from: z.unknown(),
  to: z.unknown(),
  restartRequired: z.boolean(),
});

export const lintEntrySchema = z.object({
  fileId: z.string().nullable(),
  settingKey: z.string().nullable(),
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  serverEvaluated: z.boolean(),
});

const conflictSettingSchema = z.object({
  settingKey: z.string(),
  label: z.string(),
  base: z.unknown(),
  ours: z.unknown(),
  theirs: z.unknown(),
});

const conflictFileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("settings"),
    fileId: z.string(),
    settings: z.array(conflictSettingSchema),
  }),
  z.object({
    kind: z.literal("text"),
    fileId: z.string(),
    conflicts: z.number().int(),
    ours: z.string(),
    theirs: z.string(),
  }),
]);

export const changeSetSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  status: z.enum(CHANGE_SET_STATUSES),
  cause: z.enum(CAUSES),
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  appliedAt: z.string().nullable(),
  restoreOf: z.string().nullable(),
  diff: z.object({
    semantic: z.array(chipSchema),
    text: z.array(z.object({ fileId: z.string(), unifiedDiff: z.string() })),
  }),
  lint: z.array(lintEntrySchema),
  conflict: z.object({ files: z.array(conflictFileSchema) }).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export const historySchema = z.object({
  entries: z.array(
    z.object({
      changeSetId: z.string(),
      at: z.string(),
      author: z.string(),
      cause: z.enum(CAUSES),
      status: z.enum(CHANGE_SET_STATUSES),
      chips: z.array(chipSchema),
      snapshots: z.array(
        z.object({
          id: z.string(),
          fileId: z.string(),
          kind: z.string(),
          at: z.string(),
        }),
      ),
    }),
  ),
  visibleLimit: z.number().int().nullable(),
  hiddenCount: z.number().int(),
});

const editSchema = z.object({
  settingKey: z.string().min(1).max(200),
  value: z.json(),
});

const patchSchema = z.object({
  fileId: z.string().min(1).max(100),
  /** The whole new text of the file. */
  text: z.string(),
});

const changeBodySchema = z.object({
  edits: z.array(editSchema).max(500).optional(),
  patches: z.array(patchSchema).max(20).optional(),
});

const hooksSchema = z.enum(["none", "restart", "stop-start"]).default("none");
const applyBodySchema = z.object({ runHooks: hooksSchema });

const idParams = z.object({ id: z.uuid() });

const slugParams = z.object({
  slug: z.string().max(63).regex(SERVER_ID, "not a server id"),
});

/** Who acts: the e-mail address of the signed-in user (or token owner). */
export function actorOf(request: FastifyRequest): string {
  return request.principal?.email ?? "system";
}

/**
 * The raw rule of rnd-decision-p8a Q2 (P3 X1 left open): raw text can carry
 * a command into a file the game host reads with a shell, which no typed
 * value check sees. Raw patches to any file are owner and admin only,
 * checked at create and again at apply; a restore into a shell-read file is
 * too. Editors keep typed edits, which pass the X1 value check.
 */
function isAdmin(request: FastifyRequest): boolean {
  const principal = request.principal;
  return principal !== null && atLeast(principal.role, "admin");
}

const rawRequiresAdmin = () => new ApiError(403, "raw_requires_admin");
const shellFileRequiresAdmin = () =>
  new ApiError(403, "shell_file_requires_admin");

export function changeRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const owner = { auth: "owner" as const };

  api.post(
    "/api/v1/servers/:slug/change-sets",
    {
      config: onSlug("write"),
      schema: {
        tags: ["changes"],
        params: slugParams,
        body: changeBodySchema,
        response: { 201: changeSetSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if ((body.patches ?? []).length > 0 && !isAdmin(request)) {
        throw rawRequiresAdmin();
      }
      const server = app.ctx.servers.require(request.params.slug);
      const edits = (body.edits ?? []).map((edit) => ({
        key: edit.settingKey,
        value: edit.value,
      }));
      const patches = body.patches ?? [];
      const input = { edits, patches };
      const actor = actorOf(request);
      try {
        const view = await app.ctx.changes.create(server, input, actor);
        void reply.code(201);
        return view;
      } catch (error) {
        throw connectorFailure(error);
      }
    },
  );

  api.get(
    "/api/v1/change-sets/:id",
    {
      config: onChangeSet("read"),
      schema: {
        tags: ["changes"],
        params: idParams,
        response: { 200: changeSetSchema },
      },
    },
    async (request) => app.ctx.changes.get(request.params.id),
  );

  api.post(
    "/api/v1/change-sets/:id/apply",
    {
      config: onChangeSet("write"),
      schema: {
        tags: ["changes"],
        params: idParams,
        body: applyBodySchema.default({ runHooks: "none" }),
        response: { 200: changeSetSchema },
      },
    },
    async (request) => {
      if (!isAdmin(request)) {
        // A restore keeps its own rule; any other raw patch needs an admin.
        const scope = app.ctx.changes.rawScope(request.params.id);
        if (scope.restore && scope.shellFile) throw shellFileRequiresAdmin();
        if (scope.patches && !scope.restore) throw rawRequiresAdmin();
      }
      const actor = actorOf(request);
      try {
        return await app.ctx.changes.apply(
          request.params.id,
          actor,
          request.body.runHooks,
        );
      } catch (error) {
        // A control failure carries its own code (the apply stops before
        // the write); a connector failure keeps its C4 mapping.
        if (error instanceof ControlError) throw controlFailure(error);
        throw connectorFailure(error);
      }
    },
  );

  api.post(
    "/api/v1/snapshots/:id/restore",
    {
      config: onSnapshot("write"),
      schema: {
        tags: ["changes"],
        params: idParams,
        response: { 200: changeSetSchema },
      },
    },
    async (request) => {
      const id = request.params.id;
      if (!isAdmin(request) && app.ctx.changes.snapshotIsShellFile(id)) {
        throw shellFileRequiresAdmin();
      }
      const actor = actorOf(request);
      try {
        return await app.ctx.changes.restore(id, actor);
      } catch (error) {
        throw connectorFailure(error);
      }
    },
  );

  api.get(
    "/api/v1/system/snapshots",
    {
      config: owner,
      schema: {
        tags: ["system"],
        response: {
          200: z.object({
            usedBytes: z.number().int(),
            capBytes: z.number().int(),
            blobs: z.number().int(),
            overCap: z.boolean(),
          }),
        },
      },
    },
    async () => app.ctx.snapshots.meter(),
  );
}
