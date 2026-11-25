// The audit log table (dev-work-plan P8-B screen 3): sticky header, two
// densities, the action of every row in words with the route pattern kept
// in monospace, the actor with its erased state, the target and the
// server, and the client address when the IP setting keeps one. Below
// 1024 px every row is a stacked card so nothing scrolls sideways.
import { Link } from "@tanstack/react-router";
import { UserRoundX } from "lucide-react";
import type { AuditEntry } from "../api/schema";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { Badge, type BadgeKind } from "./ui/badge";

export type Density = "comfortable" | "compact";

export const DENSITY_KEY = "dw.audit.density";

interface ActionWords {
  readonly word: string;
  readonly kind: BadgeKind;
}

/** The route patterns of the server's state-changing requests, in words. */
const ACTION_WORDS: readonly [RegExp, ActionWords][] = [
  [/^POST \/api\/v1\/auth\/login$/, { word: "Sign-in", kind: "info" }],
  [
    /^POST \/api\/v1\/auth\/login\/totp$/,
    { word: "Second step", kind: "info" },
  ],
  [/^POST \/api\/v1\/auth\/logout$/, { word: "Sign-out", kind: "neutral" }],
  [
    /^POST \/api\/v1\/auth\/password$/,
    { word: "Password changed", kind: "info" },
  ],
  [
    /^PATCH \/api\/v1\/auth\/profile$/,
    { word: "Profile saved", kind: "neutral" },
  ],
  [/^POST \/api\/v1\/auth\/totp\//, { word: "Two-factor", kind: "info" }],
  [
    /^POST \/api\/v1\/auth\/password-reset$/,
    { word: "Password reset", kind: "info" },
  ],
  [
    /^GET \/api\/v1\/auth\/oidc\/callback$/,
    { word: "SSO sign-in", kind: "info" },
  ],
  [/^POST \/api\/v1\/setup$/, { word: "Owner created", kind: "success" }],
  [
    /^POST \/api\/v1\/invitations\/accept$/,
    { word: "Invitation accepted", kind: "success" },
  ],
  [
    /^POST \/api\/v1\/invitations$/,
    { word: "Invitation made", kind: "success" },
  ],
  [
    /^DELETE \/api\/v1\/invitations\//,
    { word: "Invitation revoked", kind: "warning" },
  ],
  [
    /^PUT \/api\/v1\/users\/:id\/role$/,
    { word: "Role changed", kind: "warning" },
  ],
  [
    /^PUT \/api\/v1\/users\/:id\/grants$/,
    { word: "Grants changed", kind: "warning" },
  ],
  [/^DELETE \/api\/v1\/users\//, { word: "User deleted", kind: "error" }],
  [
    /^POST \/api\/v1\/users\/:id\/anonymise$/,
    { word: "User anonymised", kind: "error" },
  ],
  [
    /^POST \/api\/v1\/users\/:id\/password-reset$/,
    { word: "Reset link made", kind: "warning" },
  ],
  [/^POST \/api\/v1\/tokens$/, { word: "Token made", kind: "success" }],
  [/^DELETE \/api\/v1\/tokens\//, { word: "Token revoked", kind: "warning" }],
  [
    /^PUT \/api\/v1\/settings\/oidc$/,
    { word: "SSO settings", kind: "warning" },
  ],
  [
    /^PUT \/api\/v1\/settings\/audit$/,
    { word: "Audit settings", kind: "warning" },
  ],
  [
    /^PUT \/api\/v1\/settings\/snapshots$/,
    { word: "Retention settings", kind: "warning" },
  ],
  [/^PUT \/api\/v1\/licence/, { word: "Licence", kind: "info" }],
  [/^DELETE \/api\/v1\/licence$/, { word: "Licence removed", kind: "warning" }],
  [/^PUT \/api\/v1\/plan\//, { word: "Plan choice", kind: "neutral" }],
  [
    /^POST \/api\/v1\/servers\/:slug\/change-sets$/,
    { word: "Change drafted", kind: "neutral" },
  ],
  [
    /^POST \/api\/v1\/change-sets\/:id\/apply$/,
    { word: "Change applied", kind: "success" },
  ],
  [
    /^POST \/api\/v1\/change-sets\/:id\/restore$/,
    { word: "Version restored", kind: "info" },
  ],
  [
    /^POST \/api\/v1\/servers\/:slug\/restore/,
    { word: "Version restored", kind: "info" },
  ],
  [
    /^POST \/api\/v1\/servers\/:slug\/hooks\/run$/,
    { word: "Hook ran", kind: "info" },
  ],
  [
    /^PUT \/api\/v1\/servers\/:slug\/hooks$/,
    { word: "Hook saved", kind: "warning" },
  ],
  [/^POST \/api\/v1\/servers$/, { word: "Server added", kind: "success" }],
  [/^DELETE \/api\/v1\/servers\//, { word: "Server removed", kind: "error" }],
  [
    /^(PUT|PATCH) \/api\/v1\/servers\//,
    { word: "Server changed", kind: "warning" },
  ],
  [
    /^POST \/api\/v1\/presets\/:id\/apply$/,
    { word: "Preset applied", kind: "success" },
  ],
  [/^POST \/api\/v1\/presets$/, { word: "Preset saved", kind: "neutral" }],
  [/^DELETE \/api\/v1\/presets\//, { word: "Preset removed", kind: "warning" }],
  [
    /^POST \/api\/v1\/system\/backups$/,
    { word: "Backup run", kind: "neutral" },
  ],
  [
    /^POST \/api\/v1\/system\/backups\/:id\/drill$/,
    { word: "Restore drill", kind: "neutral" },
  ],
  [
    /^POST \/api\/v1\/system\/backup-export$/,
    { word: "Backup exported", kind: "warning" },
  ],
  [
    /^POST \/api\/v1\/system\/app-secret\//,
    { word: "App secret", kind: "neutral" },
  ],
  [/^POST \/api\/v1\/connectors\//, { word: "Connector", kind: "neutral" }],
];

/** The word and badge of an action; an unknown pattern falls back to it. */
export function describeAction(action: string): ActionWords {
  for (const [pattern, words] of ACTION_WORDS) {
    if (pattern.test(action)) {
      return words;
    }
  }
  const method = action.split(" ").at(0) ?? "";
  return {
    word: method === "DELETE" ? "Removed" : "Request",
    kind: method === "DELETE" ? "error" : "neutral",
  };
}

/** The answer status the row recorded, when the data holds one. */
export function statusOf(entry: AuditEntry): number | null {
  const status = entry.data["status"];
  return typeof status === "number" ? status : null;
}

/** A refused sign-in (401, 403, 410, 429) is an event of its own kind. */
export function isRefusal(entry: AuditEntry): boolean {
  const status = statusOf(entry);
  return status !== null && status >= 400;
}

function targetOf(entry: AuditEntry): string {
  if (entry.targetId === null) {
    return entry.targetType ?? "—";
  }
  const kind = entry.targetType ?? "";
  return kind === "" ? entry.targetId : `${kind} ${entry.targetId}`;
}

function ActorCell({ entry }: { entry: AuditEntry }) {
  if (entry.actor.erased) {
    return (
      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <UserRoundX className="size-4 shrink-0" aria-hidden="true" />
        {entry.actor.label}
      </span>
    );
  }
  return <span className="break-all text-fg">{entry.actor.label}</span>;
}

function ActionCell({ entry }: { entry: AuditEntry }) {
  const words = describeAction(entry.action);
  const refused = isRefusal(entry);
  const status = statusOf(entry);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge kind={refused ? "error" : words.kind}>
          {refused ? "Refused" : words.word}
        </Badge>
        {refused && status !== null ? (
          <span className="text-xs text-fg-muted">
            {words.word}, answered {status}
          </span>
        ) : null}
      </div>
      <code className="font-mono text-xs break-all text-fg-muted">
        {entry.action}
      </code>
    </div>
  );
}

function ServerCell({
  entry,
  serverName,
}: {
  entry: AuditEntry;
  serverName: string | null;
}) {
  if (entry.serverId === null) {
    return <span className="text-fg-muted">—</span>;
  }
  return (
    <Link
      to="/servers/$slug/history"
      params={{ slug: entry.serverId }}
      className="font-medium text-primary hover:underline"
    >
      {serverName ?? entry.serverId}
    </Link>
  );
}

export interface AuditTableProps {
  items: readonly AuditEntry[];
  density: Density;
  /** Server names by id, for the server column. */
  serverNames: ReadonlyMap<string, string>;
  /** True from 1024 px up: the table; below it the stacked rows. */
  wide: boolean;
  /** The id of the first row the verification found broken, if any. */
  brokenAt?: number | null | undefined;
}

const TH =
  "sticky top-0 z-10 border-b border-border-strong bg-surface text-left text-xs font-medium tracking-wide text-fg-muted uppercase";

export function AuditTable({
  items,
  density,
  serverNames,
  wide,
  brokenAt = null,
}: AuditTableProps) {
  const pad = density === "compact" ? "px-3 py-1.5" : "px-4 py-3";
  const nameOf = (entry: AuditEntry) =>
    entry.serverId === null ? null : (serverNames.get(entry.serverId) ?? null);
  const rowClass = (entry: AuditEntry) =>
    brokenAt !== null && entry.id <= brokenAt ? "bg-error-soft/40" : "";

  if (!wide) {
    return (
      <ul
        aria-label="Audit log"
        className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface shadow-card"
      >
        {items.map((entry) => (
          <li
            key={entry.id}
            className={cn("flex flex-col gap-2", pad, rowClass(entry))}
          >
            <div className="flex items-start justify-between gap-3">
              <ActionCell entry={entry} />
              <time
                dateTime={entry.at}
                className="shrink-0 font-mono text-xs whitespace-nowrap text-fg-muted tabular"
              >
                {formatDateTime(entry.at)}
              </time>
            </div>
            <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-fg-muted">
              <div className="flex gap-1">
                <dt>By</dt>
                <dd className="text-fg">
                  <ActorCell entry={entry} />
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>Target</dt>
                <dd className="font-mono text-fg">{targetOf(entry)}</dd>
              </div>
              <div className="flex gap-1">
                <dt>Server</dt>
                <dd>
                  <ServerCell entry={entry} serverName={nameOf(entry)} />
                </dd>
              </div>
              {entry.ip !== null ? (
                <div className="flex gap-1">
                  <dt>From</dt>
                  <dd className="font-mono text-fg">{entry.ip}</dd>
                </div>
              ) : null}
              <div className="flex gap-1">
                <dt>Row</dt>
                <dd className="font-mono text-fg tabular">{entry.id}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table aria-label="Audit log" className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={cn(TH, pad, "w-16")}>
              Row
            </th>
            <th scope="col" className={cn(TH, pad)}>
              When
            </th>
            <th scope="col" className={cn(TH, pad)}>
              Who
            </th>
            <th scope="col" className={cn(TH, pad)}>
              Action
            </th>
            <th scope="col" className={cn(TH, pad)}>
              Target
            </th>
            <th scope="col" className={cn(TH, pad)}>
              Server
            </th>
            <th scope="col" className={cn(TH, pad)}>
              From
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((entry) => {
            const cell = cn("border-b border-border align-top", pad);
            return (
              <tr key={entry.id} className={rowClass(entry)}>
                <td className={cn(cell, "font-mono text-fg-muted tabular")}>
                  {entry.id}
                </td>
                <td className={cn(cell, "font-mono whitespace-nowrap tabular")}>
                  <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                </td>
                <td className={cell}>
                  <ActorCell entry={entry} />
                </td>
                <td className={cell}>
                  <ActionCell entry={entry} />
                </td>
                <td className={cn(cell, "font-mono text-xs text-fg-muted")}>
                  {targetOf(entry)}
                </td>
                <td className={cell}>
                  <ServerCell entry={entry} serverName={nameOf(entry)} />
                </td>
                <td className={cn(cell, "font-mono text-xs text-fg-muted")}>
                  {entry.ip ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
