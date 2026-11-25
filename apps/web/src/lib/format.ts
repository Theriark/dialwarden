// Display helpers. Dates are shown in Europe/Lisbon (the company zone) and the
// browser zone is never silently assumed. No date library: Intl only
// (design-direction-1 part 9).

export const DISPLAY_ZONE = "Europe/Lisbon";

const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

const dateOnly = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_ZONE,
  dateStyle: "medium",
});

/** "21 Nov 2026, 18:30" in Europe/Lisbon, or a dash for null or garbage. */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return value;
  }
  return dateTime.format(new Date(time));
}

/** "21 Nov 2026" for an ISO date or date-time, or a dash. */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const time = Date.parse(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(time)) {
    return value;
  }
  return dateOnly.format(new Date(time));
}

/** Whole days from now until the end of an ISO date (UTC), negative when past. */
export function daysUntil(isoDate: string, now = new Date()): number {
  const end = Date.parse(`${isoDate}T23:59:59Z`);
  if (Number.isNaN(end)) {
    return 0;
  }
  return Math.ceil((end - now.getTime()) / 86_400_000);
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** "1.2 MB" style sizes with one decimal above kilobytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  const unit = UNITS.at(index) ?? "B";
  const digits = index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

/**
 * Initials for the avatar: the first letter or digit of the first two words
 * that hold one. Brackets and other punctuation never count, so "admin (seed)"
 * gives "AS" and "(seed)" alone gives "S".
 */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word !== "");
  const letters = words.slice(0, 2).map((word) => word.charAt(0));
  return letters.join("").toUpperCase() || "?";
}

/** The next run of a five-field cron expression in words, for the schedule. */
export function describeSchedule(cron: string, timezone: string): string {
  const parts = cron.trim().split(/\s+/);
  const minute = parts.at(0) ?? "";
  const hour = parts.at(1) ?? "";
  const rest = parts.slice(2);
  const daily = rest.every((part) => part === "*");
  if (daily && /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour)) {
    const hh = hour.padStart(2, "0");
    const mm = minute.padStart(2, "0");
    return `Every day at ${hh}:${mm} (${timezone})`;
  }
  return `On the schedule ${cron} (${timezone})`;
}
