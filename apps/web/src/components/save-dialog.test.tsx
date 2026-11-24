// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSet } from "../api/schema";
import { renderWithProviders, stubFetch } from "../test/render";
import { SaveDialog } from "./save-dialog";

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

describe("SaveDialog", () => {
  it("shows the chips, the restart warning, the lint and the diff file", () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    renderWithProviders(
      <SaveDialog
        slug="home"
        changeSet={changeSet()}
        onClose={() => {
          /* not used here */
        }}
        onApplied={() => {
          /* not used here */
        }}
      />,
    );
    expect(screen.getByText("Exp rate: 1 → 2")).toBeTruthy();
    expect(screen.getByText("Admin password: set to ••••••")).toBeTruthy();
    expect(
      screen.getByText("1 setting needs a server restart to take effect."),
    ).toBeTruthy();
    expect(screen.getByText("A restart is needed for this file.")).toBeTruthy();
    expect(screen.getByText("settings")).toBeTruthy();
  });

  it("applies without a restart and invalidates the settings", async () => {
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
    renderWithProviders(
      <SaveDialog
        slug="home"
        changeSet={changeSet()}
        onClose={() => {
          /* not used here */
        }}
        onApplied={onApplied}
      />,
    );
    screen.getByRole("button", { name: "Save without restart" }).click();
    await waitFor(() => {
      const call = fetchMock.mock.calls.at(-1);
      expect(call?.[0]).toBe("/api/v1/change-sets/cs-1/apply");
      expect(String(call?.[1]?.body)).toContain('"runHooks":"none"');
    });
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalled();
    });
  });

  it("explains a conflict and never offers apply", () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    renderWithProviders(
      <SaveDialog
        slug="home"
        changeSet={changeSet({
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
        })}
        onClose={() => {
          /* not used here */
        }}
        onApplied={() => {
          /* not used here */
        }}
      />,
    );
    expect(
      screen.getByText("The file changed outside Dialwarden"),
    ).toBeTruthy();
    expect(screen.getByText(/On the server now: 3/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save without restart" }),
    ).toBeNull();
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
    renderWithProviders(
      <SaveDialog
        slug="home"
        changeSet={changeSet()}
        onClose={() => {
          /* not used here */
        }}
        onApplied={onApplied}
      />,
    );
    expect(screen.getByText("Save these changes?")).toBeTruthy();
    screen.getByRole("button", { name: "Save without restart" }).click();
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
    expect(
      screen.getByRole("button", { name: "Save without restart" }),
    ).toBeTruthy();
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
    renderWithProviders(
      <SaveDialog
        slug="home"
        changeSet={changeSet()}
        onClose={() => {
          /* not used here */
        }}
        onApplied={onApplied}
      />,
    );
    expect(screen.getByText("Save these changes?")).toBeTruthy();
    screen.getByRole("button", { name: "Save without restart" }).click();
    await waitFor(() => {
      expect(screen.getByText(/On the server now: 3/)).toBeTruthy();
    });
    expect(screen.getByText("The save ended in a conflict")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save without restart" }),
    ).toBeNull();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("keeps the apply disabled while a blocking lint error is shown", () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    renderWithProviders(
      <SaveDialog
        slug="home"
        changeSet={changeSet({
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
        })}
        onClose={() => {
          /* not used here */
        }}
        onApplied={() => {
          /* not used here */
        }}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Save without restart",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("fix the errors first")).toBeTruthy();
  });

  it("keeps the apply enabled for an error on an untouched setting", () => {
    stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    renderWithProviders(
      <SaveDialog
        slug="home"
        changeSet={changeSet({
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
        })}
        onClose={() => {
          /* not used here */
        }}
        onApplied={() => {
          /* not used here */
        }}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Save without restart",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
