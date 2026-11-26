// The zone helpers of the schedules: a wall clock in a zone becomes the
// right instant in winter and in summer, and back.
import { describe, expect, it } from "vitest";
import {
  dayKeyOf,
  isoOfLocalInput,
  isTimeZone,
  localInputValue,
  timeOfDayOf,
  timeZoneOptions,
  wallClockOf,
} from "./time";

describe("isoOfLocalInput", () => {
  it("reads a wall clock in its zone, winter and summer", () => {
    expect(isoOfLocalInput("2026-11-27T04:00", "Europe/Lisbon")).toBe(
      "2026-11-27T04:00:00.000Z",
    );
    expect(isoOfLocalInput("2026-11-27T04:00", "Europe/Berlin")).toBe(
      "2026-11-27T03:00:00.000Z",
    );
    expect(isoOfLocalInput("2026-07-01T04:00", "Europe/Lisbon")).toBe(
      "2026-07-01T03:00:00.000Z",
    );
    expect(isoOfLocalInput("2026-07-01T04:00", "America/New_York")).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    expect(isoOfLocalInput("2026-07-01T04:00", "UTC")).toBe(
      "2026-07-01T04:00:00.000Z",
    );
  });

  it("answers null for an incomplete value", () => {
    expect(isoOfLocalInput("", "UTC")).toBeNull();
    expect(isoOfLocalInput("2026-07-01", "UTC")).toBeNull();
  });
});

describe("localInputValue and the day key", () => {
  it("round-trips an instant through a zone", () => {
    const iso = "2026-07-01T08:00:00.000Z";
    expect(localInputValue(iso, "America/New_York")).toBe("2026-07-01T04:00");
    expect(isoOfLocalInput("2026-07-01T04:00", "America/New_York")).toBe(iso);
    expect(localInputValue("garbage", "UTC")).toBe("");
  });

  it("gives the calendar day and the time in the display zone", () => {
    const late = new Date("2026-11-26T23:30:00Z");
    expect(dayKeyOf(late)).toBe("2026-11-26");
    expect(dayKeyOf(late, "Europe/Berlin")).toBe("2026-11-27");
    expect(timeOfDayOf(late)).toBe("23:30");
    expect(wallClockOf(late, "Europe/Berlin")).toEqual({
      year: 2026,
      month: 11,
      day: 27,
      hour: 0,
      minute: 30,
    });
  });
});

describe("time zones", () => {
  it("knows a real zone and refuses an invented one", () => {
    expect(isTimeZone("Europe/Lisbon")).toBe(true);
    expect(isTimeZone("Nowhere/Land")).toBe(false);
    const options = timeZoneOptions();
    expect(options[0]).toBe("UTC");
    expect(options).toContain("Europe/Lisbon");
  });
});
