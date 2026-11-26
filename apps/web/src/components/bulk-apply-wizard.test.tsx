// @vitest-environment jsdom
// The bulk apply wizard: the servers step, the drafts review with one server
// already holding the values, the hook choice, the apply and the
// partial-failure report; and the Free plan, where the first step carries
// the upgrade hint and goes nowhere.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "../api/schema";
import { entitlement, paidFromUi } from "../test/fixtures";
import {
  bodyOf,
  renderWithProviders,
  resetAfterEach,
  stubFetch,
  testQueryClient,
  withSession,
} from "../test/render";
import {
  BulkApplyWizard,
  bulkSelectable,
  resultWords,
  splitQuietChips,
} from "./bulk-apply-wizard";

afterEach(resetAfterEach);

function server(
  id: string,
  name: string,
  editable = true,
  access: "read" | "write" = "write",
): Server {
  return {
    id,
    name,
    packId: "palworld",
    displayName: "Palworld",
    os: "linux",
    connector: { kind: "local", root: `/srv/${id}` },
    hasPassword: false,
    demo: false,
    editable,
    access,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    lastEditedAt: null,
  };
}

const PRESET = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Weekend rates",
  description: "Double experience.",
  packId: "palworld",
  createdAt: "2026-11-23T12:00:00Z",
  values: { ExpRate: 2 },
};

function changeSet(id: string, serverId: string) {
  return {
    id,
    serverId,
    status: "draft",
    cause: "preset",
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
          settingKey: "ExpRate",
          label: "Experience rate",
          from: 1,
          to: 2,
          restartRequired: true,
        },
      ],
      text: [],
    },
    lint: [],
    conflict: null,
    error: null,
  };
}

describe("BulkApplyWizard", () => {
  it("walks servers, review, hooks and the partial-failure report", async () => {
    const bodies: unknown[] = [];
    stubFetch(([method, path], init) => {
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 200, body: paidFromUi() };
      }
      if (
        method === "POST" &&
        path === `/api/v1/presets/${PRESET.id}/bulk-drafts`
      ) {
        bodies.push(bodyOf(init));
        return {
          status: 200,
          body: {
            items: [
              {
                server: "home",
                changeSet: changeSet("cs-home", "home"),
                error: null,
              },
              {
                server: "away",
                changeSet: changeSet("cs-away", "away"),
                error: null,
              },
              { server: "far", changeSet: null, error: { code: "no_change" } },
            ],
          },
        };
      }
      if (method === "POST" && path === "/api/v1/presets/bulk-apply") {
        bodies.push(bodyOf(init));
        return {
          status: 200,
          body: {
            items: [
              {
                changeSetId: "cs-home",
                server: "home",
                status: "applied",
                error: null,
              },
              {
                changeSetId: "cs-away",
                server: "away",
                status: "refused",
                error: { code: "hook_not_configured" },
              },
            ],
            applied: 1,
            pending: 0,
            failed: 1,
          },
        };
      }
      return undefined;
    });
    const client = testQueryClient();
    withSession(client);
    renderWithProviders(
      <BulkApplyWizard
        preset={PRESET}
        servers={[
          server("home", "Home"),
          server("away", "Away"),
          server("far", "Far"),
        ]}
        onClose={() => undefined}
      />,
      client,
    );

    // Step one: every editable server starts chosen; Far is unticked here.
    const dialog = await screen.findByRole("dialog", {
      name: "Apply Weekend rates to many servers",
    });
    expect(
      within(dialog).getByText("Servers of Palworld (3 of 3 chosen)"),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(/Far/));
    expect(
      within(dialog).getByText("Servers of Palworld (2 of 3 chosen)"),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(/Far/));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Next: review the diffs" }),
    );

    // Step two: the drafts, one chip per server, Far already in place.
    await within(dialog).findByText(
      "2 of 3 servers have a change set ready. The chips show what each server's files will get.",
    );
    expect(bodies[0]).toEqual({ servers: ["home", "away", "far"] });
    expect(within(dialog).getAllByText("Experience rate: 1 → 2").length).toBe(
      2,
    );
    expect(within(dialog).getByText("Already holds these values")).toBeTruthy();
    expect(within(dialog).getAllByText("1 need a restart").length).toBe(2);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Next: hooks" }),
    );

    // Step three: the hook mode, then the apply of the two drafts.
    fireEvent.click(
      within(dialog).getByRole("radio", { name: /Save and restart/ }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Apply to 2 servers" }),
    );

    // Step four: the partial-failure report.
    await within(dialog).findByText("Partly applied");
    expect(bodies[1]).toEqual({
      changeSets: ["cs-home", "cs-away"],
      runHooks: "restart",
    });
    expect(
      within(dialog).getByText(
        "1 of 2 servers took the preset; 1 did not. The ones that failed keep their draft and the others are not rolled back.",
      ),
    ).toBeTruthy();
    const table = within(dialog).getByRole("table", {
      name: "Results by server",
    });
    expect(within(table).getByText("Applied")).toBeTruthy();
    expect(within(table).getByText("Refused")).toBeTruthy();
    expect(
      within(table).getByText("No hook can run this action on this server."),
    ).toBeTruthy();
    // The footer's Close and the dialog's own close control.
    expect(
      within(dialog).getAllByRole("button", { name: "Close" }).length,
    ).toBe(2);
  });

  it("carries the upgrade hint on Free and never asks for drafts", async () => {
    const seen: string[] = [];
    stubFetch(([method, path]) => {
      seen.push(`${method} ${path}`);
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 200, body: entitlement() };
      }
      return undefined;
    });
    const client = testQueryClient();
    withSession(client);
    renderWithProviders(
      <BulkApplyWizard
        preset={PRESET}
        servers={[server("home", "Home"), server("away", "Away")]}
        onClose={() => undefined}
      />,
      client,
    );
    await screen.findByText(
      "Applying presets to many servers at once is part of the Paid plan.",
    );
    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "Next: review the diffs",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
    expect(seen.some((call) => call.includes("bulk-drafts"))).toBe(false);
  });

  // P10-A L22 and P9 live check L2: a server this caller's grant only reads
  // cannot be chosen, and flags set to off where nothing was set are
  // counted in one line instead of one chip each.
  it("keeps a read-access server out and folds the quiet off flags of a review", async () => {
    stubFetch(([method, path]) => {
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 200, body: paidFromUi() };
      }
      if (
        method === "POST" &&
        path === `/api/v1/presets/${PRESET.id}/bulk-drafts`
      ) {
        const quiet = (key: string, label: string) => ({
          kind: "added",
          fileId: "launch",
          settingKey: key,
          label,
          from: null,
          to: false,
          restartRequired: false,
        });
        const draft = changeSet("cs-home", "home");
        return {
          status: 200,
          body: {
            items: [
              {
                server: "home",
                changeSet: {
                  ...draft,
                  diff: {
                    semantic: [
                      ...draft.diff.semantic,
                      quiet("Launch.PublicLobby", "Public lobby"),
                      quiet("Launch.UsePerfThreads", "Performance threads"),
                    ],
                    text: [],
                  },
                },
                error: null,
              },
            ],
          },
        };
      }
      return undefined;
    });
    const client = testQueryClient();
    withSession(client);
    renderWithProviders(
      <BulkApplyWizard
        preset={PRESET}
        servers={[server("home", "Home"), server("far", "Far", true, "read")]}
        onClose={() => undefined}
      />,
      client,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Apply Weekend rates to many servers",
    });
    expect(
      within(dialog).getByText("Servers of Palworld (1 of 2 chosen)"),
    ).toBeTruthy();
    const far = within(dialog).getByLabelText(/Far/) as HTMLInputElement;
    expect(far.disabled).toBe(true);
    expect(far.checked).toBe(false);
    expect(within(dialog).getByText("Read access")).toBeTruthy();
    // Choose all touches the selectable servers only.
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose all" }));
    expect(
      within(dialog).getByText("Servers of Palworld (1 of 2 chosen)"),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Next: review the diffs" }),
    );
    await within(dialog).findByText("Experience rate: 1 → 2");
    expect(within(dialog).queryByText(/Public lobby: set to off/)).toBeNull();
    expect(
      within(dialog).getByText("2 flags stay off (they were not set)"),
    ).toBeTruthy();
    expect(within(dialog).getByText("3 settings")).toBeTruthy();
  });

  it("decides which servers take a draft and which chips are quiet", () => {
    expect(bulkSelectable(server("a", "A"))).toBe(true);
    expect(bulkSelectable(server("a", "A", false))).toBe(false);
    expect(bulkSelectable(server("a", "A", true, "read"))).toBe(false);
    const { shown, quiet } = splitQuietChips([
      {
        kind: "added",
        fileId: "launch",
        settingKey: "Launch.PublicLobby",
        label: "Public lobby",
        from: null,
        to: false,
        restartRequired: false,
      },
      {
        kind: "added",
        fileId: "launch",
        settingKey: "Launch.Threads",
        label: "Threads",
        from: null,
        to: true,
        restartRequired: false,
      },
      {
        kind: "changed",
        fileId: "settings",
        settingKey: "ExpRate",
        label: "Experience rate",
        from: true,
        to: false,
        restartRequired: false,
      },
    ]);
    expect(quiet.map((chip) => chip.settingKey)).toEqual([
      "Launch.PublicLobby",
    ]);
    expect(shown.map((chip) => chip.settingKey)).toEqual([
      "Launch.Threads",
      "ExpRate",
    ]);
  });

  it("puts every result status into words", () => {
    expect(
      resultWords({
        changeSetId: "a",
        server: "s",
        status: "applied",
        error: null,
      }).word,
    ).toBe("Applied");
    expect(
      resultWords({
        changeSetId: "a",
        server: "s",
        status: "pending",
        error: null,
      }).kind,
    ).toBe("pending");
    expect(
      resultWords({
        changeSetId: "a",
        server: "s",
        status: "failed",
        error: { code: "connector_error" },
      }).detail,
    ).toBe("The server files could not be reached.");
    expect(
      resultWords({
        changeSetId: "a",
        server: null,
        status: "conflict",
        error: null,
      }).kind,
    ).toBe("error");
  });
});
