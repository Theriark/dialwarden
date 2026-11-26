// Notification channels and the in-app notifications (dev-work-plan P9-B,
// Paid feature notifications; every route answers 402 on Free, contract C1,
// while the channels stay stored). Owner and admin configure the channels
// and run the send test; editors and viewers cannot. Every signed-in user
// reads the in-app notifications of the servers they may see. No answer
// carries a webhook URL path, a signing secret or an SMTP password.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACTIVITY_TYPES } from "../activity/service.js";
import type { ZodTypeProvider } from "../http/zod.js";
import { CHANNEL_KINDS } from "../notifications/channels.js";
import { actorOf } from "./changes.js";

// eslint-disable-next-line no-control-regex -- control characters are what is refused
const PRINTABLE = /^[^\x00-\x1f\x7f]*$/;
/** A host name or an IP literal; the service checks the address. */
const HOST = /^[A-Za-z0-9.:[\]-]+$/;

const name = z.string().trim().min(1).max(100).regex(PRINTABLE);
const types = z
  .array(z.enum(ACTIVITY_TYPES))
  .min(1)
  .max(ACTIVITY_TYPES.length)
  .refine((items) => new Set(items).size === items.length, "duplicate type");
const url = z.string().trim().min(1).max(2048).regex(PRINTABLE);
const email = z.string().trim().max(254).pipe(z.email());

const settingsInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("in_app") }),
  z.object({
    kind: z.literal("webhook"),
    url: url.optional(),
    signingSecret: z
      .string()
      .min(16)
      .max(256)
      .regex(PRINTABLE)
      .nullable()
      .optional(),
    allowPrivateHost: z.boolean(),
  }),
  z.object({
    kind: z.literal("discord"),
    url: url.optional(),
    allowPrivateHost: z.boolean(),
  }),
  z.object({
    kind: z.literal("smtp"),
    host: z.string().trim().min(1).max(253).regex(HOST),
    port: z.number().int().min(1).max(65535),
    security: z.enum(["starttls", "tls"]),
    username: z.string().min(1).max(256).regex(PRINTABLE).nullable(),
    password: z.string().min(1).max(256).nullable().optional(),
    from: email,
    to: z.array(email).min(1).max(10),
    allowPrivateHost: z.boolean(),
  }),
]);

const channelInput = z.object({
  name,
  enabled: z.boolean(),
  types,
  settings: settingsInput,
});

const settingsView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("in_app") }),
  z.object({
    kind: z.literal("webhook"),
    url: z.string(),
    host: z.string(),
    hasSigningSecret: z.boolean(),
    allowPrivateHost: z.boolean(),
  }),
  z.object({
    kind: z.literal("discord"),
    url: z.string(),
    host: z.string(),
    allowPrivateHost: z.boolean(),
  }),
  z.object({
    kind: z.literal("smtp"),
    host: z.string(),
    port: z.number().int(),
    security: z.enum(["starttls", "tls"]),
    username: z.string().nullable(),
    hasPassword: z.boolean(),
    from: z.string(),
    to: z.array(z.string()),
    allowPrivateHost: z.boolean(),
  }),
]);

const channelView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(CHANNEL_KINDS),
  enabled: z.boolean(),
  types: z.array(z.enum(ACTIVITY_TYPES)),
  settings: settingsView,
  lastDeliveryAt: z.string().nullable(),
  lastResult: z.enum(["ok", "failed"]).nullable(),
  lastError: z.string().nullable(),
  failures: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const idParams = z.object({ id: z.uuid() });

const inboxItem = z.object({
  id: z.number().int(),
  type: z.union([z.enum(ACTIVITY_TYPES), z.literal("test")]),
  serverId: z.string().nullable(),
  at: z.string(),
  title: z.string(),
  lines: z.array(z.string()),
});

export function notificationRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const feature = { entitlement: "notifications" as const };
  const service = () => app.ctx.channels;

  api.get(
    "/api/v1/notifications/channels",
    {
      config: { auth: "admin", ...feature },
      schema: {
        tags: ["notifications"],
        response: { 200: z.object({ items: z.array(channelView) }) },
      },
    },
    async () => ({ items: service().list() }),
  );

  api.post(
    "/api/v1/notifications/channels",
    {
      config: { auth: "admin", ...feature },
      schema: {
        tags: ["notifications"],
        body: channelInput,
        response: { 201: channelView },
      },
    },
    async (request, reply) => {
      const made = service().create(request.body, actorOf(request));
      return reply.code(201).send(made);
    },
  );

  api.get(
    "/api/v1/notifications/channels/:id",
    {
      config: { auth: "admin", ...feature },
      schema: {
        tags: ["notifications"],
        params: idParams,
        response: { 200: channelView },
      },
    },
    async (request) => service().get(request.params.id),
  );

  api.put(
    "/api/v1/notifications/channels/:id",
    {
      config: { auth: "admin", ...feature },
      schema: {
        tags: ["notifications"],
        params: idParams,
        body: channelInput,
        response: { 200: channelView },
      },
    },
    async (request) => service().update(request.params.id, request.body),
  );

  api.delete(
    "/api/v1/notifications/channels/:id",
    {
      config: { auth: "admin", ...feature },
      schema: { tags: ["notifications"], params: idParams },
    },
    async (request, reply) => {
      service().remove(request.params.id);
      return reply.code(204).send();
    },
  );

  api.post(
    "/api/v1/notifications/channels/:id/test",
    {
      config: { auth: "admin", ...feature },
      schema: {
        tags: ["notifications"],
        params: idParams,
        response: {
          200: z.object({ ok: z.boolean(), error: z.string().nullable() }),
        },
      },
    },
    async (request) => service().test(request.params.id),
  );

  api.get(
    "/api/v1/notifications",
    {
      config: { auth: "user", ...feature },
      schema: {
        tags: ["notifications"],
        querystring: z.object({
          before: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: {
          200: z.object({
            items: z.array(inboxItem),
            unread: z.number().int(),
            nextBefore: z.number().int().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const principal = request.principal;
      if (principal === null) return { items: [], unread: 0, nextBefore: null };
      const visible = app.ctx.team.visibleServers(principal);
      return service().inbox(principal, visible, request.query);
    },
  );

  api.post(
    "/api/v1/notifications/read",
    {
      config: { auth: "user", ...feature },
      schema: {
        tags: ["notifications"],
        body: z.object({ upTo: z.number().int().min(0) }),
        response: { 200: z.object({ unread: z.number().int() }) },
      },
    },
    async (request) => {
      const principal = request.principal;
      if (principal === null) return { unread: 0 };
      const visible = app.ctx.team.visibleServers(principal);
      return service().markRead(principal, visible, request.body.upTo);
    },
  );
}
