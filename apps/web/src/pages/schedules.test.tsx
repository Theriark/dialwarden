// @vitest-environment jsdom
// The schedules page: every state in words and a badge, the calendar with
// the day list, the delete flow, the viewer's read-only sentence and the
// Free plan with the upgrade hint.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Schedule } from "../api/schema";
import { calendarItemsOf } from "../components/schedule-calendar";
import { entitlement, OWNER } from "../test/fixtures";
import {
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";
import { scheduleStateWords, whenWords } from "./schedules";

afterEach(resetAfterEach);

const SERVERS = {
  items: [
    {
      id: "home",
      name: "Home",
      packId: "palworld",
      displayName: "Palworld",
      os: "linux",
      connector: { kind: "local", root: "/srv/home" },
      hasPassword: false,
      demo: false,
      editable: true,
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      lastEditedAt: null,
    },
  ],
};

function schedule(overrides: Partial<Schedule>): Schedule {
  return {
    id: "s-" + (overrides.name ?? "x").toLowerCase().replace(/\s+/g, "-"),
    serverId: "home",
    name: "Schedule",
    author: "Owner Person",
    kind: "once",
    runAt: "2099-11-28T04:00:00.000Z",
    cron: null,
    timezone: "Europe/Lisbon",
    revertAt: null,
    revertAfterMinutes: null,
    runHooks: "none",
    edits: [{ settingKey: "ExpRate", value: 2 }],
    state: "active",
    pausedReason: null,
    nextRunAt: "2099-11-28T04:00:00.000Z",
    revertDueAt: null,
    lastRunAt: null,
    lastResult: null,
    lastChangeSetId: null,
    lastRevertAt: null,
    lastRevertResult: null,
    createdAt: "2026-11-26T00:00:00Z",
    updatedAt: "2026-11-26T00:00:00Z",
    ...overrides,
  };
}

const ALL: Schedule[] = [
  schedule({ name: "Weekend rates" }),
  schedule({
    name: "Paused one",
    state: "paused",
    pausedReason: "paid",
  }),
  schedule({
    name: "Missed one",
    state: "missed",
    nextRunAt: null,
    lastRunAt: "2026-11-20T04:00:00.000Z",
    lastResult: "missed",
  }),
  schedule({
    name: "Done one",
    state: "done",
    nextRunAt: null,
    lastRunAt: "2026-11-21T04:00:00.000Z",
    lastResult: "applied",
    lastChangeSetId: "cs-1",
  }),
  schedule({
    name: "Reverted one",
    state: "done",
    nextRunAt: null,
    revertAt: "2026-11-22T06:00:00.000Z",
    lastRunAt: "2026-11-22T04:00:00.000Z",
    lastResult: "applied",
    lastRevertAt: "2026-11-22T06:00:00.000Z",
    lastRevertResult: "applied",
  }),
  schedule({
    name: "Nightly",
    kind: "cron",
    runAt: null,
    cron: "0 4 * * *",
    revertAfterMinutes: 60,
    nextRunAt: "2026-11-27T04:00:00.000Z",
  }),
];

function stubWorld(extra?: Handler) {
  const calls: string[] = [];
  stubFetch((route, init) => {
    const special = extra?.(route, init);
    if (special !== undefined) {
      return special;
    }
    const [method, path] = route;
    calls.push(`${method} ${path}`);
    if (method === "GET" && path === "/api/v1/setup") {
      return { status: 200, body: { required: false } };
    }
    if (method === "GET" && path === "/api/v1/auth/session") {
      return { status: 200, body: OWNER };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: entitlement() };
    }
    if (method === "GET" && path === "/api/v1/servers") {
      return { status: 200, body: SERVERS };
    }
    if (method === "GET" && path === "/api/v1/schedules") {
      return { status: 200, body: { items: ALL } };
    }
    if (method === "DELETE" && path.startsWith("/api/v1/schedules/")) {
      return { status: 204 };
    }
    return undefined;
  });
  return calls;
}

describe("SchedulesPage", () => {
  it("lists every schedule with its state and when it runs", async () => {
    stubViewport(1440);
    stubWorld();
    startRouter("/schedules");

    await screen.findByText("Weekend rates");
    // Two badges and the calendar legend.
    expect(screen.getAllByText("Scheduled", { exact: true }).length).toBe(3);
    expect(screen.getByText("Paused on Free")).toBeTruthy();
    // One badge each, plus the calendar legend.
    expect(screen.getAllByText("Missed", { exact: true }).length).toBe(2);
    expect(screen.getAllByText("Ran", { exact: true }).length).toBe(2);
    expect(screen.getAllByText("Reverted", { exact: true }).length).toBe(2);
    expect(screen.getByText("Every day at 04:00 (Europe/Lisbon)")).toBeTruthy();
    expect(screen.getAllByText("ExpRate: set to 2").length).toBe(6);
    expect(screen.getByRole("grid", { name: /Schedules in/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New schedule" })).toBeTruthy();
  });

  it("deletes a schedule after the confirm dialog", async () => {
    stubViewport(1440);
    const calls = stubWorld();
    startRouter("/schedules");
    await screen.findByText("Weekend rates");

    const row = screen.getByText("Weekend rates").closest("li");
    expect(row).not.toBeNull();
    if (row === null) return;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete Weekend rates?",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(calls).toContain("DELETE /api/v1/schedules/s-weekend-rates");
    });
    await screen.findByText("Schedule deleted");
  });

  it("renders the upgrade hint and the paused explanation on Free", async () => {
    stubViewport(1440);
    stubWorld(([method, path]) => {
      if (method === "GET" && path === "/api/v1/schedules") {
        return {
          status: 402,
          body: {
            error: "payment_required",
            plan: "free",
            feature: "schedules",
          },
        };
      }
      return undefined;
    });
    startRouter("/schedules");
    await screen.findByText("Scheduled changes is part of the Paid plan.");
    expect(screen.getByText("Paused on the Free plan")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New schedule" })).toBeNull();
  });

  it("reads only for a viewer", async () => {
    stubViewport(1440);
    stubWorld(([method, path]) => {
      if (method === "GET" && path === "/api/v1/auth/session") {
        return {
          status: 200,
          body: { ...OWNER, user: { ...OWNER.user, role: "viewer" } },
        };
      }
      return undefined;
    });
    startRouter("/schedules");
    await screen.findByText("Weekend rates");
    expect(screen.getByText(/You are signed in as viewer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New schedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("words the states and places the calendar items", () => {
    expect(scheduleStateWords(ALL[0] as Schedule).word).toBe("Scheduled");
    expect(scheduleStateWords(ALL[1] as Schedule).word).toBe("Paused on Free");
    expect(scheduleStateWords(ALL[2] as Schedule).word).toBe("Missed");
    expect(scheduleStateWords(ALL[3] as Schedule).word).toBe("Ran");
    expect(scheduleStateWords(ALL[4] as Schedule).word).toBe("Reverted");
    expect(whenWords(ALL[5] as Schedule)).toBe(
      "Every day at 04:00 (Europe/Lisbon)",
    );
    const items = calendarItemsOf(ALL, { year: 2026, month: 11 });
    const kinds = items.map((item) => `${item.day} ${item.kind}`);
    expect(kinds).toContain("2026-11-20 missed");
    expect(kinds).toContain("2026-11-21 ran");
    expect(kinds).toContain("2026-11-22 reverted");
    expect(kinds).toContain("2026-11-27 run");
    // The cron pattern is projected on the days after its next run.
    expect(kinds).toContain("2026-11-28 projected");
    expect(kinds).toContain("2026-11-30 projected");
    expect(kinds).not.toContain("2026-11-27 projected");
  });
});
