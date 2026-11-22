// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupItem, DrillReport, SystemStatus } from "../../api/schema";
import { downloadBlob } from "../../lib/download";
import { backupItems, systemStatus } from "../../test/fixtures";
import {
  bodyOf,
  headerOf,
  OWNER,
  renderWithProviders,
  resetAfterEach,
  stubFetch,
  stubViewport,
  testQueryClient,
  withSession,
  type Answer,
} from "../../test/render";
import { BackupPage, countPairs } from "./backup";

// The browser download is a side effect on the document; the test checks
// what is handed to it.
vi.mock("../../lib/download", () => ({ downloadBlob: vi.fn() }));

afterEach(resetAfterEach);

const FRESH: BackupItem = {
  id: "20261121-1900",
  createdAt: "2026-11-21T19:00:00Z",
  sizeBytes: 3_145_728,
  blobCount: 14,
  appVersion: "27.0.0",
  integrity: "ok",
};

const DRILL_PATH = "/api/v1/system/backups/20261121-0330/drill";

/** The row counts detail exactly as the engine sends it: JSON, no spaces. */
const ROW_COUNTS =
  '{"users":1,"servers":0,"change_sets":0,"audit_events":5,"snapshots":null}';

const DRILL: DrillReport = {
  backupId: "20261121-0330",
  startedAt: "2026-11-21T19:05:00Z",
  durationMs: 1200,
  ok: false,
  checks: [
    { name: "restore", ok: true, detail: "restored into a temporary folder" },
    { name: "row counts", ok: true, detail: ROW_COUNTS },
    { name: "owner", ok: false, detail: "no owner account in the copy" },
  ],
};

interface World {
  status: SystemStatus;
  items: BackupItem[] | "error";
  requests: { method: string; path: string; init: RequestInit }[];
}

type Extra = (method: string, path: string) => Answer | undefined;

function answers(world: World, extra?: Extra) {
  return stubFetch(([method, path], init): Answer | undefined => {
    world.requests.push({ method, path, init });
    const special = extra?.(method, path);
    if (special !== undefined) {
      return special;
    }
    if (method === "GET" && path === "/api/v1/system/status") {
      return { status: 200, body: world.status };
    }
    if (method === "GET" && path === "/api/v1/system/backups") {
      if (world.items === "error") {
        return { status: 500, body: { error: "internal" } };
      }
      return { status: 200, body: { items: world.items } };
    }
    if (method === "POST" && path === "/api/v1/system/backups") {
      if (world.items !== "error") {
        world.items = [FRESH, ...world.items];
      }
      return { status: 201, body: FRESH };
    }
    if (method === "POST" && path === "/api/v1/system/app-secret/acknowledge") {
      world.status = {
        ...world.status,
        appSecret: {
          ...world.status.appSecret,
          backupAcknowledged: true,
          showBackupBanner: false,
        },
      };
      return { status: 204 };
    }
    if (method === "POST" && path === DRILL_PATH) {
      return { status: 200, body: DRILL };
    }
    return undefined;
  });
}

function world(items: BackupItem[] | "error" = []): World {
  return { status: systemStatus, items, requests: [] };
}

/** The page at a window width: the table from 1280 up, cards below. */
function renderBackups(session = OWNER, width = 1440) {
  stubViewport(width);
  const client = testQueryClient();
  withSession(client, session);
  return renderWithProviders(<BackupPage />, client);
}

const backupList = () => screen.findByRole("list", { name: "Local backups" });

describe("BackupPage", () => {
  it("shows the schedule, the key banner and the empty state", async () => {
    answers(world());
    renderBackups();
    expect(screen.getAllByLabelText("Loading").length).toBeGreaterThan(0);
    await screen.findByText("No backups yet");
    expect(
      screen.getByText("Every day at 03:30 (Europe/Lisbon)"),
    ).toBeDefined();
    expect(screen.getByText("Back up the app secret key")).toBeDefined();
    expect(screen.getByText("Idle")).toBeDefined();
  });

  it("lists backups with time, size and integrity", async () => {
    answers(world(backupItems));
    renderBackups();
    const table = await screen.findByRole("table", { name: "Local backups" });
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBe(3);
    expect(within(table).getByText("21 Nov 2026, 03:30")).toBeDefined();
    expect(within(table).getByText("2.5 MB")).toBeDefined();
    expect(within(table).getByText("Verified")).toBeDefined();
    expect(within(table).getByText("Incomplete")).toBeDefined();
    const checks = within(table).getAllByRole<HTMLButtonElement>("button", {
      name: "Check",
    });
    expect(checks.map((button) => button.disabled)).toEqual([false, true]);
    expect(screen.queryByRole("list", { name: "Local backups" })).toBeNull();
  });

  it("stacks each backup as a card at 390 with a 44 px drill button", async () => {
    answers(world(backupItems));
    renderBackups(OWNER, 390);
    const list = await backupList();
    expect(screen.queryByRole("table")).toBeNull();
    const cards = within(list).getAllByRole("listitem");
    expect(cards.length).toBe(2);
    const [first, second] = cards;
    if (first === undefined || second === undefined) {
      throw new Error("two cards expected");
    }
    // The date and time stay one line: a single text node, never wrapped by
    // the markup, with the nowrap class the walk asked for.
    const taken = within(first).getByText("21 Nov 2026, 03:30");
    expect(taken.className).toContain("whitespace-nowrap");
    expect(within(first).getByText("2.5 MB")).toBeDefined();
    expect(within(first).getByText("12")).toBeDefined();
    expect(within(first).getByText("27.0.0")).toBeDefined();
    expect(within(first).getByText("Verified")).toBeDefined();
    expect(within(second).getByText("20 Nov 2026, 03:30")).toBeDefined();
    expect(within(second).getByText("Incomplete")).toBeDefined();
    const drills = within(list).getAllByRole<HTMLButtonElement>("button", {
      name: "Restore drill",
    });
    expect(drills.map((button) => button.disabled)).toEqual([false, true]);
    for (const button of drills) {
      expect(button.className).toContain("min-h-11");
    }
    expect(within(list).queryByRole("button", { name: "Check" })).toBeNull();
  });

  it("keeps the cards at 768 and the table from 1280 up", async () => {
    answers(world(backupItems));
    renderBackups(OWNER, 768);
    await backupList();
    expect(screen.queryByRole("table")).toBeNull();

    resetAfterEach();
    answers(world(backupItems));
    renderBackups(OWNER, 1280);
    await screen.findByRole("table", { name: "Local backups" });
    expect(screen.queryByRole("list", { name: "Local backups" })).toBeNull();
  });

  it("runs the drill from a card and shows the report", async () => {
    answers(world(backupItems));
    renderBackups(OWNER, 390);
    const user = userEvent.setup();
    const list = await backupList();
    const [drill] = within(list).getAllByRole("button", {
      name: "Restore drill",
    });
    if (drill === undefined) {
      throw new Error("no Restore drill button");
    }
    await user.click(drill);
    const dialog = await screen.findByRole("dialog", { name: "Restore drill" });
    expect(dialog.textContent).toContain("Backup 20261121-0330, 1200 ms.");
    expect(within(dialog).getByText("audit_events")).toBeDefined();
  });

  it("runs a backup now with the CSRF header and shows the new row", async () => {
    const state = world();
    answers(state);
    renderBackups();
    const user = userEvent.setup();
    await screen.findByText("No backups yet");
    await user.click(screen.getByRole("button", { name: "Run now" }));
    await screen.findByText("Backup done");
    await screen.findByText("21 Nov 2026, 19:00");
    const run = state.requests.find(
      (r) => r.method === "POST" && r.path === "/api/v1/system/backups",
    );
    expect(run).toBeDefined();
    expect(headerOf(run?.init ?? {}, "x-csrf-token")).toBe("csrf-test");
  });

  it("shows a failure toast when Run now is refused", async () => {
    answers(world(), (method, path) => {
      if (method === "POST" && path === "/api/v1/system/backups") {
        return { status: 409, body: { error: "backup_running" } };
      }
      return undefined;
    });
    renderBackups();
    const user = userEvent.setup();
    await screen.findByText("No backups yet");
    await user.click(screen.getByRole("button", { name: "Run now" }));
    await screen.findByText("Backup failed");
    expect(
      screen.getByText("The server answered 409 (backup_running)."),
    ).toBeDefined();
    expect(screen.getByText("No backups yet")).toBeDefined();
  });

  it("shows the running badge while the daily job runs", async () => {
    const state = world();
    state.status = {
      ...systemStatus,
      backups: { ...systemStatus.backups, running: true },
    };
    answers(state);
    renderBackups();
    await screen.findByText("Backup running");
    expect(screen.queryByText("Idle")).toBeNull();
  });

  it("removes the key banner once the owner acknowledges it", async () => {
    answers(world());
    renderBackups();
    const user = userEvent.setup();
    await screen.findByText("Back up the app secret key");
    await user.click(
      screen.getByRole("button", { name: "I have backed it up" }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Back up the app secret key")).toBeNull();
    });
  });

  it("runs the restore drill and shows one badge per check", async () => {
    answers(world(backupItems));
    renderBackups();
    const user = userEvent.setup();
    const table = await screen.findByRole("table", { name: "Local backups" });
    const [check] = within(table).getAllByRole("button", { name: "Check" });
    expect(check).toBeDefined();
    if (check === undefined) {
      return;
    }
    await user.click(check);
    const dialog = await screen.findByRole("dialog", { name: "Restore drill" });
    expect(dialog.textContent).toContain("Backup 20261121-0330, 1200 ms.");
    expect(within(dialog).getByText("restore")).toBeDefined();
    expect(within(dialog).getAllByText("ok").length).toBe(2);
    expect(within(dialog).getByText("owner")).toBeDefined();
    expect(within(dialog).getByText("failed")).toBeDefined();
    const detail = within(dialog).getByText("no owner account in the copy");
    expect(detail.className).toContain("break-words");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Restore drill" }),
      ).toBeNull();
    });
  });

  it("shows the row counts of the drill as pairs that wrap, not as one word", async () => {
    answers(world(backupItems));
    renderBackups();
    const user = userEvent.setup();
    const table = await screen.findByRole("table", { name: "Local backups" });
    const [check] = within(table).getAllByRole("button", { name: "Check" });
    if (check === undefined) {
      throw new Error("no Check button");
    }
    await user.click(check);
    const dialog = await screen.findByRole("dialog", { name: "Restore drill" });
    expect(within(dialog).queryByText(ROW_COUNTS)).toBeNull();
    const names = within(dialog).getAllByRole("term");
    expect(names.map((term) => term.textContent)).toEqual([
      "users",
      "servers",
      "change_sets",
      "audit_events",
      "snapshots",
    ]);
    const counts = within(dialog).getAllByRole("definition");
    expect(counts.map((count) => count.textContent)).toEqual([
      "1",
      "0",
      "0",
      "5",
      "—",
    ]);
  });

  it("shows the drill failure as a toast", async () => {
    answers(world(backupItems), (method, path) => {
      if (method === "POST" && path.endsWith("/drill")) {
        return { status: 404, body: { error: "not_found" } };
      }
      return undefined;
    });
    renderBackups();
    const user = userEvent.setup();
    const table = await screen.findByRole("table", { name: "Local backups" });
    const [check] = within(table).getAllByRole("button", { name: "Check" });
    if (check === undefined) {
      throw new Error("no Check button");
    }
    await user.click(check);
    await screen.findByText("Restore drill failed");
    expect(
      screen.getByText("The server answered 404 (not_found)."),
    ).toBeDefined();
  });

  it("exports an app backup with a passphrase and hands the file over", async () => {
    const state = world(backupItems);
    answers(state, (method, path) => {
      if (method === "POST" && path === "/api/v1/system/backup-export") {
        return {
          status: 200,
          body: "DWBX",
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="dialwarden-x.dwbx"',
          },
        };
      }
      return undefined;
    });
    renderBackups();
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "Local backups" });
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Export an app backup",
    });
    const button = within(dialog).getByRole<HTMLButtonElement>("button", {
      name: "Export",
    });
    const first = within(dialog).getByLabelText("Passphrase");
    const again = within(dialog).getByLabelText("Passphrase again");
    await user.type(first, "short");
    await user.type(again, "short");
    expect(button.disabled).toBe(true);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.clear(first);
    await user.clear(again);
    await user.type(first, "pässwörd-1234-long");
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Only letters, digits, spaces",
    );
    expect(button.disabled).toBe(true);
    await user.clear(first);
    await user.type(first, "export passphrase 2026");
    await user.type(again, "export passphrase 2027");
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "The two passphrases differ.",
    );
    expect(button.disabled).toBe(true);
    await user.clear(again);
    await user.type(again, "export passphrase 2026");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(button.disabled).toBe(false);
    await user.click(button);
    await screen.findByText("Export started");
    const request = state.requests.find(
      (r) => r.path === "/api/v1/system/backup-export",
    );
    expect(request?.method).toBe("POST");
    expect(bodyOf(request?.init ?? {})).toEqual({
      passphrase: "export passphrase 2026",
    });
    expect(headerOf(request?.init ?? {}, "x-csrf-token")).toBe("csrf-test");
    expect(vi.mocked(downloadBlob)).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0] ?? [];
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe("dialwarden-x.dwbx");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("shows the export failure inside the dialog", async () => {
    answers(world(backupItems), (method, path) => {
      if (method === "POST" && path === "/api/v1/system/backup-export") {
        return { status: 409, body: { error: "backup_running" } };
      }
      return undefined;
    });
    renderBackups();
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "Local backups" });
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Export an app backup",
    });
    await user.type(
      within(dialog).getByLabelText("Passphrase"),
      "export passphrase 2026",
    );
    await user.type(
      within(dialog).getByLabelText("Passphrase again"),
      "export passphrase 2026",
    );
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "The server answered 409 (backup_running).",
    );
  });

  it("shows the error state with a retry when the list fails", async () => {
    answers(world("error"));
    renderBackups();
    await screen.findByText("Something went wrong");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("tells a non-owner that backups are owner only", () => {
    answers(world());
    renderBackups({ ...OWNER, user: { ...OWNER.user, role: "viewer" } });
    expect(
      screen.getByText("Only the owner can see and run backups."),
    ).toBeDefined();
  });
});

describe("countPairs", () => {
  it("turns the engine's row counts into name and count pairs", () => {
    expect(countPairs(ROW_COUNTS)).toEqual([
      ["users", "1"],
      ["servers", "0"],
      ["change_sets", "0"],
      ["audit_events", "5"],
      ["snapshots", "—"],
    ]);
  });

  it("leaves every other detail as text", () => {
    expect(countPairs("restored into a scratch folder")).toBeNull();
    expect(countPairs("{not json")).toBeNull();
    expect(countPairs('{"users":"one"}')).toBeNull();
    expect(countPairs('{"nested":{"n":1}}')).toBeNull();
    expect(countPairs("[1,2]")).toBeNull();
  });
});
