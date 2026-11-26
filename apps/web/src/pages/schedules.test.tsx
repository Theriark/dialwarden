// @vitest-environment jsdom
// The schedules page: every state in words and a badge, the chips with the
// pack's labels (P9 live check L3), the week tile that counts reverts too
// (L5), the calendar with the day list, the delete and replace flows (a
// replace whose old schedule is already gone is a clean replace, P9-C
// review R1), the viewer's read-only sentence, the editor whose grant on
// the server only reads (P10-A L22) and the Free plan with the upgrade hint.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SECRET_MASK } from "@dialwarden/packs-schema";
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
import {
  chipsOf,
  dueWithinWeek,
  scheduleStateWords,
  whenWords,
} from "./schedules";

afterEach(resetAfterEach);

function serverItem(access: "read" | "write") {
  return {
    id: "home",
    name: "Home",
    packId: "palworld",
    displayName: "Palworld",
    os: "linux",
    connector: { kind: "local", root: "/srv/home" },
    hasPassword: false,
    demo: false,
    editable: true,
    access,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    lastEditedAt: null,
  };
}

const SERVERS = { items: [serverItem("write")] };

/** The Palworld pack as the list needs it: labels for the chips. */
const META = {
  id: "palworld",
  version: "1.0",
  displayName: "Palworld",
  steamAppId: 1,
  os: ["linux"],
  files: [
    {
      id: "settings",
      paths: { linux: ["PalWorldSettings.ini"] },
      adapter: "ini",
      encoding: "utf-8",
      applyPolicy: "anytime",
    },
  ],
  settings: [
    {
      key: "ExpRate",
      label: "Experience rate",
      file: "settings",
      locator: { kind: "ini", section: null, key: "ExpRate" },
      type: "float",
      description: "How fast the experience grows.",
      restartRequired: true,
    },
    {
      key: "AdminPassword",
      label: "Admin password",
      file: "settings",
      locator: { kind: "ini", section: null, key: "AdminPassword" },
      type: "string",
      secret: true,
      description: "Who may administer the server.",
    },
  ],
  rules: [],
  presets: [],
  hooksSupported: [],
  sources: [],
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
    if (method === "GET" && path === "/api/v1/games/palworld/settings-meta") {
      return { status: 200, body: META };
    }
    if (method === "DELETE" && path.startsWith("/api/v1/schedules/")) {
      return { status: 204 };
    }
    return undefined;
  });
  return calls;
}

describe("SchedulesPage", () => {
  it("lists every schedule with its state, when it runs and the pack's labels", async () => {
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
    // The chips carry the pack's label once its meta answered (L3), with
    // the restart marker the pack declares.
    expect(
      (await screen.findAllByText("Experience rate: set to 2")).length,
    ).toBe(6);
    expect(screen.queryByText("ExpRate: set to 2")).toBeNull();
    expect(screen.getAllByText("Restart required").length).toBe(6);
    expect(screen.getByRole("grid", { name: /Schedules in/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New schedule" })).toBeTruthy();
  });

  it("counts a revert due this week in the week tile (L5)", async () => {
    stubViewport(1440);
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    stubWorld(([method, path]) => {
      if (method === "GET" && path === "/api/v1/schedules") {
        return {
          status: 200,
          body: {
            items: [
              // Ran, its revert is due in two days: a run is not due, the
              // revert is.
              schedule({
                name: "Ran, reverting",
                nextRunAt: null,
                lastRunAt: "2026-11-20T04:00:00.000Z",
                lastResult: "applied",
                revertAt: soon,
                revertDueAt: soon,
              }),
            ],
          },
        };
      }
      return undefined;
    });
    startRouter("/schedules");
    await screen.findByText("Ran, reverting");
    const tile = screen.getByText("Next 7 days").closest("div");
    expect(tile).not.toBeNull();
    if (tile === null) return;
    expect(within(tile).getByText("1")).toBeTruthy();
    expect(
      within(tile).getByText("Runs and reverts due this week"),
    ).toBeTruthy();
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

  it("closes the replace form and warns when the old schedule was not removed", async () => {
    stubViewport(1440);
    const calls = stubWorld(([method, path]) => {
      if (method === "POST" && path === "/api/v1/schedules") {
        return {
          status: 201,
          body: schedule({ name: "Weekend rates", id: "s-new" }),
        };
      }
      if (method === "DELETE" && path === "/api/v1/schedules/s-weekend-rates") {
        return { status: 500, body: { error: "internal" } };
      }
      return undefined;
    });
    startRouter("/schedules");
    await screen.findByText("Weekend rates");

    const row = screen.getByText("Weekend rates").closest("li");
    expect(row).not.toBeNull();
    if (row === null) return;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const form = await screen.findByRole("form", { name: "Replace schedule" });
    fireEvent.click(
      within(form).getByRole("button", { name: "Replace schedule" }),
    );
    // The new one exists; the dialog closes so a second Replace cannot make
    // a third copy, and the toast says the old one must go by hand.
    await screen.findByText("Schedule created, but the old one is still there");
    expect(
      screen.getByText(
        /was not removed \(The server hit an error\. Check its log\.\)/,
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.queryByRole("form", { name: "Replace schedule" }),
      ).toBeNull();
    });
    // The list is asked for again after the half-done replace.
    expect(
      calls.filter((call) => call === "GET /api/v1/schedules").length,
    ).toBeGreaterThan(1);
  });

  it("treats an old schedule that is already gone as replaced (R1)", async () => {
    stubViewport(1440);
    stubWorld(([method, path]) => {
      if (method === "POST" && path === "/api/v1/schedules") {
        return {
          status: 201,
          body: schedule({ name: "Weekend rates", id: "s-new" }),
        };
      }
      if (method === "DELETE" && path === "/api/v1/schedules/s-weekend-rates") {
        return { status: 404, body: { error: "schedule_not_found" } };
      }
      return undefined;
    });
    startRouter("/schedules");
    await screen.findByText("Weekend rates");

    const row = screen.getByText("Weekend rates").closest("li");
    expect(row).not.toBeNull();
    if (row === null) return;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const form = await screen.findByRole("form", { name: "Replace schedule" });
    fireEvent.click(
      within(form).getByRole("button", { name: "Replace schedule" }),
    );
    await screen.findByText("Schedule replaced");
    expect(screen.queryByText(/old one is still there/)).toBeNull();
  });

  it("keeps an editor whose grant only reads the server out of the controls (L22)", async () => {
    stubViewport(1440);
    stubWorld(([method, path]) => {
      if (method === "GET" && path === "/api/v1/auth/session") {
        return {
          status: 200,
          body: { ...OWNER, user: { ...OWNER.user, role: "editor" } },
        };
      }
      if (method === "GET" && path === "/api/v1/servers") {
        return { status: 200, body: { items: [serverItem("read")] } };
      }
      return undefined;
    });
    startRouter("/schedules");
    await screen.findByText("Weekend rates");
    expect(
      screen.getByText(
        /You are signed in as editor with read access to this server/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New schedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
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

  it("labels the chips from the pack and masks a secret edit", () => {
    const stored = schedule({
      name: "Private",
      edits: [
        { settingKey: "ExpRate", value: 2 },
        { settingKey: "AdminPassword", value: SECRET_MASK },
        { settingKey: "Unknown.Key", value: "x" },
      ],
    });
    const byKey = new Map(
      META.settings.map((setting) => [setting.key, setting] as const),
    );
    const chips = chipsOf(stored, byKey as never);
    expect(chips.map((chip) => [chip.kind, chip.label, chip.to])).toEqual([
      ["changed", "Experience rate", 2],
      ["masked", "Admin password", SECRET_MASK],
      ["changed", "Unknown.Key", "x"],
    ]);
    expect(chips[0]?.restartRequired).toBe(true);
    // Without the pack (meta not loaded yet) the keys stand in.
    expect(chipsOf(stored).map((chip) => chip.label)).toEqual([
      "ExpRate",
      "AdminPassword",
      "Unknown.Key",
    ]);
    expect(chipsOf(stored)[1]?.kind).toBe("masked");
  });

  it("counts a run or a revert due within a week, on an active schedule only", () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const at = (days: number) => new Date(now + days * day).toISOString();
    expect(dueWithinWeek(schedule({ nextRunAt: at(2) }), now)).toBe(true);
    expect(dueWithinWeek(schedule({ nextRunAt: at(9) }), now)).toBe(false);
    expect(
      dueWithinWeek(schedule({ nextRunAt: null, revertDueAt: at(3) }), now),
    ).toBe(true);
    expect(
      dueWithinWeek(
        schedule({ state: "paused", nextRunAt: at(1), revertDueAt: at(1) }),
        now,
      ),
    ).toBe(false);
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
