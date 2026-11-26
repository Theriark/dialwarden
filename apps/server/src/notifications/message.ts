// What a notification says (P9-B): one plain-text message per C6 activity
// row, used by every channel. The title names what happened and where; the
// lines are the change chips as text (the same words as the change reports
// of P9-A, so a secret setting never shows a value) plus a few known fields
// of the row. Only known scalar fields are read from the row's data, each
// cut to a short length; the rest of the row goes to the webhook body as it
// is (contract C6), never into a text.
import type { Pack } from "@dialwarden/packs-schema";
import type { ActivityEvent, ActivityType } from "../activity/service.js";
import type { Store } from "../db/store.js";
import type { ReportService } from "../reports/service.js";
import { timeText } from "../reports/service.js";
import type { ServerService } from "../servers/service.js";
import { actorLabels } from "../team/labels.js";

/** The most chip lines one message holds; the rest are counted. */
export const MAX_CHIP_LINES = 20;
const FIELD_LIMIT = 100;
// eslint-disable-next-line no-control-regex -- control characters are what is replaced
const CONTROL = /[\x00-\x1f\x7f]+/g;

export interface NotificationMessage {
  /** For example "Change applied on Alpha (Palworld)". */
  readonly title: string;
  /** For example "By Alice, 2026-11-26 03:50 UTC". */
  readonly byline: string;
  /** Chips and details, one plain sentence each. */
  readonly lines: readonly string[];
  readonly server: { id: string; name: string; game: string } | null;
  /** The actor as a label (a name, "system" or "a removed user"). */
  readonly actor: string;
}

const TITLES: Record<ActivityType, string> = {
  "change.applied": "Change applied",
  "change.pending": "Change waiting for the server to stop",
  "change.conflict": "Change conflict",
  "hook.run": "Hook ran",
  "drift.detected": "Outside edit detected",
  "schedule.run": "Scheduled change ran",
  "schedule.reverted": "Scheduled change reverted",
  "backup.done": "App backup done",
  "backup.failed": "App backup failed",
  "licence.changed": "Licence changed",
  "user.changed": "User account changed",
};

/** A short text field of the row's data, or null. */
function field(data: Record<string, unknown>, name: string): string | null {
  const value = new Map(Object.entries(data)).get(name);
  if (typeof value === "string" && value !== "") {
    const flat = value.replace(CONTROL, " ");
    return flat.length > FIELD_LIMIT
      ? `${flat.slice(0, FIELD_LIMIT - 3)}...`
      : flat;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return null;
}

/** "role_changed" as "role changed". */
const words = (text: string): string => text.replace(/[_.]+/g, " ");

function titleOf(event: ActivityEvent): string {
  const data = event.data;
  const base = TITLES[event.type];
  if (event.type === "hook.run") {
    const action = field(data, "action");
    const ok = data["ok"] !== false;
    const what = action === null ? "Hook" : `Hook ${words(action)}`;
    return ok ? `${what} ran` : `${what} failed`;
  }
  if (event.type === "user.changed") {
    const action = field(data, "action");
    return action === null ? base : `User account: ${words(action)}`;
  }
  return base;
}

/** The known details of a row, as sentences. */
function detailsOf(event: ActivityEvent): string[] {
  const data = event.data;
  const out: string[] = [];
  const add = (label: string, name: string) => {
    const value = field(data, name);
    if (value !== null) out.push(`${label}: ${words(value)}`);
  };
  switch (event.type) {
    case "schedule.run":
    case "schedule.reverted":
      add("Result", "result");
      break;
    case "hook.run":
      add("Error", "error");
      break;
    case "drift.detected":
      add("Found by", "via");
      add("Note", "note");
      break;
    case "backup.failed":
      add("Reason", "reason");
      break;
    case "licence.changed":
      add("State", "state");
      add("Plan", "plan");
      break;
    case "user.changed":
      add("Role", "role");
      break;
    default:
      break;
  }
  return out;
}

export interface MessageSources {
  readonly store: Store;
  readonly servers: ServerService;
  readonly packs: ReadonlyMap<string, Pack>;
  readonly reports: ReportService;
}

/** "By Alice, 2026-11-26 03:50 UTC": the actor label and the event time. */
export function bylineOf(actorLabel: string, at: string): string {
  return `By ${actorLabel}, ${timeText(at)}`;
}

/** The message of one C6 row. */
export function messageOf(
  event: ActivityEvent,
  sources: MessageSources,
): NotificationMessage {
  let server: NotificationMessage["server"] = null;
  const lines: string[] = [];
  const changeSetId = event.data["changeSetId"];
  if (event.serverId !== null) {
    const found = sources.servers.get(event.serverId);
    if (found !== null) {
      const game = sources.packs.get(found.packId)?.displayName;
      server = { id: found.id, name: found.name, game: game ?? found.packId };
    }
  }
  if (typeof changeSetId === "string" && changeSetId !== "") {
    const report = sources.reports.build(
      { changeSets: [changeSetId] },
      () => true,
    );
    const first = report.servers[0];
    if (first !== undefined) {
      server = { id: first.id, name: first.name, game: first.game };
      const chips = first.entries.flatMap((entry) => entry.chips);
      lines.push(...chips.slice(0, MAX_CHIP_LINES));
      if (chips.length > MAX_CHIP_LINES) {
        lines.push(`... and ${chips.length - MAX_CHIP_LINES} more changes`);
      }
    }
  }
  lines.push(...detailsOf(event));
  const actor =
    actorLabels(sources.store, [event.actor]).get(event.actor) ?? event.actor;
  const where = server === null ? "" : ` on ${server.name} (${server.game})`;
  return {
    title: `${titleOf(event)}${where}`,
    byline: bylineOf(actor, event.at),
    lines,
    server,
    actor,
  };
}

/** The message as plain text: title, byline, then one line each. */
export function messageText(message: NotificationMessage): string {
  const body = message.lines.map((line) => `- ${line}`);
  return [message.title, message.byline, ...body].join("\n");
}

/** The message a send test delivers (POST .../test). */
export function testMessage(
  channelName: string,
  at: Date,
): NotificationMessage {
  return {
    title: "Test message from Dialwarden",
    byline: `Channel ${channelName}, ${timeText(at.toISOString())}`,
    lines: ["This channel is set up and Dialwarden can reach it."],
    server: null,
    actor: "system",
  };
}
