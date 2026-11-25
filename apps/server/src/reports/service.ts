// Change reports (dev-work-plan P9-A step 6, Paid feature reports): the
// history entries of selected change sets, or of a date range, grouped by
// server, as a Markdown text, a Discord message body and an HTML print view.
// Each entry shows its chips as plain text ("Max players: 32 to 20"). Only
// the chips are used, never the text diffs, and a chip of a secret setting
// never shows a value: the stored chip is already masked (contract C5), and
// the report masks again by the pack, so a secret stays redacted even in an
// entry written before a setting was marked secret. Only the servers the
// caller may read are in a report; drafts are not history and never are.
import type { JsonValue, Pack } from "@dialwarden/packs-schema";
import { and, desc, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import type { Chip, Diff } from "../changes/types.js";
import { changeSets } from "../db/schema.js";
import type { Store } from "../db/store.js";
import type { ServerService } from "../servers/service.js";
import { actorLabels } from "../team/labels.js";

/** The most change sets one report holds. */
export const MAX_REPORT_ENTRIES = 500;

/** Discord refuses a message body longer than this. */
export const DISCORD_LIMIT = 2000;

export interface ReportQuery {
  /** These change sets; else every entry in the range. */
  readonly changeSets?: readonly string[] | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Only these servers (still only readable ones). */
  readonly servers?: readonly string[] | undefined;
}

export interface ReportEntry {
  readonly changeSetId: string;
  readonly at: string;
  readonly author: string;
  readonly cause: string;
  readonly status: string;
  /** The chips as text, secrets redacted. */
  readonly chips: string[];
}

export interface ReportServer {
  readonly id: string;
  readonly name: string;
  readonly game: string;
  readonly entries: ReportEntry[];
}

export interface Report {
  readonly generatedAt: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly servers: ReportServer[];
  readonly entryCount: number;
  /** True when more entries matched than MAX_REPORT_ENTRIES. */
  readonly truncated: boolean;
}

/** A value as short readable text. */
function valueText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "nothing";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** One chip as words; a secret chip never carries its values. */
export function chipText(chip: Chip, secret: boolean): string {
  const restart = chip.restartRequired ? " (restart required)" : "";
  const label = chip.label;
  if (secret || chip.kind === "masked") {
    return `${label}: changed (secret, hidden)${restart}`;
  }
  switch (chip.kind) {
    case "added":
      return `${label}: set to ${valueText(chip.to)}${restart}`;
    case "removed":
      return `${label}: removed (was ${valueText(chip.from)})${restart}`;
    case "changed":
      return `${label}: ${valueText(chip.from)} to ${valueText(chip.to)}${restart}`;
    default:
      // lines, external and import: the to says how many lines changed.
      return `${label}: ${valueText(chip.to)}${restart}`;
  }
}

/** "2026-11-25 22:10 UTC" from an ISO time. */
export function timeText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export class ReportService {
  readonly #store: Store;
  readonly #servers: ServerService;
  readonly #packs: ReadonlyMap<string, Pack>;
  readonly #now: () => Date;

  constructor(options: {
    store: Store;
    servers: ServerService;
    packs: ReadonlyMap<string, Pack>;
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#servers = options.servers;
    this.#packs = options.packs;
    this.#now = options.now ?? (() => new Date());
  }

  /** The report data of a selection; secrets are already redacted. */
  build(query: ReportQuery, visible: (serverId: string) => boolean): Report {
    const wanted = query.servers === undefined ? null : new Set(query.servers);
    const servers = this.#servers
      .list()
      .filter((server) => visible(server.id))
      .filter((server) => wanted === null || wanted.has(server.id));
    const ids = servers.map((server) => server.id);
    const at = sql<string>`coalesce(${changeSets.appliedAt}, ${changeSets.updatedAt})`;
    const conditions: SQL[] = [ne(changeSets.status, "draft")];
    if (query.changeSets !== undefined) {
      conditions.push(inArray(changeSets.id, [...query.changeSets]));
    }
    if (query.from !== undefined) conditions.push(gte(at, query.from));
    if (query.to !== undefined) conditions.push(lte(at, query.to));
    // No readable server: an empty report (inArray needs one id at least).
    conditions.push(inArray(changeSets.serverId, ids.length > 0 ? ids : [""]));
    const rows = this.#store.db
      .select()
      .from(changeSets)
      .where(and(...conditions))
      .orderBy(desc(at))
      .limit(MAX_REPORT_ENTRIES + 1)
      .all();
    const kept = rows.slice(0, MAX_REPORT_ENTRIES);
    const labels = actorLabels(
      this.#store,
      kept.map((row) => row.author),
    );
    const out: ReportServer[] = [];
    for (const server of servers) {
      const pack = this.#packs.get(server.packId);
      const secrets = new Set(
        (pack?.settings ?? [])
          .filter((setting) => setting.secret === true)
          .map((setting) => setting.key),
      );
      const entries = kept
        .filter((row) => row.serverId === server.id)
        .map((row) => {
          const diff = JSON.parse(row.diff) as Diff;
          const chips = diff.semantic.map((chip) =>
            chipText(chip, secrets.has(chip.settingKey ?? "")),
          );
          return {
            changeSetId: row.id,
            at: row.appliedAt ?? row.updatedAt,
            author: labels.get(row.author) ?? row.author,
            cause: row.cause,
            status: row.status,
            chips,
          };
        });
      if (entries.length === 0) continue;
      const game = pack?.displayName ?? server.packId;
      out.push({ id: server.id, name: server.name, game, entries });
    }
    return {
      generatedAt: this.#now().toISOString(),
      from: query.from ?? null,
      to: query.to ?? null,
      servers: out,
      entryCount: kept.length,
      truncated: rows.length > MAX_REPORT_ENTRIES,
    };
  }
}

// ---- Renderers ----

/** User text with the characters Markdown and Discord read escaped. */
function md(text: string): string {
  return text.replace(/[\\`*_[\]<>#|~]/g, (found) => `\\${found}`);
}

function summary(report: Report): string {
  const servers = report.servers.length;
  const range =
    report.from === null && report.to === null
      ? ""
      : `, ${report.from ?? "start"} to ${report.to ?? "now"}`;
  const more = report.truncated ? ` (first ${MAX_REPORT_ENTRIES})` : "";
  return `${report.entryCount} change sets${more} on ${servers} servers${range}`;
}

/** The report as Markdown. */
export function reportMarkdown(report: Report): string {
  const lines = [
    "# Dialwarden change report",
    "",
    `Generated ${md(timeText(report.generatedAt))}: ${md(summary(report))}.`,
  ];
  for (const server of report.servers) {
    lines.push("", `## ${md(server.name)} (${md(server.game)})`, "");
    for (const entry of server.entries) {
      const head = `${timeText(entry.at)}, ${entry.cause}, ${entry.status}`;
      lines.push(`- **${md(head)}** by ${md(entry.author)}`);
      for (const chip of entry.chips) lines.push(`  - ${md(chip)}`);
    }
  }
  if (report.servers.length === 0) lines.push("", "No changes.");
  return `${lines.join("\n")}\n`;
}

/**
 * Discord text: its markdown escaped, and every @ broken with a zero-width
 * space, so a value such as @everyone never pings anybody.
 */
function discord(text: string): string {
  return md(text).replace(/@/g, "@​");
}

/** The report as a Discord message body: { content }, at most 2000 long. */
export function reportDiscord(report: Report): { content: string } {
  const lines = [`**Dialwarden change report** (${discord(summary(report))})`];
  // Room is kept for the closing line that counts what did not fit.
  const room = DISCORD_LIMIT - 60;
  let used = lines.join("\n").length;
  let shown = 0;
  const add = (line: string): boolean => {
    if (used + line.length + 1 > room) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };
  for (const server of report.servers) {
    let fitted = add(`**${discord(server.name)}**`);
    for (const entry of server.entries) {
      if (!fitted) break;
      const head = `${timeText(entry.at)}, ${entry.cause}`;
      const line = `- ${discord(head)}: ${discord(entry.chips.join("; "))}`;
      fitted = add(line.length > 300 ? `${line.slice(0, 297)}...` : line);
      if (fitted) shown += 1;
    }
    if (!fitted) break;
  }
  if (shown < report.entryCount) {
    lines.push(`... and ${report.entryCount - shown} more change sets.`);
  }
  if (report.servers.length === 0) lines.push("No changes.");
  return { content: lines.join("\n") };
}

/** Text escaped for HTML content and attribute values. */
function html(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRINT_STYLE = `
body { font: 14px/1.45 system-ui, sans-serif; color: #111; margin: 2rem; }
h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
p.meta { color: #555; margin: 0 0 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 0.35rem 0.5rem; text-align: left;
  vertical-align: top; }
th { background: #f3f3f3; }
ul { margin: 0; padding-left: 1.1rem; }
@media print { body { margin: 0; } h2 { break-after: avoid; }
  tr { break-inside: avoid; } }
`;

/** The report as a standalone HTML page to print; no script, no images. */
export function reportHtml(report: Report): string {
  const parts = [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8">',
    "<title>Dialwarden change report</title>",
    `<style>${PRINT_STYLE}</style></head>`,
    "<body>",
    "<h1>Dialwarden change report</h1>",
    `<p class="meta">Generated ${html(timeText(report.generatedAt))}: ${html(summary(report))}.</p>`,
  ];
  for (const server of report.servers) {
    parts.push(`<h2>${html(server.name)} (${html(server.game)})</h2>`);
    parts.push(
      "<table><thead><tr><th>When</th><th>Cause</th><th>Status</th>",
      "<th>By</th><th>Changes</th></tr></thead><tbody>",
    );
    for (const entry of server.entries) {
      const chips = entry.chips.map((chip) => `<li>${html(chip)}</li>`);
      parts.push(
        `<tr><td>${html(timeText(entry.at))}</td><td>${html(entry.cause)}</td>`,
        `<td>${html(entry.status)}</td><td>${html(entry.author)}</td>`,
        `<td><ul>${chips.join("")}</ul></td></tr>`,
      );
    }
    parts.push("</tbody></table>");
  }
  if (report.servers.length === 0) parts.push("<p>No changes.</p>");
  parts.push("</body>", "</html>");
  return `${parts.join("\n")}\n`;
}
