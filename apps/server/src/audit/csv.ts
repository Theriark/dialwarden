// The CSV export of the audit log (dev-work-plan P8-A step 3). Every cell is
// double-quoted with inner quotes doubled (RFC 4180), and a cell that a
// spreadsheet would read as a formula (it starts with =, +, -, @, a tab or a
// carriage return) gets a leading single quote, so it stays text.
import type { AuditEntry } from "./service.js";

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (typeof value === "number") text = String(value);
  else if (value !== null && value !== undefined) text = JSON.stringify(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export const CSV_HEADER = [
  "id",
  "at",
  "actor",
  "actor_id",
  "action",
  "target_type",
  "target_id",
  "server_id",
  "ip",
  "data",
] as const;

/** The audit rows as CSV text, header first, CRLF line ends. */
export function auditCsv(entries: readonly AuditEntry[]): string {
  const lines = [CSV_HEADER.map(csvCell).join(",")];
  for (const entry of entries) {
    const cells = [
      entry.id,
      entry.at,
      entry.actor.label,
      entry.actor.id,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.serverId,
      entry.ip,
      entry.data,
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
