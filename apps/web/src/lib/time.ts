// Time-zone helpers for the schedules (dev-work-plan P9-C): a wall-clock
// time typed into a datetime-local field is read in a named zone and sent as
// an instant, and an instant is shown as the calendar day it falls on in a
// zone. Intl only, no date library (design-direction-1 part 9).
import { DISPLAY_ZONE } from "./format";

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = partsCache.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partsCache.set(timeZone, found);
  }
  return found;
}

/** Whether Intl knows this zone name. */
export function isTimeZone(name: string): boolean {
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock an instant shows in a zone. */
export function wallClockOf(instant: Date, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

/** "YYYY-MM-DD" of the calendar day an instant falls on in a zone. */
export function dayKeyOf(instant: Date, timeZone = DISPLAY_ZONE): string {
  const wall = wallClockOf(instant, timeZone);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** "HH:MM" of an instant in a zone. */
export function timeOfDayOf(instant: Date, timeZone = DISPLAY_ZONE): string {
  const wall = wallClockOf(instant, timeZone);
  return `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
}

/**
 * The instant of a wall-clock time in a zone. The zone's offset at that
 * moment is found by reading the UTC guess back through the zone and
 * correcting once more, which also settles the daylight-saving edges.
 */
export function instantOf(wall: WallClock, timeZone: string): Date {
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  let instant = guess;
  for (let round = 0; round < 2; round += 1) {
    const seen = wallClockOf(new Date(instant), timeZone);
    const seenUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
    );
    instant += guess - seenUtc;
  }
  return new Date(instant);
}

/** The datetime-local value ("YYYY-MM-DDTHH:MM") of an instant in a zone. */
export function localInputValue(iso: string, timeZone: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return "";
  }
  const wall = wallClockOf(new Date(time), timeZone);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}T${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
}

/** The instant (ISO, UTC) of a datetime-local value read in a zone. */
export function isoOfLocalInput(
  value: string,
  timeZone: string,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (match === null) {
    return null;
  }
  const wall: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  return instantOf(wall, timeZone).toISOString();
}

/** The zones a select offers: the browser's list, or a short one without it. */
export function timeZoneOptions(): string[] {
  const intl = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  const listed =
    typeof intl.supportedValuesOf === "function"
      ? intl.supportedValuesOf("timeZone")
      : [];
  const base = listed.length > 0 ? listed : [DISPLAY_ZONE, "UTC"];
  const out = new Set<string>(["UTC", DISPLAY_ZONE]);
  for (const zone of base) {
    out.add(zone);
  }
  return [...out];
}

/** The zone the browser runs in, or the display zone when unknown. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone === "" || zone === undefined ? DISPLAY_ZONE : zone;
  } catch {
    return DISPLAY_ZONE;
  }
}
