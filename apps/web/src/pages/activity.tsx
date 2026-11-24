// The Activity page (dev-work-plan P6-C, Small additions): everything that
// happened across the fleet, from the events of contract C6 on the paged
// GET /api/v1/activity. Tabs narrow the feed to applies, failures, pending
// and scheduled items and backups; the list grows page by page with the
// server's nextBefore cursor, grouped by day.
/* eslint-disable security/detect-object-injection -- the keys are the event words of the server's own JSON answer looked up in constant word tables, never free-form input */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  CalendarClock,
  CircleCheck,
  CircleX,
  Clock,
  DatabaseBackup,
  FileWarning,
  KeyRound,
  Plug,
  Plus,
  Undo2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { fetchActivityPage, p6keys, serversQuery } from "../api/queries";
import type { ActivityEvent, ActivityType } from "../api/schema";
import { useIsOwner } from "../api/session";
import { PageHeader } from "../components/layout/page-header";
import { Badge, type BadgeKind } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { Tabs } from "../components/ui/tabs";
import { formatBytes, formatDateTime } from "../lib/format";
import { cn } from "../lib/cn";

export const PAGE_SIZE = 20;

export type ActivityTab =
  "all" | "applies" | "failures" | "pending" | "scheduled" | "backups";

const TAB_ITEMS: readonly { id: ActivityTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "applies", label: "Applies" },
  { id: "failures", label: "Failures" },
  { id: "pending", label: "Pending" },
  { id: "scheduled", label: "Scheduled" },
  { id: "backups", label: "Backups" },
];

/**
 * The server-side type filter of a tab; null asks for every type. Failures
 * span three types the API filters one at a time, so that tab narrows the
 * loaded events in the browser instead.
 */
export function typeOfTab(tab: ActivityTab): ActivityType | null {
  switch (tab) {
    case "applies":
      return "change.applied";
    case "pending":
      return "change.pending";
    case "scheduled":
      return "schedule.run";
    case "backups":
      return "backup.done";
    default:
      return null;
  }
}

export function isFailure(event: ActivityEvent): boolean {
  if (event.type === "change.conflict" || event.type === "backup.failed") {
    return true;
  }
  return event.type === "hook.run" && event.data["ok"] === false;
}

function isTab(value: string): value is ActivityTab {
  return TAB_ITEMS.some((item) => item.id === value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const CAUSE_WORDS: Readonly<Record<string, string>> = {
  app: "Change applied",
  external: "Outside edit recorded",
  rollback: "Version restored",
  schedule: "Scheduled change applied",
  preset: "Preset applied",
  import: "First import",
};

const RUN_HOOKS_WORDS: Readonly<Record<string, string>> = {
  none: "written at the next stop",
  restart: "restart after the write",
  "stop-start": "stop, write and start",
};

/** The icon, badge and sentence of one event. */
export function describeEvent(event: ActivityEvent): {
  icon: LucideIcon;
  kind: BadgeKind;
  word: string;
  sentence: string;
} {
  const data = event.data;
  switch (event.type) {
    case "change.applied":
      return {
        icon: CircleCheck,
        kind: "success",
        word: "Applied",
        sentence: CAUSE_WORDS[text(data["cause"])] ?? "Change applied",
      };
    case "change.pending": {
      const mode = RUN_HOOKS_WORDS[text(data["runHooks"])];
      return {
        icon: Clock,
        kind: "pending",
        word: "Pending",
        sentence: `Change saved as pending${mode === undefined ? "" : ` (${mode})`}`,
      };
    }
    case "change.conflict":
      return {
        icon: CircleX,
        kind: "error",
        word: "Conflict",
        sentence:
          "A save ended in a conflict: the file changed outside Dialwarden",
      };
    case "hook.run": {
      const action = text(data["action"]);
      const source = text(data["source"]);
      if (data["ok"] === false) {
        return {
          icon: CircleX,
          kind: "error",
          word: "Hook failed",
          sentence: `The ${action} hook failed (${source}): ${text(data["error"]) || "error"}`,
        };
      }
      return {
        icon: Plug,
        kind: "info",
        word: "Hook ran",
        sentence:
          data["liveReload"] === true
            ? `The ${action} hook reloaded the settings live (${source})`
            : `The ${action} hook ran (${source})`,
      };
    }
    case "drift.detected": {
      const files = Array.isArray(data["files"])
        ? data["files"].map(String).join(", ")
        : "";
      return {
        icon: FileWarning,
        kind: "warning",
        word: "Drift",
        sentence: `Files changed outside Dialwarden${files === "" ? "" : `: ${files}`}`,
      };
    }
    case "schedule.run":
      return {
        icon: CalendarClock,
        kind: "info",
        word: "Scheduled",
        sentence: "A scheduled change ran",
      };
    case "schedule.reverted":
      return {
        icon: Undo2,
        kind: "info",
        word: "Reverted",
        sentence: "A scheduled change was reverted",
      };
    case "backup.done": {
      const size = data["sizeBytes"];
      const pruned = data["pruned"];
      return {
        icon: DatabaseBackup,
        kind: "success",
        word: "Backup",
        sentence: `Backup done${typeof size === "number" ? `, ${formatBytes(size)}` : ""}${
          typeof pruned === "number" && pruned > 0
            ? `, ${pruned} older ${pruned === 1 ? "copy" : "copies"} pruned`
            : ""
        }`,
      };
    }
    case "backup.failed":
      return {
        icon: CircleX,
        kind: "error",
        word: "Backup failed",
        sentence: `Backup failed: ${text(data["reason"]) || "see the server log"}`,
      };
    case "licence.changed": {
      const action = text(data["action"]);
      const plan = text(data["plan"]);
      const words: Readonly<Record<string, string>> = {
        set: "A licence key was entered",
        removed: "The licence key was removed",
        environment_ignored: "The environment licence is ignored",
        environment_used: "The environment licence is in use",
      };
      return {
        icon: KeyRound,
        kind: "info",
        word: "Licence",
        sentence: `${words[action] ?? "The licence changed"}${plan === "" ? "" : ` (${plan} plan)`}`,
      };
    }
    default: {
      const action = text(data["action"]);
      const words: Readonly<Record<string, string>> = {
        created: "A user account was created",
        password_changed: "A password was changed",
        totp_enabled: "Two-factor sign-in was turned on",
        totp_disabled: "Two-factor sign-in was turned off",
      };
      return {
        icon: UserRound,
        kind: "neutral",
        word: "User",
        sentence: words[action] ?? "A user account changed",
      };
    }
  }
}

const dayLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon",
  dateStyle: "full",
});

function dayOf(at: string): string {
  const time = Date.parse(at);
  return Number.isNaN(time) ? at : dayLabel.format(new Date(time));
}

export function EventRow({
  event,
  serverName,
}: {
  event: ActivityEvent;
  serverName: string | null;
}) {
  const { icon: Icon, kind, word, sentence } = describeEvent(event);
  return (
    <li className="flex gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
          kind === "error"
            ? "border-error/40 bg-error-soft text-error"
            : kind === "warning"
              ? "border-warning/40 bg-warning-soft text-warning"
              : kind === "pending"
                ? "border-pending/40 bg-pending-soft text-pending"
                : kind === "success"
                  ? "border-success/40 bg-success-soft text-success"
                  : kind === "info"
                    ? "border-info/40 bg-info-soft text-info"
                    : "border-border-strong bg-surface text-neutral",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge kind={kind}>{word}</Badge>
          <span className="text-sm text-fg">{sentence}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted">
          <time dateTime={event.at}>{formatDateTime(event.at)}</time>
          <span>
            by {event.actor === "system" ? "Dialwarden" : event.actor}
          </span>
          {event.serverId !== null ? (
            <Link
              to="/servers/$slug/history"
              params={{ slug: event.serverId }}
              className="font-medium text-primary hover:underline"
            >
              {serverName ?? event.serverId}
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function ActivityPage() {
  const [tab, setTab] = useState<ActivityTab>("all");
  const isOwner = useIsOwner();
  const servers = useQuery(serversQuery());
  const type = typeOfTab(tab);
  const feed = useInfiniteQuery({
    queryKey: p6keys.activity(type),
    queryFn: ({ pageParam }) =>
      fetchActivityPage({ type, before: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    staleTime: 10_000,
  });

  const names = new Map(
    (servers.data?.items ?? []).map((server) => [server.id, server.name]),
  );
  const loaded = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const events = tab === "failures" ? loaded.filter(isFailure) : loaded;
  const fleetEmpty =
    servers.data !== undefined && servers.data.items.length === 0;

  const days: { day: string; events: ActivityEvent[] }[] = [];
  for (const event of events) {
    const day = dayOf(event.at);
    const last = days.at(-1);
    if (last !== undefined && last.day === day) {
      last.events.push(event);
    } else {
      days.push({ day, events: [event] });
    }
  }

  let body: React.ReactNode;
  if (feed.isPending) {
    body = <RowsSkeleton rows={6} />;
  } else if (feed.isError && loaded.length === 0) {
    body = (
      <ErrorState
        message="The activity could not be loaded."
        onRetry={() => {
          void feed.refetch();
        }}
        retrying={feed.isFetching}
      />
    );
  } else if (events.length === 0 && !feed.hasNextPage) {
    body = (
      <EmptyState
        icon={<Activity className="size-6" aria-hidden="true" />}
        title={tab === "all" ? "Nothing has happened yet" : "Nothing here yet"}
        description={
          tab === "all"
            ? "Saves, hook runs, pending changes and backups appear here as they happen."
            : tab === "failures"
              ? "No failed save, hook run or backup among the loaded events."
              : "No event of this kind has been recorded yet."
        }
        action={
          tab === "all" && fleetEmpty && isOwner ? (
            <Link
              to="/servers/new"
              className="inline-flex h-10 items-center gap-2 rounded-control border border-transparent bg-primary px-4 text-base font-medium text-primary-fg transition-colors duration-150 hover:opacity-90"
            >
              <Plus className="size-4" aria-hidden="true" />
              Add server
            </Link>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {feed.isError ? (
          <ErrorState
            message="The next page could not be loaded."
            onRetry={() => {
              void feed.fetchNextPage();
            }}
            retrying={feed.isFetchingNextPage}
          />
        ) : null}
        {days.map((group) => (
          <section key={group.day} className="flex flex-col gap-2">
            <h2 className="sticky top-14 z-10 bg-bg py-1 text-xs font-medium tracking-wide text-fg-muted uppercase">
              {group.day}
            </h2>
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface shadow-card">
              {group.events.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  serverName={
                    event.serverId === null
                      ? null
                      : (names.get(event.serverId) ?? null)
                  }
                />
              ))}
            </ul>
          </section>
        ))}
        {tab === "failures" && events.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No failure among the {loaded.length} loaded events; load more to
            look further back.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-fg-muted">
            {events.length} {events.length === 1 ? "event" : "events"} shown
            {feed.hasNextPage ? "" : " · everything loaded"}
          </span>
          {feed.hasNextPage ? (
            <Button
              loading={feed.isFetchingNextPage}
              onClick={() => {
                void feed.fetchNextPage();
              }}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Activity"
        description="Everything that happened across the fleet: saves, hook runs, pending changes, drift and backups."
      />
      <Tabs
        label="Activity filter"
        items={TAB_ITEMS}
        value={tab}
        onChange={(next) => {
          if (isTab(next)) setTab(next);
        }}
        panel={() => body}
      />
    </>
  );
}
