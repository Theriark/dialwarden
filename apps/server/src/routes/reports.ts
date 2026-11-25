// Change reports (dev-work-plan P9-A step 6, Paid feature reports). GET
// /api/v1/reports/changes answers the report as data with its Markdown text
// and Discord message body; GET /api/v1/reports/changes/print answers the
// same report as an HTML page to print (it has no script and loads nothing).
// Both take the same query: changeSets (a comma list of ids) or a from and
// to time, and optionally servers (a comma list of slugs). Only the servers
// the caller may read are in a report, and secrets stay redacted.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "../http/zod.js";
import {
  reportDiscord,
  reportHtml,
  reportMarkdown,
  type Report,
} from "../reports/service.js";
import { slugList } from "./fleet.js";

const idList = z
  .string()
  .max(20_000)
  .transform((text) => text.split(",").filter((item) => item !== ""))
  .pipe(z.array(z.uuid()).max(500));

const reportQuery = z.object({
  changeSets: idList.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  servers: slugList.optional(),
});

type ReportQuery = z.infer<typeof reportQuery>;

const entrySchema = z.object({
  changeSetId: z.string(),
  at: z.string(),
  author: z.string(),
  cause: z.string(),
  status: z.string(),
  chips: z.array(z.string()),
});

const reportSchema = z.object({
  generatedAt: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  servers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      game: z.string(),
      entries: z.array(entrySchema),
    }),
  ),
  entryCount: z.number().int(),
  truncated: z.boolean(),
  markdown: z.string(),
  discord: z.object({ content: z.string() }),
});

/** Times compared as stored: ISO 8601 in UTC. */
const utc = (value: string | undefined) =>
  value === undefined ? undefined : new Date(value).toISOString();

export function reportRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const config = { auth: "user" as const, entitlement: "reports" as const };

  const build = (request: FastifyRequest, query: ReportQuery): Report => {
    const visible = app.ctx.team.visibleServers(request.principal);
    const selection = {
      changeSets: query.changeSets,
      from: utc(query.from),
      to: utc(query.to),
      servers: query.servers,
    };
    return app.ctx.reports.build(selection, visible);
  };

  api.get(
    "/api/v1/reports/changes",
    {
      config,
      schema: {
        tags: ["reports"],
        querystring: reportQuery,
        response: { 200: reportSchema },
      },
    },
    async (request) => {
      const report = build(request, request.query);
      return {
        ...report,
        markdown: reportMarkdown(report),
        discord: reportDiscord(report),
      };
    },
  );

  api.get(
    "/api/v1/reports/changes/print",
    {
      config,
      schema: {
        tags: ["reports"],
        querystring: reportQuery,
        response: { 200: z.string().describe("text/html print view") },
      },
    },
    async (request, reply) => {
      const report = build(request, request.query);
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(reportHtml(report));
    },
  );
}
