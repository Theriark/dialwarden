// Connector endpoints (dev-work-plan P4-A, contract C4), used by the
// add-server wizard before a server exists: the instance public key, a
// connection test, the host key confirm and game detection. All are owner
// only, because they reach out to hosts the owner names, and Free: connectors
// are Always Free in contract C1, so no route declares config.entitlement.
// The servers API of P4-B stores the spec per server and opens connectors
// through app.ctx.connectors.
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { detectServer } from "../connectors/detect.js";
import { FINGERPRINT } from "../connectors/host-key.js";
import type { ConfirmResult, ConnectionSpec } from "../connectors/service.js";
import {
  ConnectorError,
  type Connector,
  type ConnectorErrorCode,
} from "../connectors/types.js";
import { ApiError } from "../http/errors.js";
import type { ZodTypeProvider } from "../http/zod.js";

// eslint-disable-next-line no-control-regex -- control characters are what is refused
const PRINTABLE = /^[^\x00-\x1f\x7f]*$/;
const LABEL = /^[A-Za-z0-9-]{1,63}$/;

/** A DNS name or an IPv4 or IPv6 address, without a scheme, port or user. */
export function isHost(value: string): boolean {
  if (isIP(value) !== 0) return true;
  if (value.length > 253) return false;
  return value
    .split(".")
    .every(
      (label) =>
        LABEL.test(label) && !label.startsWith("-") && !label.endsWith("-"),
    );
}

const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isHost, "not a host name or address");
const portSchema = z.number().int().min(1).max(65535);

export const connectionSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    root: z.string().min(1).max(4096).regex(PRINTABLE),
  }),
  z.object({
    kind: z.literal("sftp"),
    host: hostSchema,
    port: portSchema.default(22),
    username: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._][A-Za-z0-9._@+-]*$/, "not a user name"),
    root: z.string().max(4096).regex(PRINTABLE).default(""),
    panel: z.boolean().default(false),
    password: z.string().min(1).max(1024).optional(),
  }),
]);

const hostKeySchema = z.object({
  algorithm: z.string(),
  fingerprint: z.string(),
  status: z.enum(["pinned", "unpinned", "changed"]),
});

export const testSchema = z.object({
  ok: z.boolean(),
  root: z.string().nullable(),
  hostKey: hostKeySchema.optional(),
  error: z
    .enum([
      "PathEscape",
      "HostKeyChanged",
      "HashMismatch",
      "Connection",
      "NotFound",
    ])
    .optional(),
  message: z.string().optional(),
});

const pinnedSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  algorithm: z.string(),
  fingerprint: z.string(),
  confirmedAt: z.string(),
});

export const detectionSchema = z.object({
  packId: z.string(),
  displayName: z.string(),
  by: z.enum(["appmanifest", "markers"]),
  os: z.enum(["linux", "windows"]).nullable(),
  buildId: z.number().int().nullable(),
  buildSupported: z.boolean(),
  warnings: z.array(z.string()),
});

/**
 * A spec the connector factory accepts: a password only for panel SFTP, and
 * panel SFTP only with one (dev-work-plan P4-A step 2). The servers API of
 * P4-B checks its specs the same way.
 */
export function specOf(
  body: z.infer<typeof connectionSpecSchema>,
): ConnectionSpec {
  if (body.kind === "local") return body;
  if (body.panel && body.password === undefined) {
    throw new ApiError(422, "password_required");
  }
  if (!body.panel && body.password !== undefined) {
    throw new ApiError(422, "password_only_for_panel");
  }
  const { password, ...rest } = body;
  return password === undefined ? rest : { ...rest, password };
}

/** The C4 error of a failed connector call as an API error. */
export function connectorFailure(error: unknown): ApiError {
  if (!(error instanceof ConnectorError)) throw error;
  const status: Record<ConnectorErrorCode, number> = {
    PathEscape: 422,
    NotFound: 404,
    HashMismatch: 409,
    HostKeyChanged: 409,
    Connection: 502,
  };
  // eslint-disable-next-line security/detect-object-injection -- typed ConnectorErrorCode
  return new ApiError(status[error.code], "connector_error", {
    code: error.code,
    message: error.message,
  });
}

export function connectorRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const owner = { auth: "owner" as const };

  api.get(
    "/api/v1/connectors/ssh-key",
    {
      config: owner,
      schema: {
        tags: ["connectors"],
        response: {
          200: z.object({
            algorithm: z.string(),
            publicKey: z.string(),
            fingerprint: z.string(),
            createdAt: z.string(),
          }),
        },
      },
    },
    async () => app.ctx.connectors.key.publicKey(),
  );

  api.post(
    "/api/v1/connectors/test",
    {
      config: owner,
      schema: {
        tags: ["connectors"],
        body: connectionSpecSchema,
        response: { 200: testSchema },
      },
    },
    async (request) => {
      const spec = specOf(request.body);
      let connector: Connector;
      try {
        connector = app.ctx.connectors.open(spec);
      } catch (error) {
        throw connectorFailure(error);
      }
      try {
        return await connector.test();
      } finally {
        await connector.close();
      }
    },
  );

  api.post(
    "/api/v1/connectors/host-keys",
    {
      config: owner,
      schema: {
        tags: ["connectors"],
        body: z.object({
          host: hostSchema,
          port: portSchema.default(22),
          fingerprint: z
            .string()
            .regex(FINGERPRINT, "not a SHA256 fingerprint"),
          replace: z.boolean().default(false),
        }),
        response: { 200: pinnedSchema },
      },
    },
    async (request) => {
      const { host, port, fingerprint, replace } = request.body;
      const by = request.principal?.userId ?? null;
      let result: ConfirmResult;
      try {
        result = await app.ctx.connectors.confirmHostKey(
          host,
          port,
          fingerprint,
          by,
          replace,
        );
      } catch (error) {
        throw connectorFailure(error);
      }
      if (!result.ok) {
        throw new ApiError(409, `host_key_${result.reason}`, {
          presented: result.presented,
        });
      }
      request.log.info(
        { host, port, fingerprint: result.pinned.fingerprint },
        "host key confirmed",
      );
      const { pinned } = result;
      return {
        host: pinned.host,
        port: pinned.port,
        algorithm: pinned.algorithm,
        fingerprint: pinned.fingerprint,
        confirmedAt: pinned.confirmedAt,
      };
    },
  );

  api.post(
    "/api/v1/connectors/detect",
    {
      config: owner,
      schema: {
        tags: ["connectors"],
        body: connectionSpecSchema,
        response: { 200: z.object({ items: z.array(detectionSchema) }) },
      },
    },
    async (request) => {
      const spec = specOf(request.body);
      let connector: Connector;
      try {
        connector = app.ctx.connectors.open(spec);
      } catch (error) {
        throw connectorFailure(error);
      }
      try {
        const found = await detectServer(app.ctx.packs.values(), connector);
        const items = found.map((detection) => ({
          ...detection,
          warnings: [...detection.warnings],
          displayName:
            app.ctx.packs.get(detection.packId)?.displayName ??
            detection.packId,
        }));
        return { items };
      } catch (error) {
        throw connectorFailure(error);
      } finally {
        await connector.close();
      }
    },
  );
}
