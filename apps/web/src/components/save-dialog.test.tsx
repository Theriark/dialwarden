// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSet, HooksView } from "../api/schema";
import { renderWithProviders, stubFetch, type Handler } from "../test/render";
import {
  canRestart,
  runHooksOf,
  SaveDialog,
  touchedFiles,
} from "./save-dialog";

afterEach(cleanup);

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "cs-1",
    serverId: "home",
    status: "draft",
    cause: "app",
    author: "owner@example.test",
    createdAt: "2026-11-23T12:00:00Z",
    updatedAt: "2026-11-23T12:00:00Z",
    appliedAt: null,
    restoreOf: null,
    diff: {
      semantic: [
        {
          kind: "changed",
          fileId: "settings",
          settingKey: "expRate",
          label: "Exp rate",
          from: 1,
          to: 2,
          restartRequired: true,
        },
        {
          kind: "added",
          fileId: "settings",
          settingKey: "adminPassword",
          label: "Admin password",
          from: null,
          to: "••••••",
          restartRequired: false,
        },
      ],
      text: [
        {
          fileId: "settings",
          unifiedDiff: [
            "@@ -1,2 +1,2 @@",
            " ExpRate=1",
            "-ExpRate=1",
            "+ExpRate=2",
          ].join("\n"),
        },
      ],
    },
    lint: [
      {
        fileId: "settings",
        settingKey: "expRate",
        code: "rule",
        severity: "warning",
        message: "A restart is needed for this file.",
        line: null,
        column: null,
        serverEvaluated: false,
      },
    ],
    conflict: null,
    error: null,
    ...overrides,
  };
}

function hooks(overrides: Partial<HooksView> = {}): HooksView {
  return {
    packId: "palworld",
    hooksSupported: ["save", "stop"],
    hook: null,
    probes: [],
    available: { save: null, stop: null, start: null, restart: null },
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

/** A world with a restart hook and a running server, plus the test's own. */
function stubWorld(extra?: Handler) {
  return stubFetch((route, init) => {
    const special = extra?.(route, init);
    if (special !== undefined) {
      return special;
    }
    const [method, path] = route;
    if (method === "GET" && path === "/api/v1/servers/home/hooks") {
      return {
        status: 200,
        body: hooks({
          available: {
            save: null,
            stop: "dockerProxy",
            start: "dockerProxy",
            restart: "dockerProxy",
          },
        }),
      };
    }
    if (method === "GET" && path === "/api/v1/servers/home/status") {
      return {
        status: 200,
        body: {
          state: "running",
          players: 0,
          source: "dockerProxy",
          at: "2026-11-23T12:00:00Z",
          pending: 0,
        },
      };
    }
    return { status: 404, body: { error: "not_found" } };
  });
}

function dialog(
  overrides: Partial<ChangeSet> = {},
  props: {
    onApplied?: (c: ChangeSet) => void;
    stoppedOnlyFiles?: string[];
  } = {},
) {
  return renderWithProviders(
    <SaveDialog
      slug="home"
      changeSet={changeSet(overrides)}
      stoppedOnlyFiles={props.stoppedOnlyFiles}
      onClose={() => {
        /* not used here */
      }}
      onApplied={
        props.onApplied ??
        (() => {
          /* not used here */
        })
      }
    />,
  );
}

describe("SaveDialog", () => {
  it("shows the chips, the restart warning, the lint and the diff file", () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    dialog();
    expect(screen.getByText("Exp rate: 1 → 2")).toBeTruthy();
    expect(screen.getByText("Admin password: set to ••••••")).toBeTruthy();
    expect(
      screen.getByText("1 setting needs a server restart to take effect."),
    ).toBeTruthy();
    expect(screen.getByText("A restart is needed for this file.")).toBeTruthy();
    expect(screen.getByText("settings")).toBeTruthy();
  });

  it("applies with Save only and invalidates the settings", async () => {
    const onApplied = vi.fn();
    const fetchMock = stubFetch(([method, path]) => {
      if (method === "POST" && path === "/api/v1/change-sets/cs-1/apply") {
        return {
          status: 200,
          body: changeSet({
            status: "applied",
            appliedAt: "2026-11-23T12:01:00Z",
          }),
        };
      }
      return { status: 404, body: { error: "not_found" } };
    });
    dialog({}, { onApplied });
    screen.getByRole("button", { name: "Save" }).click();
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) => item[1]?.method === "POST",
      );
      expect(call?.[0]).toBe("/api/v1/change-sets/cs-1/apply");
      expect(String(call?.[1]?.body)).toContain('"runHooks":"none"');
    });
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalled();
    });
  });

  it("keeps Save and restart off without a hook and points at the Hooks tab", async () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    dialog();
    const restart = screen.getByLabelText(
      /Save and restart/,
    ) as HTMLInputElement;
    expect(restart.disabled).toBe(true);
    expect(
      screen.getByText(/No hook can restart this server yet/),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("link", { name: "Set up a hook" }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/servers/home/hooks");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    });
  });

  it("sends restart for Save and restart on an any-time file", async () => {
    const fetchMock = stubWorld(([method, path]) => {
      if (method === "POST" && path === "/api/v1/change-sets/cs-1/apply") {
        return {
          status: 200,
          body: changeSet({
            status: "applied",
            appliedAt: "2026-11-23T12:01:00Z",
          }),
        };
      }
      return undefined;
    });
    dialog();
    const restart = await screen.findByLabelText(/Save and restart/);
    await waitFor(() => {
      expect((restart as HTMLInputElement).disabled).toBe(false);
    });
    fireEvent.click(restart);
    expect(screen.queryByText("Read at start only")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) => item[1]?.method === "POST",
      );
      expect(String(call?.[1]?.body)).toContain('"runHooks":"restart"');
    });
    await screen.findByRole("heading", { name: "Changes saved" });
  });

  it("sends stop-start for a stopped-only file and explains the pending answer", async () => {
    const fetchMock = stubWorld(([method, path]) => {
      if (method === "POST" && path === "/api/v1/change-sets/cs-1/apply") {
        return {
          status: 200,
          body: changeSet({ status: "pending" }),
        };
      }
      return undefined;
    });
    dialog({}, { stoppedOnlyFiles: ["settings"] });
    expect(screen.getByText("Read at start only")).toBeTruthy();
    await screen.findByText(/the change waits as pending/);
    const restart = await screen.findByLabelText(/Save and restart/);
    await waitFor(() => {
      expect((restart as HTMLInputElement).disabled).toBe(false);
    });
    expect(
      screen.getByText(
        "Stops the server, writes the files, then starts it again.",
      ),
    ).toBeTruthy();
    fireEvent.click(restart);
    fireEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) => item[1]?.method === "POST",
      );
      expect(String(call?.[1]?.body)).toContain('"runHooks":"stop-start"');
    });
    await screen.findByRole("heading", { name: "Saved as pending" });
  });

  it("explains a hook_not_configured refusal and keeps the dialog open", async () => {
    stubWorld(([method, path]) => {
      if (method === "POST" && path === "/api/v1/change-sets/cs-1/apply") {
        return {
          status: 409,
          body: { error: "hook_not_configured", action: "restart" },
        };
      }
      return undefined;
    });
    dialog();
    const restart = await screen.findByLabelText(/Save and restart/);
    await waitFor(() => {
      expect((restart as HTMLInputElement).disabled).toBe(false);
    });
    fireEvent.click(restart);
    fireEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    await screen.findByText(
      /No hook can restart this server yet, so nothing was written/,
    );
    expect(
      screen.getByRole("button", { name: "Save and restart" }),
    ).toBeTruthy();
  });

  it("explains a conflict and never offers apply", () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    dialog({
      status: "conflict",
      conflict: {
        files: [
          {
            kind: "settings",
            fileId: "settings",
            settings: [
              {
                settingKey: "expRate",
                label: "Exp rate",
                base: 1,
                ours: 2,
                theirs: 3,
              },
            ],
          },
        ],
      },
    });
    expect(
      screen.getByText("The file changed outside Dialwarden"),
    ).toBeTruthy();
    expect(screen.getByText(/On the server now: 3/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("turns into the failed view when the apply answers failed", async () => {
    const onApplied = vi.fn();
    stubFetch(([method, path]) => {
      if (method === "POST" && path === "/api/v1/change-sets/cs-1/apply") {
        return {
          status: 200,
          body: changeSet({
            status: "failed",
            error: {
              code: "write_failed",
              message: "The folder is read-only.",
            },
          }),
        };
      }
      return { status: 404, body: { error: "not_found" } };
    });
    dialog({}, { onApplied });
    expect(screen.getByText("Save these changes?")).toBeTruthy();
    screen.getByRole("button", { name: "Save" }).click();
    await waitFor(() => {
      expect(screen.getByText(/The last try failed/)).toBeTruthy();
    });
    // One sentence keeps one full stop: the server message already ends in
    // one (the live check saw a double full stop here).
    expect(
      screen.getByText(
        "The last try failed: The folder is read-only. A failed change set can be applied again.",
      ),
    ).toBeTruthy();
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("turns into the conflict view when the apply answers a conflict", async () => {
    const onApplied = vi.fn();
    stubFetch(([method, path]) => {
      if (method === "POST" && path === "/api/v1/change-sets/cs-1/apply") {
        return {
          status: 200,
          body: changeSet({
            status: "conflict",
            conflict: {
              files: [
                {
                  kind: "settings",
                  fileId: "settings",
                  settings: [
                    {
                      settingKey: "expRate",
                      label: "Exp rate",
                      base: 1,
                      ours: 2,
                      theirs: 3,
                    },
                  ],
                },
              ],
            },
          }),
        };
      }
      return { status: 404, body: { error: "not_found" } };
    });
    dialog({}, { onApplied });
    expect(screen.getByText("Save these changes?")).toBeTruthy();
    screen.getByRole("button", { name: "Save" }).click();
    await waitFor(() => {
      expect(screen.getByText(/On the server now: 3/)).toBeTruthy();
    });
    expect(screen.getByText("The save ended in a conflict")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("keeps the apply disabled while a blocking lint error is shown", () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    dialog({
      lint: [
        {
          fileId: "settings",
          settingKey: null,
          code: "syntax",
          severity: "error",
          message: "expected key=value, [section] or comment",
          line: 8,
          column: 1,
          serverEvaluated: false,
        },
      ],
    });
    const button = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("fix the errors first")).toBeTruthy();
  });

  it("keeps the apply enabled for an error on an untouched setting", () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    dialog({
      lint: [
        {
          fileId: "settings",
          settingKey: "someOtherKey",
          code: "validation",
          severity: "error",
          message: "A stored value this save does not touch.",
          line: null,
          column: null,
          serverEvaluated: false,
        },
      ],
    });
    const button = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("maps the choice to the C5 runHooks and reads the hooks view", () => {
    expect(runHooksOf("save", true)).toBe("none");
    expect(runHooksOf("restart", false)).toBe("restart");
    expect(runHooksOf("restart", true)).toBe("stop-start");
    expect(canRestart(undefined)).toBe(false);
    expect(canRestart(hooks())).toBe(false);
    expect(
      canRestart(
        hooks({
          available: { save: null, stop: "a", start: "a", restart: null },
        }),
      ),
    ).toBe(true);
    expect(touchedFiles(changeSet())).toEqual(["settings"]);
  });
});
