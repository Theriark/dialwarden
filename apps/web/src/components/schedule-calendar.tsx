// The schedules calendar (dev-work-plan P9-C step 2): one month, Monday
// first, every schedule's runs and reverts on the day they fall in the
// display zone (Europe/Lisbon, like every date in the app): the next run and
// the revert due from the server, the last run and revert with their result,
// and the occurrences of a cron pattern projected by lib/cron for the rest
// of the month (the server decides the real times; a projection says so).
// Each day is a button; the chosen day lists its items under the grid.
/* eslint-disable security/detect-object-injection -- the keys are the fixed calendar kinds of a constant word table, never free-form input */
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Pause,
  Repeat,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { Schedule } from "../api/schema";
import { cronMatchesDay, cronTimesOfDay, parseCron } from "../lib/cron";
import { cn } from "../lib/cn";
import { DISPLAY_ZONE } from "../lib/format";
import { dayKeyOf, timeOfDayOf } from "../lib/time";
import { Button, IconButton } from "./ui/button";

export type CalendarKind =
  | "run"
  | "revert"
  | "ran"
  | "reverted"
  | "failed"
  | "missed"
  | "paused"
  | "projected";

export interface CalendarItem {
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduleName: string;
  /** YYYY-MM-DD in the display zone. */
  readonly day: string;
  /** HH:MM in the display zone, or in the schedule's zone for a projection. */
  readonly time: string;
  readonly kind: CalendarKind;
  readonly label: string;
}

export interface Month {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
}

const KIND_WORDS: Record<CalendarKind, { Icon: LucideIcon; word: string }> = {
  run: { Icon: CalendarClock, word: "Scheduled" },
  revert: { Icon: Undo2, word: "Revert due" },
  ran: { Icon: CircleCheck, word: "Ran" },
  reverted: { Icon: Undo2, word: "Reverted" },
  failed: { Icon: CircleX, word: "Failed" },
  missed: { Icon: TriangleAlert, word: "Missed" },
  paused: { Icon: Pause, word: "Paused" },
  projected: { Icon: Repeat, word: "Projected" },
};

function kindClass(kind: CalendarKind): string {
  switch (kind) {
    case "ran":
      return "border-success/40 bg-success-soft text-success";
    case "failed":
      return "border-error/40 bg-error-soft text-error";
    case "missed":
      return "border-warning/40 bg-warning-soft text-warning";
    case "paused":
    case "revert":
    case "reverted":
      return "border-border-strong bg-surface text-neutral";
    case "projected":
      return "border-dashed border-info/60 bg-surface text-info";
    default:
      return "border-info/40 bg-info-soft text-info";
  }
}

function monthKey(month: Month): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

function inMonth(day: string, month: Month): boolean {
  return day.startsWith(monthKey(month));
}

function itemAt(
  schedule: Schedule,
  iso: string,
  kind: CalendarKind,
  label: string,
  suffix: string,
): CalendarItem | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return null;
  }
  const at = new Date(time);
  return {
    id: `${schedule.id}-${suffix}`,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    day: dayKeyOf(at, DISPLAY_ZONE),
    time: timeOfDayOf(at, DISPLAY_ZONE),
    kind,
    label,
  };
}

function resultKind(result: Schedule["lastResult"]): CalendarKind {
  switch (result) {
    case "failed":
    case "conflict":
      return "failed";
    case "missed":
      return "missed";
    default:
      return "ran";
  }
}

/** The items of every schedule that fall in the month. */
export function calendarItemsOf(
  schedules: readonly Schedule[],
  month: Month,
): CalendarItem[] {
  const out: CalendarItem[] = [];
  const push = (item: CalendarItem | null) => {
    if (item !== null && inMonth(item.day, month)) {
      out.push(item);
    }
  };
  for (const schedule of schedules) {
    if (schedule.nextRunAt !== null) {
      push(
        itemAt(
          schedule,
          schedule.nextRunAt,
          schedule.state === "paused" ? "paused" : "run",
          schedule.state === "paused" ? "Paused on Free" : "Next run",
          "next",
        ),
      );
    }
    if (schedule.revertDueAt !== null) {
      push(
        itemAt(
          schedule,
          schedule.revertDueAt,
          "revert",
          "Revert due",
          "revert",
        ),
      );
    }
    if (schedule.lastRunAt !== null) {
      const kind = resultKind(schedule.lastResult);
      push(
        itemAt(
          schedule,
          schedule.lastRunAt,
          kind,
          schedule.lastResult === null
            ? "Ran"
            : `Ran: ${schedule.lastResult.replace("_", " ")}`,
          "last",
        ),
      );
    } else if (
      schedule.kind === "once" &&
      schedule.runAt !== null &&
      (schedule.state === "done" || schedule.state === "missed")
    ) {
      push(
        itemAt(
          schedule,
          schedule.runAt,
          schedule.state === "missed" ? "missed" : "ran",
          schedule.state === "missed" ? "Missed" : "Ran",
          "once",
        ),
      );
    }
    if (schedule.lastRevertAt !== null) {
      push(
        itemAt(
          schedule,
          schedule.lastRevertAt,
          schedule.lastRevertResult === "failed" ||
            schedule.lastRevertResult === "conflict"
            ? "failed"
            : "reverted",
          schedule.lastRevertResult === null
            ? "Reverted"
            : `Reverted: ${schedule.lastRevertResult.replace("_", " ")}`,
          "lastRevert",
        ),
      );
    }
    if (schedule.cron !== null && schedule.state === "active") {
      const fields = parseCron(schedule.cron);
      const nextDay =
        schedule.nextRunAt === null
          ? null
          : dayKeyOf(new Date(Date.parse(schedule.nextRunAt)), DISPLAY_ZONE);
      if (fields !== null) {
        const times = cronTimesOfDay(fields, 4);
        const perDay = fields.hours.size * fields.minutes.size;
        const days = new Date(
          Date.UTC(month.year, month.month, 0),
        ).getUTCDate();
        for (let day = 1; day <= days; day += 1) {
          const key = `${monthKey(month)}-${String(day).padStart(2, "0")}`;
          if (nextDay !== null && key <= nextDay) {
            continue;
          }
          if (!cronMatchesDay(fields, month.year, month.month, day)) {
            continue;
          }
          out.push({
            id: `${schedule.id}-projected-${key}`,
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            day: key,
            time: times[0] ?? "00:00",
            kind: "projected",
            label: `Projected ${perDay === 1 ? "run" : `${perDay} runs`} at ${times.join(", ")}${perDay > times.length ? "…" : ""} (${schedule.timezone})`,
          });
        }
      }
    }
  }
  return out.sort((a, b) =>
    a.day === b.day ? a.time.localeCompare(b.time) : a.day.localeCompare(b.day),
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const monthLabel = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const dayLabel = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

export function monthOf(date: Date): Month {
  const key = dayKeyOf(date, DISPLAY_ZONE);
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
}

export function shiftMonth(month: Month, by: number): Month {
  const index = month.year * 12 + (month.month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function dayWords(key: string): string {
  const time = Date.parse(`${key}T12:00:00Z`);
  return Number.isNaN(time) ? key : dayLabel.format(new Date(time));
}

export interface ScheduleCalendarProps {
  schedules: readonly Schedule[];
  month: Month;
  onMonthChange: (month: Month) => void;
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
  onPick: (scheduleId: string) => void;
  /** Today's key, for the test clock. */
  today?: string | undefined;
}

export function ScheduleCalendar({
  schedules,
  month,
  onMonthChange,
  selectedDay,
  onSelectDay,
  onPick,
  today = dayKeyOf(new Date(), DISPLAY_ZONE),
}: ScheduleCalendarProps) {
  const items = calendarItemsOf(schedules, month);
  const byDay = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const list = byDay.get(item.day) ?? [];
    list.push(item);
    byDay.set(item.day, list);
  }
  const first = new Date(Date.UTC(month.year, month.month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  const selectedItems =
    selectedDay === null ? [] : (byDay.get(selectedDay) ?? []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-lg font-semibold text-fg">
          {monthLabel.format(first)}
        </h3>
        <div className="flex items-center gap-1">
          <IconButton
            label="Previous month"
            onClick={() => {
              onMonthChange(shiftMonth(month, -1));
              onSelectDay(null);
            }}
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </IconButton>
          <Button
            variant="ghost"
            onClick={() => {
              onMonthChange(monthOf(new Date()));
              onSelectDay(today);
            }}
          >
            Today
          </Button>
          <IconButton
            label="Next month"
            onClick={() => {
              onMonthChange(shiftMonth(month, 1));
              onSelectDay(null);
            }}
          >
            <ChevronRight className="size-5" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div
        role="grid"
        aria-label={`Schedules in ${monthLabel.format(first)}`}
        className="grid grid-cols-7 gap-1"
      >
        <div role="row" className="contents">
          {WEEKDAYS.map((weekday) => (
            <div
              key={weekday}
              role="columnheader"
              className="py-1 text-center text-xs font-medium tracking-wide text-fg-muted uppercase"
            >
              {weekday}
            </div>
          ))}
        </div>
        {Array.from({ length: cells.length / 7 }, (_, week) => (
          <div key={week} role="row" className="contents">
            {cells.slice(week * 7, week * 7 + 7).map((day, index) => {
              if (day === null) {
                return (
                  <div
                    key={`blank-${week}-${index}`}
                    role="gridcell"
                    aria-hidden="true"
                    className="min-h-16 rounded-control bg-bg/60 sm:min-h-20"
                  />
                );
              }
              const key = `${monthKey(month)}-${String(day).padStart(2, "0")}`;
              const list = byDay.get(key) ?? [];
              const selected = key === selectedDay;
              const isToday = key === today;
              return (
                <div key={key} role="gridcell" className="min-w-0">
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${dayWords(key)}: ${list.length} ${
                      list.length === 1 ? "item" : "items"
                    }`}
                    onClick={() => {
                      onSelectDay(selected ? null : key);
                    }}
                    className={cn(
                      "flex min-h-16 w-full flex-col gap-1 rounded-control border p-1 text-left transition-colors duration-150 hover:bg-accent-soft sm:min-h-20 sm:p-1.5",
                      selected
                        ? "border-primary bg-accent-soft"
                        : "border-border bg-surface",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full text-xs font-medium",
                        isToday ? "bg-primary text-primary-fg" : "text-fg",
                      )}
                    >
                      {day}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      {list.slice(0, 2).map((item) => {
                        const { Icon } = KIND_WORDS[item.kind];
                        return (
                          <span
                            key={item.id}
                            className={cn(
                              "flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium",
                              kindClass(item.kind),
                            )}
                            title={`${item.scheduleName}: ${item.label} ${item.time}`}
                          >
                            <Icon
                              className="size-3 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="hidden truncate sm:inline">
                              {item.time}
                            </span>
                          </span>
                        );
                      })}
                      {list.length > 2 ? (
                        <span className="text-[11px] text-fg-muted">
                          +{list.length - 2}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
        {(Object.keys(KIND_WORDS) as CalendarKind[]).map((kind) => {
          const { Icon, word } = KIND_WORDS[kind];
          return (
            <li key={kind} className="flex items-center gap-1">
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border",
                  kindClass(kind),
                )}
              >
                <Icon className="size-2.5" aria-hidden="true" />
              </span>
              {word}
            </li>
          );
        })}
      </ul>
      {selectedDay === null ? null : (
        <section
          aria-label={`Items on ${dayWords(selectedDay)}`}
          className="flex flex-col gap-2 rounded-card border border-border bg-bg p-3"
        >
          <h4 className="text-sm font-semibold text-fg">
            {dayWords(selectedDay)}
          </h4>
          {selectedItems.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing on this day.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {selectedItems.map((item) => {
                const { Icon, word } = KIND_WORDS[item.kind];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm hover:bg-accent-soft"
                      onClick={() => {
                        onPick(item.scheduleId);
                      }}
                    >
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
                          kindClass(item.kind),
                        )}
                      >
                        <Icon className="size-3.5" aria-hidden="true" />
                        {word}
                      </span>
                      <span className="font-mono text-xs text-fg-muted tabular">
                        {item.time}
                      </span>
                      <span className="font-medium text-fg">
                        {item.scheduleName}
                      </span>
                      <span className="text-xs text-fg-muted">
                        {item.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
