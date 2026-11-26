// A small reader of five-field cron patterns for the schedules calendar: it
// says on which days of a month a pattern fires and at which times of day,
// so the calendar can project a cron schedule's occurrences. The server
// (croner) decides the real run times; a projection is labelled as one. Six
// fields are read as croner does, with the seconds first and ignored here.
// Day-of-month and day-of-week are both restricted only on the days either
// matches, the classic cron reading croner uses by default.

export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  /** Whether the day-of-month field restricts (not a star). */
  readonly daysRestricted: boolean;
  /** Whether the day-of-week field restricts (not a star). */
  readonly weekdaysRestricted: boolean;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function nameValue(word: string, names: readonly string[]): number | null {
  const index = names.indexOf(word.toLowerCase());
  return index === -1 ? null : index;
}

function numberOf(
  word: string,
  names: readonly string[] | null,
  offset: number,
): number | null {
  if (/^\d+$/.test(word)) {
    return Number(word);
  }
  if (names === null) {
    return null;
  }
  const named = nameValue(word, names);
  return named === null ? null : named + offset;
}

/**
 * One field as the set of values it allows: star, lists, ranges, steps and
 * the month and weekday names. Null for anything it cannot read.
 */
export function expandField(
  field: string,
  min: number,
  max: number,
  names: readonly string[] | null = null,
  offset = 0,
): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") {
      return null;
    }
    const [rangeText, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || rangeText === undefined) {
      return null;
    }
    let from: number;
    let to: number;
    if (rangeText === "*") {
      from = min;
      to = max;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      const start = numberOf(a ?? "", names, offset);
      const end = numberOf(b ?? "", names, offset);
      if (start === null || end === null) {
        return null;
      }
      from = start;
      to = end;
    } else {
      const one = numberOf(rangeText, names, offset);
      if (one === null) {
        return null;
      }
      from = one;
      to = stepText === undefined ? one : max;
    }
    if (from < min || to > max || from > to) {
      return null;
    }
    for (let value = from; value <= to; value += step) {
      out.add(value);
    }
  }
  return out;
}

/** The fields of a pattern, or null when it is not one this reader knows. */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length === 6) {
    parts.shift();
  }
  if (parts.length !== 5) {
    return null;
  }
  const [minute, hour, day, month, weekday] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = expandField(minute, 0, 59);
  const hours = expandField(hour, 0, 23);
  const days = expandField(day, 1, 31);
  const months = expandField(month, 1, 12, MONTH_NAMES, 1);
  const weekdaysRaw = expandField(weekday, 0, 7, WEEKDAY_NAMES);
  if (
    minutes === null ||
    hours === null ||
    days === null ||
    months === null ||
    weekdaysRaw === null
  ) {
    return null;
  }
  // 7 is Sunday too.
  const weekdays = new Set<number>();
  for (const value of weekdaysRaw) {
    weekdays.add(value === 7 ? 0 : value);
  }
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    daysRestricted: day !== "*",
    weekdaysRestricted: weekday !== "*",
  };
}

/** Whether the pattern fires on this calendar day (month 1 to 12). */
export function cronMatchesDay(
  fields: CronFields,
  year: number,
  month: number,
  day: number,
): boolean {
  if (!fields.months.has(month)) {
    return false;
  }
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayMatch = fields.days.has(day);
  const weekdayMatch = fields.weekdays.has(weekday);
  if (fields.daysRestricted && fields.weekdaysRestricted) {
    return dayMatch || weekdayMatch;
  }
  if (fields.daysRestricted) {
    return dayMatch;
  }
  if (fields.weekdaysRestricted) {
    return weekdayMatch;
  }
  return true;
}

/** The times of day a pattern fires, as HH:MM, sorted, at most limit. */
export function cronTimesOfDay(fields: CronFields, limit = 48): string[] {
  const out: string[] = [];
  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);
  for (const hour of hours) {
    for (const minute of minutes) {
      if (out.length >= limit) {
        return out;
      }
      out.push(
        `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      );
    }
  }
  return out;
}

/** How many times a day the pattern fires. */
export function cronRunsPerDay(fields: CronFields): number {
  return fields.hours.size * fields.minutes.size;
}
