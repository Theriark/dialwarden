import { describe, expect, it } from "vitest";
import {
  daysUntil,
  describeSchedule,
  formatBytes,
  formatDate,
  formatDateTime,
  initials,
} from "./format";

describe("format helpers", () => {
  it("formats sizes with a unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("—");
  });

  it("formats dates in Europe/Lisbon and tolerates bad input", () => {
    expect(formatDateTime("2026-11-21T18:30:00Z")).toBe("21 Nov 2026, 18:30");
    expect(formatDate("2026-12-31")).toBe("31 Dec 2026");
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime("not a date")).toBe("not a date");
  });

  it("counts the days until the end of a date", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    expect(daysUntil("2026-12-21", now)).toBe(31);
    expect(daysUntil("2026-11-21", now)).toBe(1);
    expect(daysUntil("2026-11-01", now)).toBeLessThan(0);
  });

  it("builds initials and describes the backup schedule", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("owner")).toBe("O");
    expect(initials("  ")).toBe("?");
    expect(describeSchedule("30 3 * * *", "Europe/Lisbon")).toBe(
      "Every day at 03:30 (Europe/Lisbon)",
    );
    expect(describeSchedule("*/15 * * * *", "UTC")).toBe(
      "On the schedule */15 * * * * (UTC)",
    );
  });
});
