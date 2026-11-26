// @vitest-environment jsdom
// The Activity page: the feed renders the C6 events in words, pages with the
// server's nextBefore cursor, and the tabs narrow it by type (one request
// per type) or, for failures, in the browser.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEvent } from "../api/schema";
import { entitlement, OWNER } from "../test/fixtures";
import { resetAfterEach, stubFetch, stubViewport } from "../test/render";
import { startRouter } from "../test/start";
import { describeEvent, isFailure, typeOfTab } from "./activity";

afterEach(resetAfterEach);

function event(
  id: number,
  type: ActivityEvent["type"],
  data: Record<string, unknown>,
  at = "2026-11-24T10:00:00Z",
): ActivityEvent {
  return { id, type, serverId: "home", at, actor: "owner@example.test", data };
}

const PAGE_ONE: ActivityEvent[] = [
  event(30, "hook.run", { action: "restart", source: "dockerProxy", ok: true }),
  event(29, "change.applied", { changeSetId: "cs-2", cause: "app" }),
  event(28, "hook.run", {
    action: "stop",
    source: "dockerProxy",
    ok: false,
    error: "Timeout",
  }),
  event(27, "change.pending", { changeSetId: "cs-1", runHooks: "none" }),
  {
    id: 26,
    type: "backup.done",
    serverId: null,
    at: "2026-11-23T03:30:00Z",
    actor: "system",
    data: { id: "b1", sizeBytes: 2_621_440, pruned: 1 },
  },
];

const PAGE_TWO: ActivityEvent[] = [
  event(
    2,
    "change.applied",
    { changeSetId: "cs-0", cause: "import" },
    "2026-11-22T09:00:00Z",
  ),
];

const SERVERS = {
  items: [
    {
      id: "home",
      name: "Home",
      packId: "valheim",
      displayName: "Valheim",
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

function stubWorld(): string[] {
  const seen: string[] = [];
  stubFetch(([method, path]) => {
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
    if (method === "GET" && path.startsWith("/api/v1/activity?")) {
      seen.push(path);
      const search = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      if (search.get("type") === "backup.done") {
        return {
          status: 200,
          body: { items: [PAGE_ONE[4]], nextBefore: null },
        };
      }
      if (search.get("before") === "26") {
        return { status: 200, body: { items: PAGE_TWO, nextBefore: null } };
      }
      return { status: 200, body: { items: PAGE_ONE, nextBefore: 26 } };
    }
    return undefined;
  });
  return seen;
}

describe("ActivityPage", () => {
  it("renders the events in words with their server and pages onwards", async () => {
    stubViewport(1280);
    const seen = stubWorld();
    startRouter("/activity");

    await screen.findByText("The restart hook ran (dockerProxy)");
    expect(screen.getByText("Change applied")).toBeTruthy();
    expect(
      screen.getByText("The stop hook failed (dockerProxy): Timeout"),
    ).toBeTruthy();
    expect(
      screen.getByText("Change saved as pending (written at the next stop)"),
    ).toBeTruthy();
    expect(
      screen.getByText("Backup done, 2.5 MB, 1 older copy pruned"),
    ).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Home" }).length).toBe(4);
    expect(seen[0]).toBe("/api/v1/activity?limit=20");
    expect(screen.getByText("5 events shown")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("First import");
    expect(seen).toContain("/api/v1/activity?limit=20&before=26");
    expect(screen.getByText("6 events shown · everything loaded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("narrows to failures in the browser and to backups through the API", async () => {
    stubViewport(1280);
    const seen = stubWorld();
    startRouter("/activity");
    await screen.findByText("Change applied");

    fireEvent.click(screen.getByRole("tab", { name: "Failures" }));
    await waitFor(() => {
      expect(screen.queryByText("Change applied")).toBeNull();
    });
    expect(
      screen.getByText("The stop hook failed (dockerProxy): Timeout"),
    ).toBeTruthy();
    expect(screen.getByText("1 event shown")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Backups" }));
    await waitFor(() => {
      expect(seen).toContain("/api/v1/activity?limit=20&type=backup.done");
    });
    await screen.findByText("1 event shown · everything loaded");
    expect(
      screen.getByText("Backup done, 2.5 MB, 1 older copy pruned"),
    ).toBeTruthy();
  });

  it("shows the designed empty state", async () => {
    stubViewport(1280);
    stubFetch(([method, path]) => {
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
        return { status: 200, body: { items: [] } };
      }
      if (method === "GET" && path.startsWith("/api/v1/activity?")) {
        return { status: 200, body: { items: [], nextBefore: null } };
      }
      return undefined;
    });
    startRouter("/activity");
    await screen.findByText("Nothing has happened yet");
    expect(screen.getByRole("link", { name: "Add server" })).toBeTruthy();
  });

  it("maps tabs to types and words to events", () => {
    expect(typeOfTab("all")).toBeNull();
    expect(typeOfTab("applies")).toBe("change.applied");
    expect(typeOfTab("failures")).toBeNull();
    expect(typeOfTab("pending")).toBe("change.pending");
    expect(typeOfTab("scheduled")).toBe("schedule.run");
    expect(typeOfTab("backups")).toBe("backup.done");
    expect(isFailure(event(1, "change.conflict", {}))).toBe(true);
    expect(isFailure(event(1, "hook.run", { ok: true }))).toBe(false);
    expect(
      describeEvent(event(1, "drift.detected", { files: ["settings"] }))
        .sentence,
    ).toBe("Files changed outside Dialwarden: settings");
    expect(
      describeEvent(
        event(1, "licence.changed", { action: "set", plan: "paid" }),
      ).sentence,
    ).toBe("A licence key was entered (paid plan)");
    expect(
      describeEvent(event(1, "user.changed", { action: "created" })).word,
    ).toBe("User");
    // P10-B: the second-factor lock-out has its own words and a warning.
    const locked = describeEvent(
      event(1, "user.changed", { action: "second_factor_locked" }),
    );
    expect(locked.word).toBe("Locked");
    expect(locked.kind).toBe("warning");
    expect(locked.sentence).toBe(
      "An account was locked after too many second-factor failures",
    );
    expect(
      describeEvent(event(1, "user.changed", { action: "grants_changed" }))
        .sentence,
    ).toBe("A user's server grants were changed");
  });
});
