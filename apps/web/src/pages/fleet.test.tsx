// @vitest-environment jsdom
// The fleet wall after P10-B2: the Servers tile names the plan and what it
// allows (P9 live check L11, never "50 on Free" on Paid), the week tile
// counts reverts (L5), a long name wraps to two lines instead of an
// ellipsis (phase-report-07 F-P7-3) and a server this caller's grant only
// reads offers View settings (P10-A L22).
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Schedule } from "../api/schema";
import { entitlement, OWNER, paidFromUi } from "../test/fixtures";
import {
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";
import { dueThisWeek, serversCaption } from "./fleet";

afterEach(resetAfterEach);

function serverItem(id: string, name: string, access: "read" | "write") {
  return {
    id,
    name,
    packId: "pzomboid",
    displayName: "Project Zomboid",
    os: "linux",
    connector: { kind: "local", root: `/srv/${id}` },
    hasPassword: false,
    demo: true,
    editable: true,
    access,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    lastEditedAt: null,
  };
}

const STATUS = {
  state: "running",
  players: 3,
  source: "a2s",
  at: "2026-11-24T18:00:00Z",
  pending: 0,
};

function stubWorld(paid: boolean, extra?: Handler) {
  return stubFetch((route, init) => {
    const special = extra?.(route, init);
    if (special !== undefined) {
      return special;
    }
    const [method, path] = route;
    if (method === "GET" && path === "/api/v1/setup") {
      return { status: 200, body: { required: false } };
    }
    if (method === "GET" && path === "/api/v1/auth/session") {
      return {
        status: 200,
        body: { ...OWNER, user: { ...OWNER.user, role: "editor" } },
      };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: paid ? paidFromUi() : entitlement() };
    }
    if (method === "GET" && path === "/api/v1/servers") {
      return {
        status: 200,
        body: {
          items: [
            serverItem("demo-pzomboid", "Demo Project Zomboid", "write"),
            serverItem("demo-pzomboid-2", "Demo Project Zomboid 2", "read"),
          ],
        },
      };
    }
    if (method === "GET" && /^\/api\/v1\/servers\/[^/]+\/history$/.test(path)) {
      return {
        status: 200,
        body: { entries: [], visibleLimit: null, hiddenCount: 0 },
      };
    }
    if (method === "GET" && /^\/api\/v1\/servers\/[^/]+\/status$/.test(path)) {
      return { status: 200, body: STATUS };
    }
    if (method === "GET" && path === "/api/v1/drift") {
      return { status: 200, body: { items: [] } };
    }
    if (method === "GET" && path === "/api/v1/schedules") {
      return { status: 200, body: { items: [] } };
    }
    return undefined;
  });
}

describe("FleetPage", () => {
  it("names the Paid plan's own limit and offers View settings on a read grant", async () => {
    stubViewport(1440);
    stubWorld(true);
    startRouter("/");
    await screen.findByText("Demo Project Zomboid 2");
    await screen.findByText(
      "Paid plan: up to 50 servers · 2 running, 0 stopped",
    );
    expect(screen.queryByText(/on Free/)).toBeNull();
    const links = screen.getAllByRole("link", {
      name: /settings$/,
    });
    expect(links.map((link) => link.textContent)).toEqual([
      "Edit settings",
      "View settings",
    ]);
    // The name may take two lines; it is never cut with an ellipsis.
    const heading = screen.getByRole("heading", {
      name: "Demo Project Zomboid",
    });
    expect(heading.className).toContain("line-clamp-2");
    expect(heading.className).not.toContain("truncate");
  });

  it("names the Free plan's editable servers", async () => {
    stubViewport(1440);
    stubWorld(false);
    startRouter("/");
    await screen.findByText(
      "Free plan: 3 editable servers · 2 running, 0 stopped",
    );
  });

  it("words the Servers tile and counts a revert due this week", () => {
    expect(serversCaption(true, null, 1, 2)).toBe(
      "Paid plan: no server limit · 1 running, 2 stopped",
    );
    expect(serversCaption(true, 50, 0, 0)).toBe(
      "Paid plan: up to 50 servers · 0 running, 0 stopped",
    );
    expect(serversCaption(false, 3, 1, 0)).toBe(
      "Free plan: 3 editable servers · 1 running, 0 stopped",
    );
    expect(serversCaption(false, undefined, 0, 0)).toBe(
      "Free plan: 3 editable servers · 0 running, 0 stopped",
    );
    const now = Date.parse("2026-11-26T10:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const base = {
      id: "s",
      serverId: "home",
      name: "S",
      author: "Owner",
      kind: "once",
      runAt: null,
      cron: null,
      timezone: "UTC",
      revertAt: null,
      revertAfterMinutes: null,
      runHooks: "none",
      edits: [],
      state: "active",
      pausedReason: null,
      nextRunAt: null,
      revertDueAt: null,
      lastRunAt: null,
      lastResult: null,
      lastChangeSetId: null,
      lastRevertAt: null,
      lastRevertResult: null,
      createdAt: "2026-11-26T00:00:00Z",
      updatedAt: "2026-11-26T00:00:00Z",
    } as const satisfies Schedule;
    const soon = new Date(now + 2 * day).toISOString();
    const later = new Date(now + 9 * day).toISOString();
    expect(
      dueThisWeek(
        [
          { ...base, nextRunAt: soon },
          { ...base, revertDueAt: soon },
          { ...base, nextRunAt: later },
          { ...base, state: "paused", nextRunAt: soon },
        ],
        now,
      ),
    ).toBe(2);
    expect(dueThisWeek(undefined, now)).toBe(0);
  });
});
