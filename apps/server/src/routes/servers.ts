// The servers API (dev-work-plan P4-B step 1): CRUD with slugs as ids, the
// connection test and game detection of a server, its typed settings and raw
// files (every read records outside edits, contract C5) and its history.
// Connectors, editors and outside-edit detection are Always Free in contract
// C1, so no route declares config.entitlement; the plan limits live in the
// services: limit(servers) when a server is added, the editable three on
// Free for every change, and 5 visible history entries on Free (402).
// Adding, changing and removing servers, the connection test and detection
// reach out to hosts the owner names, so they are owner only. Every route on
// one server declares config.server (P8-A): a user without a grant on it
// gets the answer of a missing server, and the list shows only the servers
// the user may see. The raw file read is owner and admin only (D14): the raw
// text shows the values of secret settings that the typed view masks.
// Every server answer says the caller's access to it, read or write (P10-A
// L22, the per-server grant of the moment), so the editor can turn its
// controls off where the server would refuse the write.
import { isPackId, type Detection, type Os } from "@dialwarden/packs-schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { detectServer, serverOs } from "../connectors/detect.js";
import type { ConnectionSpec } from "../connectors/service.js";
import type { Connector } from "../connectors/types.js";
import { ApiError } from "../http/errors.js";
import { onSlug } from "../http/scope.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { SERVER_ID } from "../plan/editable.js";
import type { ServerRecord, ServerService } from "../servers/service.js";
import { serverLevel } from "../team/roles.js";
import {
  actorOf,
  changeSetSchema,
  historySchema,
  lintEntrySchema,
} from "./changes.js";
import {
  connectionSpecSchema,
  connectorFailure,
  detectionSchema,
  specOf,
  testSchema,
} from "./connectors.js";

// eslint-disable-next-line no-control-regex -- control characters are what is refused
const PRINTABLE = /^[^\x00-\x1f\x7f]*$/;

const osSchema = z.enum(["linux", "windows"]);

const slugSchema = z.string().max(63).regex(SERVER_ID, "not a server id");

const slugParams = z.object({ slug: slugSchema });

const nameSchema = z.string().trim().min(1).max(80).regex(PRINTABLE);

const storedSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), root: z.string() }),
  z.object({
    kind: z.literal("sftp"),
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    root: z.string(),
    panel: z.boolean(),
  }),
]);

const accessSchema = z.enum(["read", "write"]);

const serverSchema = z.object({
  id: z.string(),
  name: z.string(),
  packId: z.string(),
  displayName: z.string(),
  os: osSchema,
  connector: storedSpecSchema,
  hasPassword: z.boolean(),
  demo: z.boolean(),
  /** False for a server beyond the editable three on Free (read-only). */
  editable: z.boolean(),
  /** What the caller may do on it: read, or write (P10-A L22). */
  access: accessSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastEditedAt: z.string().nullable(),
});

const createSchema = z.object({
  /** The slug; made from the name when left out. */
  id: slugSchema.optional(),
  name: nameSchema,
  /** The game pack; detected when left out. */
  packId: z.string().max(40).refine(isPackId, "not a game pack id").optional(),
  os: osSchema.optional(),
  connector: connectionSpecSchema,
});

const updateSchema = z.object({
  name: nameSchema.optional(),
  connector: connectionSpecSchema.optional(),
});

const settingsSchema = z.object({
  serverId: z.string(),
  packId: z.string(),
  packVersion: z.string(),
  editable: z.boolean(),
  access: accessSchema,
  files: z.array(
    z.object({
      fileId: z.string(),
      path: z.string(),
      exists: z.boolean(),
      sha256: z.string().nullable(),
    }),
  ),
  values: z.record(z.string(), z.unknown()),
  lint: z.array(lintEntrySchema),
});

const rawFileSchema = z.object({
  fileId: z.string(),
  path: z.string(),
  exists: z.boolean(),
  sha256: z.string().nullable(),
  text: z.string(),
  lint: z.array(lintEntrySchema),
});

/** A slug from a name: lower case letters, digits and single dashes. */
export function slugFrom(name: string): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slug = words.join("-").slice(0, 56).replace(/-$/, "");
  return slug === "" ? "server" : slug;
}

/** The slug of a name, with -2, -3 and so on when it is taken. */
function freeSlug(servers: ServerService, name: string): string {
  const base = slugFrom(name);
  let candidate = base;
  for (let n = 2; servers.exists(candidate); n += 1) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

interface Inspected {
  readonly packId: string;
  readonly os: Os;
}

/**
 * Connects, then finds the game and operating system of a server folder: the
 * given pack, else the one pack whose detection rules match.
 */
async function inspect(
  app: FastifyInstance,
  connector: Connector,
  packId: string | undefined,
  os: Os | undefined,
): Promise<Inspected> {
  const test = await connector.test();
  if (!test.ok) {
    throw new ApiError(422, "connection_failed", {
      code: test.error ?? "Connection",
      message: test.message ?? "",
      ...(test.hostKey === undefined ? {} : { hostKey: test.hostKey }),
    });
  }
  const found = await detectServer(app.ctx.packs.values(), connector);
  if (packId === undefined && found.length > 1) {
    const packIds = found.map((detection) => detection.packId);
    throw new ApiError(422, "game_ambiguous", { packIds });
  }
  const wanted = (item: Detection) => item.packId === (packId ?? item.packId);
  const detection = found.find(wanted);
  const id = packId ?? detection?.packId;
  if (id === undefined) throw new ApiError(422, "game_not_detected");
  const pack = app.ctx.packs.get(id);
  if (pack === undefined) throw new ApiError(422, "unknown_game", { id });
  let chosen = os ?? null;
  if (chosen === null && detection !== undefined) {
    chosen = await serverOs(pack, detection, connector);
  }
  chosen ??= pack.os.at(0) ?? "linux";
  if (!pack.os.includes(chosen)) {
    throw new ApiError(422, "unsupported_os", { os: chosen });
  }
  return { packId: id, os: chosen };
}

/** Runs a task on a connector for a spec and closes it after. */
async function withSpec<T>(
  app: FastifyInstance,
  spec: ConnectionSpec,
  task: (connector: Connector) => Promise<T>,
): Promise<T> {
  let connector: Connector;
  try {
    connector = app.ctx.connectors.open(spec);
  } catch (error) {
    throw connectorFailure(error);
  }
  try {
    return await task(connector);
  } catch (error) {
    throw connectorFailure(error);
  } finally {
    await connector.close();
  }
}

export function serverRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const owner = { auth: "owner" as const };
  const user = { auth: "user" as const };
  const servers = () => app.ctx.servers;

  /** The caller's access to a server; read when nothing grants a write. */
  const accessOf = (
    request: FastifyRequest,
    serverId: string,
  ): "read" | "write" => {
    const principal = request.principal;
    if (principal === null) return "read";
    const grant = app.ctx.team.grantLevel(principal.userId, serverId);
    return serverLevel(principal, grant) === "write" ? "write" : "read";
  };

  const view = (request: FastifyRequest, server: ServerRecord) => {
    const pack = app.ctx.packs.get(server.packId);
    const displayName = pack?.displayName ?? server.packId;
    const editable = servers().isEditable(server.id);
    const access = accessOf(request, server.id);
    return { ...server, displayName, editable, access };
  };

  api.get(
    "/api/v1/servers",
    {
      config: user,
      schema: {
        tags: ["servers"],
        response: { 200: z.object({ items: z.array(serverSchema) }) },
      },
    },
    async (request) => {
      const visible = app.ctx.team.visibleServers(request.principal);
      const all = servers().list();
      const items = all.filter((server) => visible(server.id));
      return { items: items.map((server) => view(request, server)) };
    },
  );

  api.post(
    "/api/v1/servers",
    {
      config: owner,
      schema: {
        tags: ["servers"],
        body: createSchema,
        response: { 201: serverSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      servers().assertCanAdd();
      const spec = specOf(body.connector);
      const id = body.id ?? freeSlug(servers(), body.name);
      if (servers().exists(id)) {
        throw new ApiError(409, "server_exists", { id });
      }
      const found = await withSpec(app, spec, (connector) =>
        inspect(app, connector, body.packId, body.os),
      );
      // Checked again with no await before the insert: another add may have
      // finished while this one tested its connection (C1 limit(servers)).
      servers().assertCanAdd();
      const server = servers().insert({ id, name: body.name, spec, ...found });
      try {
        await app.ctx.changes.importServer(server, actorOf(request));
      } catch (error) {
        servers().remove(id);
        throw connectorFailure(error);
      }
      request.log.info({ server: id, packId: found.packId }, "server added");
      void reply.code(201);
      return view(request, servers().require(id));
    },
  );

  api.get(
    "/api/v1/servers/:slug",
    {
      config: onSlug("read"),
      schema: {
        tags: ["servers"],
        params: slugParams,
        response: { 200: serverSchema },
      },
    },
    async (request) => view(request, servers().require(request.params.slug)),
  );

  api.patch(
    "/api/v1/servers/:slug",
    {
      config: onSlug("owner"),
      schema: {
        tags: ["servers"],
        params: slugParams,
        body: updateSchema,
        response: { 200: serverSchema },
      },
    },
    async (request) => {
      const server = servers().require(request.params.slug);
      servers().assertEditable(server.id);
      const { name, connector } = request.body;
      if (connector === undefined) {
        return view(request, servers().update(server.id, name ? { name } : {}));
      }
      const spec = specOf(connector);
      await withSpec(app, spec, async (opened) => {
        const test = await opened.test();
        if (!test.ok) {
          throw new ApiError(422, "connection_failed", {
            code: test.error ?? "Connection",
            message: test.message ?? "",
          });
        }
      });
      const change = name ? { name, spec } : { spec };
      return view(request, servers().update(server.id, change));
    },
  );

  api.delete(
    "/api/v1/servers/:slug",
    {
      config: onSlug("owner"),
      schema: { tags: ["servers"], params: slugParams },
    },
    async (request, reply) => {
      servers().remove(request.params.slug);
      request.log.info({ server: request.params.slug }, "server removed");
      return reply.code(204).send();
    },
  );

  api.post(
    "/api/v1/servers/:slug/test",
    {
      config: onSlug("owner"),
      schema: {
        tags: ["servers"],
        params: slugParams,
        response: { 200: testSchema },
      },
    },
    async (request) => {
      const server = servers().require(request.params.slug);
      const spec = servers().specOf(server);
      return withSpec(app, spec, (connector) => connector.test());
    },
  );

  api.post(
    "/api/v1/servers/:slug/detect",
    {
      config: onSlug("owner"),
      schema: {
        tags: ["servers"],
        params: slugParams,
        response: { 200: z.object({ items: z.array(detectionSchema) }) },
      },
    },
    async (request) => {
      const server = servers().require(request.params.slug);
      const spec = servers().specOf(server);
      const packs = app.ctx.packs;
      const found = await withSpec(app, spec, (connector) =>
        detectServer(packs.values(), connector),
      );
      const items = found.map((detection) => ({
        ...detection,
        warnings: [...detection.warnings],
        displayName: packs.get(detection.packId)?.displayName ?? "",
      }));
      return { items };
    },
  );

  api.get(
    "/api/v1/servers/:slug/settings",
    {
      config: onSlug("read"),
      schema: {
        tags: ["servers"],
        params: slugParams,
        response: { 200: settingsSchema },
      },
    },
    async (request) => {
      const server = servers().require(request.params.slug);
      try {
        const settings = await app.ctx.changes.settings(server);
        const editable = servers().isEditable(server.id);
        const access = accessOf(request, server.id);
        return { serverId: server.id, editable, access, ...settings };
      } catch (error) {
        throw connectorFailure(error);
      }
    },
  );

  api.get(
    "/api/v1/servers/:slug/files/:fileId",
    {
      config: onSlug("admin"),
      schema: {
        tags: ["servers"],
        params: slugParams.extend({ fileId: z.string().min(1).max(100) }),
        response: { 200: rawFileSchema },
      },
    },
    async (request) => {
      const server = servers().require(request.params.slug);
      try {
        return await app.ctx.changes.rawFile(server, request.params.fileId);
      } catch (error) {
        throw connectorFailure(error);
      }
    },
  );

  api.get(
    "/api/v1/servers/:slug/history",
    {
      config: onSlug("read"),
      schema: {
        tags: ["servers"],
        params: slugParams,
        response: { 200: historySchema },
      },
    },
    async (request) => {
      const server = servers().require(request.params.slug);
      return app.ctx.changes.history(server);
    },
  );

  api.get(
    "/api/v1/servers/:slug/pending",
    {
      config: onSlug("read"),
      schema: {
        tags: ["servers"],
        params: slugParams,
        response: { 200: z.object({ items: z.array(changeSetSchema) }) },
      },
    },
    async (request) => {
      // The pending change sets of a server (P6-B, contract C5), oldest
      // first: the pending badge and list read them, whatever the Free
      // history cap hides.
      const server = servers().require(request.params.slug);
      return { items: app.ctx.changes.pending(server) };
    },
  );
}
