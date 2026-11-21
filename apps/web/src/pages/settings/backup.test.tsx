// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupItem } from "../../api/schema";
import { backupItems, systemStatus } from "../../test/fixtures";
import {
  OWNER,
  renderWithProviders,
  stubFetch,
  testQueryClient,
  withSession,
  type Answer,
} from "../../test/render";
import { BackupPage } from "./backup";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function answers(items: BackupItem[] | "error") {
  const list: BackupItem[] = items === "error" ? [] : [...items];
  return stubFetch(([method, path]): Answer | undefined => {
    if (method === "GET" && path === "/api/v1/system/status") {
      return { status: 200, body: systemStatus };
    }
    if (method === "GET" && path === "/api/v1/system/backups") {
      if (items === "error") {
        return { status: 500, body: { error: "internal" } };
      }
      return { status: 200, body: { items: list } };
    }
    if (method === "POST" && path === "/api/v1/system/backups") {
      const fresh: BackupItem = {
        id: "20261121-1900",
        createdAt: "2026-11-21T19:00:00Z",
        sizeBytes: 3_145_728,
        blobCount: 14,
        appVersion: "27.0.0",
        integrity: "ok",
      };
      list.unshift(fresh);
      return { status: 201, body: fresh };
    }
    if (method === "POST" && path === "/api/v1/system/app-secret/acknowledge") {
      return { status: 204 };
    }
    return undefined;
  });
}

function renderBackups() {
  const client = testQueryClient();
  withSession(client);
  return renderWithProviders(<BackupPage />, client);
}

describe("BackupPage", () => {
  it("shows the schedule, the key banner and the empty state", async () => {
    answers([]);
    renderBackups();
    expect(screen.getAllByLabelText("Loading").length).toBeGreaterThan(0);
    await screen.findByText("No backups yet");
    expect(
      screen.getByText("Every day at 03:30 (Europe/Lisbon)"),
    ).toBeDefined();
    expect(screen.getByText("Back up the app secret key")).toBeDefined();
  });

  it("lists backups with time, size and integrity", async () => {
    answers(backupItems);
    renderBackups();
    const table = await screen.findByRole("table", { name: "Local backups" });
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBe(3);
    expect(within(table).getByText("21 Nov 2026, 03:30")).toBeDefined();
    expect(within(table).getByText("2.5 MB")).toBeDefined();
    expect(within(table).getByText("Verified")).toBeDefined();
    expect(within(table).getByText("Incomplete")).toBeDefined();
  });

  it("runs a backup now and shows the new row", async () => {
    answers([]);
    renderBackups();
    const user = userEvent.setup();
    await screen.findByText("No backups yet");
    await user.click(screen.getByRole("button", { name: "Run now" }));
    await screen.findByText("Backup done");
    await screen.findByText("21 Nov 2026, 19:00");
  });

  it("shows the error state with a retry when the list fails", async () => {
    answers("error");
    renderBackups();
    await screen.findByText("Something went wrong");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("tells a non-owner that backups are owner only", () => {
    answers([]);
    const client = testQueryClient();
    withSession(client, {
      ...OWNER,
      user: { ...OWNER.user, role: "viewer" },
    });
    renderWithProviders(<BackupPage />, client);
    expect(
      screen.getByText("Only the owner can see and run backups."),
    ).toBeDefined();
  });
});
