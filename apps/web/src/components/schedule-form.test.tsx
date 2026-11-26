// @vitest-environment jsdom
// The schedule form: the rules in words before anything is sent, the body
// the API takes for a run-at and a cron schedule, and the rendered form
// with a setting picked from the pack and typed with the editor's field.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Schedule, ScheduleInput, Server } from "../api/schema";
import {
  renderWithProviders,
  resetAfterEach,
  stubFetch,
  testQueryClient,
  withSession,
} from "../test/render";
import {
  emptyScheduleState,
  inputOfState,
  ScheduleForm,
  stateOfSchedule,
  validateScheduleForm,
  type ScheduleFormState,
} from "./schedule-form";

afterEach(resetAfterEach);

const NOW = new Date("2026-11-26T10:00:00Z");

function once(overrides: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    ...emptyScheduleState(),
    server: "home",
    name: "Weekend",
    mode: "once",
    runAtLocal: "2026-11-28T04:00",
    timezone: "Europe/Lisbon",
    edits: [{ settingKey: "ExpRate", value: 2 }],
    ...overrides,
  };
}

describe("validateScheduleForm", () => {
  it("passes a complete run-at schedule", () => {
    expect(validateScheduleForm(once(), NOW).size).toBe(0);
  });

  it("names every missing or wrong field", () => {
    const problems = validateScheduleForm(
      once({ server: "", name: " ", runAtLocal: "", edits: [] }),
      NOW,
    );
    expect(problems.get("server")).toBe(
      "Choose the server the schedule writes to.",
    );
    expect(problems.get("name")).toBe("Give the schedule a name.");
    expect(problems.get("runAt")).toBe("Pick the date and time of the run.");
    expect(problems.get("edits")).toBe("Add at least one setting to change.");
  });

  it("refuses a run in the past, a revert before the run and an unknown zone", () => {
    expect(
      validateScheduleForm(once({ runAtLocal: "2026-11-20T04:00" }), NOW).get(
        "runAt",
      ),
    ).toBe("The run time is in the past.");
    expect(
      validateScheduleForm(
        once({ revertAtLocal: "2026-11-28T03:00" }),
        NOW,
      ).get("revertAt"),
    ).toBe("The revert must come after the run.");
    expect(
      validateScheduleForm(once({ timezone: "Nowhere/Land" }), NOW).get(
        "timezone",
      ),
    ).toBe("The time zone is not known.");
  });

  it("checks a cron pattern and the revert delay", () => {
    const cron = once({ mode: "cron", runAtLocal: "", cron: "0 4 * * *" });
    expect(validateScheduleForm(cron, NOW).size).toBe(0);
    expect(validateScheduleForm({ ...cron, cron: "" }, NOW).get("cron")).toBe(
      "Enter a cron pattern, such as 0 4 * * *.",
    );
    expect(
      validateScheduleForm({ ...cron, cron: "nope" }, NOW).get("cron"),
    ).toBe("The pattern is not a five-field cron pattern.");
    expect(
      validateScheduleForm({ ...cron, cron: "* * * * *" }, NOW).get("cron"),
    ).toBe("A schedule runs at most every 5 minutes.");
    expect(
      validateScheduleForm({ ...cron, revertAfter: "20000" }, NOW).get(
        "revertAfterMinutes",
      ),
    ).toBe("The revert delay is 1 to 10080 minutes (one week).");
    expect(validateScheduleForm({ ...cron, revertAfter: "60" }, NOW).size).toBe(
      0,
    );
  });
});

describe("inputOfState", () => {
  it("sends a run-at schedule as instants in the zone", () => {
    expect(
      inputOfState(
        once({ revertAtLocal: "2026-11-28T06:00", runHooks: "restart" }),
      ),
    ).toEqual({
      server: "home",
      name: "Weekend",
      edits: [{ settingKey: "ExpRate", value: 2 }],
      runHooks: "restart",
      timezone: "Europe/Lisbon",
      runAt: "2026-11-28T04:00:00.000Z",
      revertAt: "2026-11-28T06:00:00.000Z",
    });
  });

  it("sends a cron schedule with its pattern and delay, never a run time", () => {
    const input = inputOfState(
      once({
        mode: "cron",
        cron: " 0 4 * * * ",
        revertAfter: "90",
        timezone: "UTC",
      }),
    );
    expect(input).toEqual({
      server: "home",
      name: "Weekend",
      edits: [{ settingKey: "ExpRate", value: 2 }],
      runHooks: "none",
      timezone: "UTC",
      cron: "0 4 * * *",
      revertAfterMinutes: 90,
    });
    expect("runAt" in input).toBe(false);
  });

  it("reads a stored schedule back into the form in its zone", () => {
    const stored: Schedule = {
      id: "s1",
      serverId: "home",
      name: "Nightly",
      author: "Owner",
      kind: "once",
      runAt: "2026-11-28T03:00:00.000Z",
      cron: null,
      timezone: "Europe/Berlin",
      revertAt: null,
      revertAfterMinutes: null,
      runHooks: "none",
      edits: [{ settingKey: "ExpRate", value: 3 }],
      state: "active",
      pausedReason: null,
      nextRunAt: "2026-11-28T03:00:00.000Z",
      revertDueAt: null,
      lastRunAt: null,
      lastResult: null,
      lastChangeSetId: null,
      lastRevertAt: null,
      lastRevertResult: null,
      createdAt: "2026-11-26T00:00:00Z",
      updatedAt: "2026-11-26T00:00:00Z",
    };
    const state = stateOfSchedule(stored);
    expect(state.runAtLocal).toBe("2026-11-28T04:00");
    expect(state.timezone).toBe("Europe/Berlin");
    expect(state.edits).toEqual([{ settingKey: "ExpRate", value: 3 }]);
  });
});

const HOME: Server = {
  id: "home",
  name: "Home",
  packId: "testpack",
  displayName: "Test Pack",
  os: "linux",
  connector: { kind: "local", root: "/srv/home" },
  hasPassword: false,
  demo: false,
  editable: true,
  createdAt: "2026-11-23T00:00:00Z",
  updatedAt: "2026-11-23T00:00:00Z",
  lastEditedAt: null,
};

describe("ScheduleForm", () => {
  it("picks a setting from the pack, types it and submits the body", async () => {
    stubFetch(([method, path]) => {
      if (method === "GET" && path === "/api/v1/servers/home/settings") {
        return {
          status: 200,
          body: {
            serverId: "home",
            packId: "testpack",
            packVersion: "1.0.0",
            editable: true,
            files: [],
            values: { expRate: 1 },
            lint: [],
          },
        };
      }
      if (method === "GET" && path === "/api/v1/games/testpack/settings-meta") {
        return {
          status: 200,
          body: {
            id: "testpack",
            version: "1.0.0",
            displayName: "Test Pack",
            steamAppId: 1,
            os: ["linux"],
            files: [
              {
                id: "settings",
                paths: { linux: ["s.ini"] },
                adapter: "ini",
                encoding: "utf-8",
                applyPolicy: "anytime",
              },
            ],
            settings: [
              {
                key: "expRate",
                label: "Exp rate",
                file: "settings",
                locator: { section: "a", key: "ExpRate" },
                type: "float",
                min: 0.1,
                max: 20,
                group: "Rates",
                description:
                  "How fast experience is gained by everyone on the server.",
                restartRequired: true,
              },
            ],
            rules: [],
            presets: [],
            hooksSupported: [],
            sources: [],
          },
        };
      }
      return undefined;
    });
    const sent: ScheduleInput[] = [];
    const client = testQueryClient();
    withSession(client);
    renderWithProviders(
      <ScheduleForm
        servers={[HOME]}
        pending={false}
        onSubmit={(input) => {
          sent.push(input);
        }}
        onCancel={() => undefined}
      />,
      client,
    );

    // An empty submit says what is missing, in words, inline.
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    expect(
      await screen.findByText("Choose the server the schedule writes to."),
    ).toBeTruthy();
    expect(screen.getByText("Give the schedule a name.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Server"), {
      target: { value: "home" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Weekend" },
    });
    fireEvent.change(screen.getByLabelText("Run at"), {
      target: { value: "2099-01-01T04:00" },
    });
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "UTC" },
    });

    const add = (await screen.findByLabelText(
      "Add a setting",
    )) as HTMLSelectElement;
    expect(add.options[1]?.textContent).toBe("Exp rate (Rates)");
    fireEvent.change(add, { target: { value: "expRate" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const field = (await screen.findByLabelText(
      "Exp rate",
    )) as HTMLInputElement;
    expect(field.value).toBe("1");
    fireEvent.change(field, { target: { value: "2" } });
    expect(screen.getByText("Exp rate: 1 → 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => {
      expect(sent.length).toBe(1);
    });
    expect(sent[0]).toEqual({
      server: "home",
      name: "Weekend",
      edits: [{ settingKey: "expRate", value: 2 }],
      runHooks: "none",
      timezone: "UTC",
      runAt: "2099-01-01T04:00:00.000Z",
    });
  });
});
