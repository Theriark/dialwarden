// Schedules (dev-work-plan P9-C step 2, Paid feature schedules): the month
// calendar and the list of every schedule the person may see, with create,
// replace (the API has no edit in place: a new one is made and the old one
// removed) and delete, run-at or cron with a time zone, the revert, and the
// states scheduled, ran, reverted, failed, missed and paused (the Free plan
// pauses every schedule; the list itself answers 402 on Free and the page
// renders the upgrade hint). A viewer reads; the owner, an admin and an
// editor with write access on the server make and remove schedules (the
// server's access field says which, P10-A L22). The chips of a schedule
// carry the pack's labels, read from the settings-meta of each server's
// pack (P9 live check L3).
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CalendarClock,
  CircleCheck,
  CircleX,
  Pause,
  Pencil,
  Plus,
  Repeat,
  Trash2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { SECRET_MASK, type Setting } from "@dialwarden/packs-schema";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import { createSchedule, deleteSchedule } from "../api/fleet";
import {
  schedulesQuery,
  serversQuery,
  settingsMetaQuery,
} from "../api/queries";
import type { Chip, Schedule, ScheduleInput, Server } from "../api/schema";
import {
  canWriteServer,
  SERVER_WRITE_ROLES,
  useSessionUser,
} from "../api/session";
import { ChangeChip } from "../components/change-chip";
import { PageHeader } from "../components/layout/page-header";
import { ReadOnlyNotice } from "../components/read-only-notice";
import {
  monthOf,
  ScheduleCalendar,
  type Month,
} from "../components/schedule-calendar";
import { ScheduleForm } from "../components/schedule-form";
import { UpgradeHint } from "../components/upgrade-hint";
import { Alert } from "../components/ui/alert";
import { Badge, type BadgeKind } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog, Dialog } from "../components/ui/dialog";
import { SelectField } from "../components/ui/field";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { useToast } from "../components/ui/toast";
import { cn } from "../lib/cn";
import { describeSchedule, formatDateTime } from "../lib/format";
import { settingsByKey } from "../lib/pack";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True when a schedule has a run or a revert due within a week of now (P9
 * live check L5: the tile counted the runs only).
 */
export function dueWithinWeek(schedule: Schedule, now = Date.now()): boolean {
  if (schedule.state !== "active") return false;
  const soon = (at: string | null) =>
    at !== null && Date.parse(at) - now < WEEK_MS;
  return soon(schedule.nextRunAt) || soon(schedule.revertDueAt);
}

export interface StateWords {
  readonly kind: BadgeKind;
  readonly Icon: LucideIcon;
  readonly word: string;
}

/** The badge of a schedule: its state and the result of its last run. */
export function scheduleStateWords(schedule: Schedule): StateWords {
  if (schedule.state === "paused") {
    return { kind: "neutral", Icon: Pause, word: "Paused on Free" };
  }
  if (schedule.state === "missed" || schedule.lastResult === "missed") {
    return { kind: "warning", Icon: TriangleAlert, word: "Missed" };
  }
  if (schedule.lastResult === "failed" || schedule.lastResult === "conflict") {
    return { kind: "error", Icon: CircleX, word: "Failed" };
  }
  if (schedule.state === "done") {
    if (schedule.lastRevertAt !== null) {
      return { kind: "neutral", Icon: Undo2, word: "Reverted" };
    }
    return { kind: "success", Icon: CircleCheck, word: "Ran" };
  }
  if (schedule.lastRunAt !== null && schedule.revertDueAt !== null) {
    return { kind: "success", Icon: CircleCheck, word: "Ran, revert due" };
  }
  if (schedule.lastRunAt !== null) {
    return { kind: "info", Icon: Repeat, word: "Ran, repeats" };
  }
  return { kind: "info", Icon: CalendarClock, word: "Scheduled" };
}

/** "Once on 27 Nov 2026, 04:00" or "Every day at 04:00 (Europe/Lisbon)". */
export function whenWords(schedule: Schedule): string {
  if (schedule.cron !== null) {
    return describeSchedule(schedule.cron, schedule.timezone);
  }
  return `Once on ${formatDateTime(schedule.runAt)}`;
}

/**
 * The chips of a schedule's edits, with the pack's labels and badges when
 * its settings are known; a secret keeps the mask the API answers.
 */
export function chipsOf(
  schedule: Schedule,
  byKey?: ReadonlyMap<string, Setting> | undefined,
): Chip[] {
  return schedule.edits.map((edit) => {
    const setting = byKey?.get(edit.settingKey);
    const secret = setting?.secret === true || edit.value === SECRET_MASK;
    return {
      kind: secret ? "masked" : "changed",
      fileId: setting?.file ?? "",
      settingKey: edit.settingKey,
      label: setting?.label ?? edit.settingKey,
      from: null,
      to: secret ? SECRET_MASK : edit.value,
      restartRequired: setting?.restartRequired === true,
    };
  });
}

function ScheduleRow({
  schedule,
  serverName,
  settings,
  canWrite,
  highlighted,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  serverName: string;
  settings: ReadonlyMap<string, Setting> | undefined;
  canWrite: boolean;
  highlighted: boolean;
  onEdit: (schedule: Schedule) => void;
  onDelete: (schedule: Schedule) => void;
}) {
  const state = scheduleStateWords(schedule);
  return (
    <li
      id={`schedule-${schedule.id}`}
      className={cn(
        "flex flex-col gap-2 rounded-card border p-3 transition-colors duration-150",
        highlighted
          ? "border-primary bg-accent-soft"
          : "border-border bg-surface",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-heading text-base font-semibold text-fg">
            {schedule.name}
          </span>
          <Link
            to="/servers/$slug/history"
            params={{ slug: schedule.serverId }}
            className="truncate text-xs font-medium text-primary hover:underline"
          >
            {serverName}
          </Link>
        </div>
        <Badge kind={state.kind} icon={<state.Icon className="size-3.5" />}>
          {state.word}
        </Badge>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-fg-muted sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium">When:</dt>
          <dd>{whenWords(schedule)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium">Next run:</dt>
          <dd>{formatDateTime(schedule.nextRunAt)}</dd>
        </div>
        {schedule.revertAt !== null || schedule.revertAfterMinutes !== null ? (
          <div className="flex gap-1">
            <dt className="shrink-0 font-medium">Revert:</dt>
            <dd>
              {schedule.revertAfterMinutes !== null
                ? `${schedule.revertAfterMinutes} minutes after each run`
                : formatDateTime(schedule.revertAt)}
              {schedule.revertDueAt !== null
                ? ` · due ${formatDateTime(schedule.revertDueAt)}`
                : ""}
            </dd>
          </div>
        ) : null}
        {schedule.lastRunAt !== null ? (
          <div className="flex gap-1">
            <dt className="shrink-0 font-medium">Last run:</dt>
            <dd>
              {formatDateTime(schedule.lastRunAt)}
              {schedule.lastResult === null
                ? ""
                : ` (${schedule.lastResult.replace("_", " ")})`}
            </dd>
          </div>
        ) : null}
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium">By:</dt>
          <dd>{schedule.author}</dd>
        </div>
      </dl>
      <ul className="flex flex-wrap gap-1.5">
        {chipsOf(schedule, settings).map((chip) => (
          <ChangeChip
            key={`${schedule.id}-${chip.settingKey ?? ""}`}
            chip={chip}
          />
        ))}
      </ul>
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Pencil className="size-4" aria-hidden="true" />}
            onClick={() => {
              onEdit(schedule);
            }}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            icon={<Trash2 className="size-4" aria-hidden="true" />}
            onClick={() => {
              onDelete(schedule);
            }}
          >
            Delete
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function StatTile({
  icon,
  label,
  value,
  caption,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
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

export function SchedulesPage() {
  const user = useSessionUser();
  const client = useQueryClient();
  const toast = useToast();
  const servers = useQuery(serversQuery());
  const schedules = useQuery(schedulesQuery());
  const [filter, setFilter] = useState("");
  const [month, setMonth] = useState<Month>(() => monthOf(new Date()));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [form, setForm] = useState<"closed" | "new" | Schedule>("closed");
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["schedules"] });
    void client.invalidateQueries({ queryKey: ["activity"] });
  };

  const save = useMutation({
    mutationFn: async (input: {
      body: ScheduleInput;
      replace: Schedule | null;
    }) => {
      const created = await createSchedule(input.body);
      if (input.replace === null) {
        return { created, oldKept: null };
      }
      // The new one exists from here on: a failed delete of the old one
      // (the network, a server error) must not leave the form open for a
      // second Replace, which would make a third copy. An old one that is
      // already gone (404) is exactly what a replace wants (P9-C review R1).
      try {
        await deleteSchedule(input.replace.id);
        return { created, oldKept: null };
      } catch (error: unknown) {
        if (error instanceof ApiError && error.code === "schedule_not_found") {
          return { created, oldKept: null };
        }
        return { created, oldKept: error };
      }
    },
    onSuccess: ({ created, oldKept }, input) => {
      if (oldKept !== null) {
        toast.push({
          kind: "error",
          title: "Schedule created, but the old one is still there",
          description: `${created.name} was made; ${input.replace?.name ?? "the old schedule"} was not removed (${errorMessage(oldKept)}). Delete it by hand so both do not run.`,
        });
      } else {
        toast.push({
          kind: "success",
          title:
            input.replace === null ? "Schedule created" : "Schedule replaced",
          description: `${created.name}: next run ${formatDateTime(created.nextRunAt)}.`,
        });
      }
      setForm("closed");
      setHighlighted(created.id);
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (schedule: Schedule) => deleteSchedule(schedule.id),
    onSuccess: () => {
      toast.push({ kind: "success", title: "Schedule deleted" });
      setRemoving(null);
      refresh();
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The schedule was not deleted",
        description: errorMessage(error),
      });
    },
  });

  const serverList: readonly Server[] = servers.data?.items ?? [];
  const names = new Map(serverList.map((server) => [server.id, server.name]));
  // The pack of each server names its settings: the chips show labels, not
  // keys, and a secret setting keeps its mask (P9 live check L3).
  const packIds = useMemo(
    () => [...new Set(serverList.map((server) => server.packId))],
    [serverList],
  );
  const metas = useQueries({
    queries: packIds.map((packId) => settingsMetaQuery(packId)),
  });
  const settingsOfPack = new Map<string, ReadonlyMap<string, Setting>>();
  packIds.forEach((packId, index) => {
    // eslint-disable-next-line security/detect-object-injection -- a positional index into the parallel meta queries
    const data = metas[index]?.data;
    if (data !== undefined) {
      settingsOfPack.set(packId, settingsByKey(data.settings as Setting[]));
    }
  });
  const settingsOfServer = (serverId: string) =>
    settingsOfPack.get(
      serverList.find((server) => server.id === serverId)?.packId ?? "",
    );
  // Who writes what (P10-A L22): the role allows writes and the server's own
  // answer says write for that server. The New button needs one such server.
  const roleWrites = user !== null && SERVER_WRITE_ROLES.includes(user.role);
  const writable = serverList.filter((server) =>
    canWriteServer(user, server.access),
  );
  const accessOf = new Map(
    serverList.map((server) => [server.id, server.access]),
  );
  const canWrite = writable.length > 0;

  if (schedules.isPending || servers.isPending) {
    return (
      <>
        <PageHeader title="Schedules" description="Loading the schedules…" />
        <RowsSkeleton rows={4} />
      </>
    );
  }

  if (schedules.isError) {
    const payment =
      schedules.error instanceof ApiError
        ? schedules.error.paymentRequired
        : null;
    if (payment !== null) {
      return (
        <>
          <PageHeader
            title="Schedules"
            description="Changes that run at a set time or on a pattern, and revert on their own."
          />
          <div className="flex flex-col gap-4">
            <UpgradeHint body={payment} />
            <Card
              title="Paused on the Free plan"
              description="Every stored schedule is kept and paused; nothing runs or reverts until a licence key makes the plan Paid, when the schedules resume on their own."
            >
              <ul className="grid grid-cols-1 gap-2 text-sm text-fg sm:grid-cols-3">
                <li className="flex items-start gap-2">
                  <CalendarClock
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  A run at a set time, or on a cron pattern in a time zone.
                </li>
                <li className="flex items-start gap-2">
                  <Undo2
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  A revert that puts the earlier values back.
                </li>
                <li className="flex items-start gap-2">
                  <Repeat
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  Each run is a change set in the server's history.
                </li>
              </ul>
            </Card>
          </div>
        </>
      );
    }
    return (
      <>
        <PageHeader title="Schedules" />
        <ErrorState
          message="The schedules could not be loaded."
          onRetry={() => {
            void schedules.refetch();
          }}
          retrying={schedules.isFetching}
        />
      </>
    );
  }

  const all = schedules.data.items;
  const shown = filter === "" ? all : all.filter((s) => s.serverId === filter);
  const now = Date.now();
  const soon = all.filter((s) => dueWithinWeek(s, now)).length;
  const paused = all.filter((s) => s.state === "paused").length;
  const trouble = all.filter(
    (s) =>
      s.state === "missed" ||
      s.lastResult === "missed" ||
      s.lastResult === "failed" ||
      s.lastResult === "conflict",
  ).length;
  const sorted = [...shown].sort((a, b) => {
    const left = a.nextRunAt ?? a.lastRunAt ?? a.createdAt;
    const right = b.nextRunAt ?? b.lastRunAt ?? b.createdAt;
    return left.localeCompare(right);
  });

  const newButton = canWrite ? (
    <Button
      variant="primary"
      icon={<Plus className="size-4" aria-hidden="true" />}
      disabled={writable.length === 0}
      onClick={() => {
        setForm("new");
      }}
    >
      New schedule
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Changes that run at a set time or on a pattern, and revert on their own. Each run is a change set in the server's history."
        actions={newButton}
      />
      {canWrite ? null : (
        <ReadOnlyNotice
          role={user?.role ?? "viewer"}
          reads="the schedules"
          writes="makes and removes them"
          grant={roleWrites}
          className="mb-4"
        />
      )}
      {all.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="size-6" aria-hidden="true" />}
          title="No schedule yet"
          description={
            canWrite
              ? "Plan a change for later: a weekend rate, a maintenance window, a nightly reset. Each one runs on its own and can put the earlier values back."
              : "The owner, an admin or an editor with write access plans the changes that run later."
          }
          action={newButton}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile
              icon={
                <CalendarClock className="size-5 shrink-0" aria-hidden="true" />
              }
              label="Next 7 days"
              value={soon}
              caption="Runs and reverts due this week"
            />
            <StatTile
              icon={<Pause className="size-5 shrink-0" aria-hidden="true" />}
              label="Paused"
              value={paused}
              caption="Waiting for the Paid plan"
            />
            <StatTile
              icon={
                <TriangleAlert className="size-5 shrink-0" aria-hidden="true" />
              }
              label="Need a look"
              value={trouble}
              caption="Missed or failed runs"
            />
          </div>
          <div className="grid gap-6 lg:grid-cols-5">
            <Card
              title="Calendar"
              description="Runs and reverts by day in Europe/Lisbon; a cron pattern's later days are projected."
              className="lg:col-span-3"
            >
              <ScheduleCalendar
                schedules={shown}
                month={month}
                onMonthChange={setMonth}
                selectedDay={selectedDay}
                onSelectDay={setSelectedDay}
                onPick={(id) => {
                  setHighlighted(id);
                  document
                    .getElementById(`schedule-${id}`)
                    ?.scrollIntoView({ block: "nearest" });
                }}
              />
            </Card>
            <Card
              title="All schedules"
              description={`${shown.length} of ${all.length} shown`}
              className="lg:col-span-2"
            >
              {serverList.length > 1 ? (
                <SelectField
                  id="schedule-filter"
                  label="Server"
                  placeholder="Every server"
                  value={filter}
                  options={serverList.map((server) => ({
                    value: server.id,
                    label: server.name,
                  }))}
                  onChange={setFilter}
                />
              ) : null}
              {sorted.length === 0 ? (
                <Alert kind="info">No schedule on this server.</Alert>
              ) : (
                <ul className="flex flex-col gap-3">
                  {sorted.map((schedule) => (
                    <ScheduleRow
                      key={schedule.id}
                      schedule={schedule}
                      serverName={
                        names.get(schedule.serverId) ?? schedule.serverId
                      }
                      settings={settingsOfServer(schedule.serverId)}
                      canWrite={canWriteServer(
                        user,
                        accessOf.get(schedule.serverId),
                      )}
                      highlighted={highlighted === schedule.id}
                      onEdit={(item) => {
                        setForm(item);
                      }}
                      onDelete={setRemoving}
                    />
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
      {form === "closed" ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !save.isPending) {
              setForm("closed");
              save.reset();
            }
          }}
          title={form === "new" ? "New schedule" : `Edit ${form.name}`}
          description={
            form === "new"
              ? "A change that runs later on one server, with an optional revert."
              : "Saving replaces the stored schedule with this one."
          }
          className="max-w-3xl"
        >
          <ScheduleForm
            servers={writable}
            initial={form === "new" ? undefined : form}
            pending={save.isPending}
            error={save.error ?? undefined}
            onSubmit={(body) => {
              save.mutate({ body, replace: form === "new" ? null : form });
            }}
            onCancel={() => {
              setForm("closed");
              save.reset();
            }}
          />
        </Dialog>
      )}
      {removing === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRemoving(null);
            }
          }}
          title={`Delete ${removing.name}?`}
          description="The schedule stops; a revert still due is dropped with it. Runs already made stay in the server's history."
          confirmLabel="Delete"
          destructive
          loading={remove.isPending}
          onConfirm={() => {
            remove.mutate(removing);
          }}
        />
      )}
    </>
  );
}
