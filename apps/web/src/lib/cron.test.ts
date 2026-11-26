// The cron reader of the schedules calendar: fields, names, steps, ranges,
// the six-field form, the day-of-month or day-of-week rule and the times.
import { describe, expect, it } from "vitest";
import {
  cronMatchesDay,
  cronMinGapMinutes,
  cronRunsPerDay,
  cronTimesOfDay,
  expandField,
  parseCron,
} from "./cron";

describe("expandField", () => {
  it("reads stars, steps, ranges, lists and names", () => {
    expect([...(expandField("*/15", 0, 59) ?? [])]).toEqual([0, 15, 30, 45]);
    expect([...(expandField("1-5", 0, 7) ?? [])]).toEqual([1, 2, 3, 4, 5]);
    expect([...(expandField("1-10/4", 1, 31) ?? [])]).toEqual([1, 5, 9]);
    expect([...(expandField("0,30", 0, 59) ?? [])]).toEqual([0, 30]);
    expect([
      ...(expandField("mon-fri", 0, 7, [
        "sun",
        "mon",
        "tue",
        "wed",
        "thu",
        "fri",
        "sat",
      ]) ?? []),
    ]).toEqual([1, 2, 3, 4, 5]);
    expect([
      ...(expandField(
        "jan,jul",
        1,
        12,
        ["jan", "feb", "mar", "apr", "may", "jun", "jul"],
        1,
      ) ?? []),
    ]).toEqual([1, 7]);
  });

  it("refuses values outside the field and garbage", () => {
    expect(expandField("61", 0, 59)).toBeNull();
    expect(expandField("5-2", 0, 59)).toBeNull();
    expect(expandField("a", 0, 59)).toBeNull();
    expect(expandField("*/0", 0, 59)).toBeNull();
    expect(expandField("", 0, 59)).toBeNull();
  });
});

describe("parseCron", () => {
  it("reads five fields and drops the seconds of six", () => {
    const daily = parseCron("0 4 * * *");
    expect(daily).not.toBeNull();
    expect([...(daily?.minutes ?? [])]).toEqual([0]);
    expect([...(daily?.hours ?? [])]).toEqual([4]);
    expect(daily?.daysRestricted).toBe(false);
    expect(daily?.weekdaysRestricted).toBe(false);
    const six = parseCron("30 0 4 * * *");
    expect([...(six?.minutes ?? [])]).toEqual([0]);
    expect([...(six?.hours ?? [])]).toEqual([4]);
  });

  it("answers null for anything else", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("0 4 * *")).toBeNull();
    expect(parseCron("0 25 * * *")).toBeNull();
    expect(parseCron("every day")).toBeNull();
  });

  it("reads 7 as Sunday", () => {
    const sunday = parseCron("0 4 * * 7");
    expect([...(sunday?.weekdays ?? [])]).toEqual([0]);
  });
});

describe("cronMatchesDay", () => {
  it("matches either the day of month or the weekday when both restrict", () => {
    const fields = parseCron("0 4 1 * mon");
    expect(fields).not.toBeNull();
    if (fields === null) return;
    // 1 November 2026 is a Sunday: the day of month matches.
    expect(cronMatchesDay(fields, 2026, 11, 1)).toBe(true);
    // 2 November 2026 is a Monday: the weekday matches.
    expect(cronMatchesDay(fields, 2026, 11, 2)).toBe(true);
    expect(cronMatchesDay(fields, 2026, 11, 3)).toBe(false);
  });

  it("follows the month and the weekday alone", () => {
    const weekends = parseCron("0 4 * * sat,sun");
    expect(weekends).not.toBeNull();
    if (weekends === null) return;
    expect(cronMatchesDay(weekends, 2026, 11, 28)).toBe(true);
    expect(cronMatchesDay(weekends, 2026, 11, 27)).toBe(false);
    const july = parseCron("0 4 * jul *");
    expect(july).not.toBeNull();
    if (july === null) return;
    expect(cronMatchesDay(july, 2026, 7, 10)).toBe(true);
    expect(cronMatchesDay(july, 2026, 11, 10)).toBe(false);
  });
});

describe("cronTimesOfDay", () => {
  it("lists the times sorted and counts the runs", () => {
    const fields = parseCron("30,0 5,4 * * *");
    expect(fields).not.toBeNull();
    if (fields === null) return;
    expect(cronTimesOfDay(fields)).toEqual([
      "04:00",
      "04:30",
      "05:00",
      "05:30",
    ]);
    expect(cronTimesOfDay(fields, 2)).toEqual(["04:00", "04:30"]);
    expect(cronRunsPerDay(fields)).toBe(4);
    const often = parseCron("* * * * *");
    expect(often).not.toBeNull();
    if (often === null) return;
    expect(cronRunsPerDay(often)).toBe(1440);
  });

  it("measures the shortest gap between runs, over midnight too", () => {
    const gapOf = (pattern: string) => {
      const fields = parseCron(pattern);
      return fields === null ? null : cronMinGapMinutes(fields);
    };
    expect(gapOf("0 4 * * *")).toBe(1440);
    expect(gapOf("*/5 * * * *")).toBe(5);
    expect(gapOf("* * * * *")).toBe(1);
    // 48 runs a day, yet a minute apart.
    expect(gapOf("0,1 * * * *")).toBe(1);
    // 23:59 and 00:00 are a minute apart across midnight.
    expect(gapOf("59,0 23,0 * * *")).toBe(1);
    expect(gapOf("0 0,12 * * *")).toBe(720);
  });
});
