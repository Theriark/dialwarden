// The fleet wall (screen 1 of dev-work-plan P5): one card per server with our
// neutral game glyph, the status chip from the probe (P6-C, contract C7), the
// plan state, the drift badge from the server's history and from the P9
// background check, the pending badge from the status answer and the last
// change with its author. The strip on top counts the servers, the drift
// alerts and the schedule runs due this week (P9, Paid; zero on Free).
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CalendarClock,
  Gamepad2,
  History,
  Lock,
  Plus,
  Radar,
  Server,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  driftQuery,
  entitlementQuery,
  historyQuery,
  schedulesQuery,
  serverStatusQuery,
  serversQuery,
} from "../api/queries";
import type {
  Drift,
  History as ServerHistory,
  Schedule,
  Server as ServerData,
  ServerStatus,
} from "../api/schema";
import { useIsOwner } from "../api/session";
import { PageHeader } from "../components/layout/page-header";
import { PendingBadge } from "../components/pending-badge";
import { StatusChip } from "../components/status-chip";
import { Badge } from "../components/ui/badge";
import { CardSkeleton, EmptyState, ErrorState } from "../components/ui/states";
import { formatDateTime } from "../lib/format";

const STAT_ICON = "size-5 shrink-0";

function StatTile({
  icon,
  label,
  value,
  caption,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4 shadow-card">
      <span className="flex items-center gap-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
        {icon}
        {label}
      </span>
      <span className="font-heading text-3xl font-semibold text-fg">
        {value}
      </span>
      <span className="text-xs text-fg-muted">{caption}</span>
    </div>
  );
}

/** What the fleet wall needs to know about one server's history. */
export interface ServerPulse {
  readonly drift: boolean;
  readonly pending: boolean;
  readonly lastChange: string;
}

/**
 * Reads drift, pending and the last change out of a history answer. The
 * background check (P9) also raises the drift flag while its last result is
 * drift, so a card warns even when a later app change tops the timeline.
 */
export function pulseOf(
  history: ServerHistory | undefined,
  check?: Drift | undefined,
): ServerPulse {
  const [latest] = history?.entries ?? [];
  if (latest === undefined) {
    return {
      drift: check?.lastResult === "drift",
      pending: false,
      lastChange: "No changes yet",
    };
  }
  const at = formatDateTime(latest.at);
  const drift = latest.cause === "external" || check?.lastResult === "drift";
  const pending = latest.status === "pending";
  let lastChange: string;
  switch (latest.cause) {
    case "external":
      lastChange = `${at} — edited outside Dialwarden`;
      break;
    case "rollback":
      lastChange = `${at} — rolled back by ${latest.author}`;
      break;
    case "import":
      lastChange = `${at} — imported by ${latest.author}`;
      break;
    default:
      lastChange = `${at} by ${latest.author}`;
  }
  return { drift, pending, lastChange };
}

/** What the card knows about one server's probe answer. */
export interface CardStatus {
  readonly status: ServerStatus | undefined;
  readonly loading: boolean;
  readonly error: unknown;
}

function ServerCard({
  server,
  pulse,
  probe,
  isOwner,
}: {
  server: ServerData;
  pulse: ServerPulse;
  probe: CardStatus;
  isOwner: boolean;
}) {
  // The status answer counts the pending change sets exactly; until it
  // arrives the latest history entry says whether one waits.
  const pendingCount = probe.status?.pending ?? (pulse.pending ? 1 : 0);
  return (
    <article className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-card bg-accent-soft text-primary"
          >
            <Gamepad2 className="size-6" />
          </span>
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate font-heading text-lg font-semibold text-fg">
              <Link
                to="/servers/$slug/settings"
                params={{ slug: server.id }}
                className="text-fg hover:text-primary"
              >
                {server.name}
              </Link>
            </h2>
            <p className="truncate text-xs text-fg-muted">
              {server.displayName} · {server.os}
            </p>
          </div>
        </div>
        <StatusChip
          status={probe.status}
          loading={probe.loading}
          error={probe.error}
          simulated={server.demo}
          className="shrink-0 justify-end"
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {server.editable ? null : (
          <Badge kind="neutral" icon={<Lock className="size-3.5" />}>
            Read-only on Free
          </Badge>
        )}
        {pulse.drift ? (
          <Link
            to="/servers/$slug/history"
            params={{ slug: server.id }}
            title="Files changed outside Dialwarden; the history holds the entry"
            className="inline-flex rounded-full"
          >
            <Badge kind="warning" icon={<TriangleAlert className="size-3.5" />}>
              Drift
            </Badge>
          </Link>
        ) : null}
        <PendingBadge count={pendingCount} slug={server.id} />
      </div>
      {server.editable ? null : (
        <p className="text-xs text-fg-muted">
          The Free plan edits three servers.{" "}
          <Link
            to="/settings/plan"
            className="font-medium text-primary hover:underline"
          >
            Choose which three
          </Link>
          .
        </p>
      )}
      <p className="text-xs text-fg-muted">Last change: {pulse.lastChange}</p>
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        <Link
          to="/servers/$slug/settings"
          params={{ slug: server.id }}
          className="inline-flex h-8 items-center gap-2 rounded-control border border-transparent bg-primary px-3 text-sm font-medium text-primary-fg transition-colors duration-150 hover:opacity-90"
        >
          Edit settings
        </Link>
        <Link
          to="/servers/$slug/history"
          params={{ slug: server.id }}
          className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg transition-colors duration-150 hover:bg-accent-soft"
        >
          <History className="size-4" aria-hidden="true" />
          History
        </Link>
        {isOwner ? (
          <Link
            to="/servers/$slug/raw"
            params={{ slug: server.id }}
            className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg transition-colors duration-150 hover:bg-accent-soft"
          >
            Raw files
          </Link>
        ) : null}
      </div>
    </article>
  );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The schedule runs due within a week of now. */
export function dueThisWeek(
  schedules: readonly Schedule[] | undefined,
  now = Date.now(),
): number {
  return (schedules ?? []).filter(
    (schedule) =>
      schedule.state === "active" &&
      schedule.nextRunAt !== null &&
      Date.parse(schedule.nextRunAt) - now < WEEK_MS,
  ).length;
}

export function FleetPage() {
  const servers = useQuery(serversQuery());
  const entitlement = useQuery(entitlementQuery());
  const isOwner = useIsOwner();
  const items = servers.data?.items ?? [];
  const histories = useQueries({
    queries: items.map((server) => historyQuery(server.id)),
  });
  const statuses = useQueries({
    queries: items.map((server) => serverStatusQuery(server.id)),
  });
  // Paid answers; on Free both are 402 and the wall shows no check and no
  // scheduled run, which is the truth of that plan.
  const paid = entitlement.data?.plan === "paid";
  const checks = useQuery({ ...driftQuery(), enabled: paid });
  const schedules = useQuery({ ...schedulesQuery(), enabled: paid });
  const checkOf = (id: string): Drift | undefined =>
    checks.data?.items.find((item) => item.serverId === id);

  if (servers.isPending) {
    return (
      <>
        <PageHeader title="Fleet" description="Loading your servers…" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </>
    );
  }

  if (servers.isError) {
    return (
      <>
        <PageHeader
          title="Fleet"
          description="Your game servers, their settings and their state."
        />
        <ErrorState
          message="The server list could not be loaded."
          onRetry={() => {
            void servers.refetch();
          }}
        />
      </>
    );
  }

  const plan = paid ? "Paid" : "Free";
  const driftCount = items.filter((server, index) => {
    // eslint-disable-next-line security/detect-object-injection -- a positional index into the parallel history queries
    const history = histories[index]?.data;
    return pulseOf(history, checkOf(server.id)).drift;
  }).length;
  const scheduledThisWeek = dueThisWeek(schedules.data?.items);
  const runningCount = statuses.filter(
    (query) => query.data?.state === "running",
  ).length;
  const stoppedCount = statuses.filter(
    (query) => query.data?.state === "stopped",
  ).length;

  if (items.length === 0) {
    return (
      <>
        <PageHeader
          title="Fleet"
          description="Your game servers, their settings and their state."
        />
        <EmptyState
          icon={<Server className="size-6" aria-hidden="true" />}
          title="No servers yet"
          description={
            isOwner
              ? "Add your first game server to edit its settings safely: Dialwarden reads the files, shows the typed editor and keeps every change reversible."
              : "No game server is set up yet. Ask the owner to add the first one."
          }
          action={
            isOwner ? (
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
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Fleet"
        description="Your game servers, their settings and their state."
        actions={
          isOwner ? (
            <Link
              to="/servers/new"
              className="inline-flex h-8 items-center gap-2 rounded-control border border-transparent bg-primary px-3 text-sm font-medium text-primary-fg transition-colors duration-150 hover:opacity-90"
            >
              <Plus className="size-4" aria-hidden="true" />
              Add server
            </Link>
          ) : undefined
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={<Server className={STAT_ICON} aria-hidden="true" />}
          label="Servers"
          value={String(items.length)}
          caption={`${plan} plan: ${
            entitlement.data?.limits.servers === null
              ? "no limit"
              : `${entitlement.data?.limits.servers ?? 3} on Free`
          } · ${runningCount} running, ${stoppedCount} stopped`}
        />
        <StatTile
          icon={<Radar className={STAT_ICON} aria-hidden="true" />}
          label="Drift alerts"
          value={String(driftCount)}
          caption="Servers whose files changed outside Dialwarden"
        />
        <StatTile
          icon={<CalendarClock className={STAT_ICON} aria-hidden="true" />}
          label="Scheduled this week"
          value={String(scheduledThisWeek)}
          caption={
            paid
              ? "Schedule runs due in the next seven days"
              : "Scheduled changes are part of the Paid plan"
          }
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((server, index) => {
          // eslint-disable-next-line security/detect-object-injection -- a positional index into the parallel history queries
          const pulse = pulseOf(histories[index]?.data, checkOf(server.id));
          // eslint-disable-next-line security/detect-object-injection -- a positional index into the parallel status queries
          const status = statuses[index];
          return (
            <ServerCard
              key={server.id}
              server={server}
              pulse={pulse}
              probe={{
                status: status?.data,
                loading: status?.isPending ?? true,
                error: status?.error ?? undefined,
              }}
              isOwner={isOwner}
            />
          );
        })}
      </div>
    </>
  );
}
