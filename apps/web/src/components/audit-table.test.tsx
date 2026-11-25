// @vitest-environment jsdom
// The audit table: every row's action in words with the route kept, the
// refused sign-ins marked, the erased actor, the two densities, the stacked
// rows below 1024 px and the rows up to a broken chain marked.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "../api/schema";
import { renderWithProviders, resetAfterEach } from "../test/render";
import {
  AuditTable,
  describeAction,
  isRefusal,
  type AuditTableProps,
} from "./audit-table";

afterEach(resetAfterEach);

/** The table inside a router of its own: the server cell is a Link. */
function renderTable(props: AuditTableProps): void {
  const component = (): ReactNode => <AuditTable {...props} />;
  const router = createRouter({
    routeTree: createRootRoute({ component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
}

function entry(
  id: number,
  action: string,
  extra: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    id,
    at: "2026-11-25T10:00:00Z",
    actor: { id: "u1", label: "owner@example.test", erased: false },
    action,
    targetType: "users",
    targetId: "u2",
    serverId: null,
    data: { status: 200, params: {} },
    ip: "203.0.113.0",
    ...extra,
  };
}

const ROWS: AuditEntry[] = [
  entry(3, "PUT /api/v1/users/:id/role"),
  entry(2, "POST /api/v1/auth/login", {
    actor: { id: "anonymous", label: "anonymous", erased: false },
    targetType: "auth",
    targetId: null,
    data: { status: 401, params: {} },
  }),
  entry(1, "POST /api/v1/servers/:slug/change-sets", {
    actor: { id: "u9", label: "Erased user u9", erased: true },
    targetType: "servers",
    targetId: "home",
    serverId: "home",
    ip: null,
  }),
];

const NAMES = new Map([["home", "Home"]]);

describe("AuditTable", () => {
  it("puts the actions in words and keeps the route pattern", () => {
    expect(describeAction("PUT /api/v1/users/:id/role").word).toBe(
      "Role changed",
    );
    expect(describeAction("POST /api/v1/tokens").word).toBe("Token made");
    expect(describeAction("DELETE /api/v1/something/:id").word).toBe("Removed");
    expect(describeAction("POST /api/v1/unknown").word).toBe("Request");
    expect(isRefusal(ROWS[1] as AuditEntry)).toBe(true);
    expect(isRefusal(ROWS[0] as AuditEntry)).toBe(false);
  });

  it("renders the wide table with the row, actor, action, target and server", async () => {
    renderTable({
      items: ROWS,
      density: "comfortable",
      serverNames: NAMES,
      wide: true,
    });
    const table = await screen.findByRole("table", { name: "Audit log" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Row",
      "When",
      "Who",
      "Action",
      "Target",
      "Server",
      "From",
    ]);
    expect(within(table).getByText("Role changed")).toBeDefined();
    expect(within(table).getByText("PUT /api/v1/users/:id/role")).toBeDefined();
    // The refused sign-in is marked as such, with the status it answered.
    expect(within(table).getByText("Refused")).toBeDefined();
    expect(within(table).getByText("Sign-in, answered 401")).toBeDefined();
    // The erased actor keeps its label; the server links to its history.
    expect(within(table).getByText("Erased user u9")).toBeDefined();
    expect(within(table).getByRole("link", { name: "Home" })).toBeDefined();
    // Two rows carry an address; the third stored none (a dash).
    expect(within(table).getAllByText("203.0.113.0").length).toBe(2);
  });

  it("stacks the rows below 1024 px and marks the rows up to a break", async () => {
    renderTable({
      items: ROWS,
      density: "compact",
      serverNames: NAMES,
      wide: false,
      brokenAt: 2,
    });
    const list = await screen.findByRole("list", { name: "Audit log" });
    expect(screen.queryByRole("table")).toBeNull();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBe(3);
    // Rows 2 and 1 sit at or before the first broken row; row 3 is after it.
    expect(rows[0]?.className).not.toContain("bg-error-soft");
    expect(rows[1]?.className).toContain("bg-error-soft");
    expect(rows[2]?.className).toContain("bg-error-soft");
    // Compact density pads less than comfortable.
    expect(rows[0]?.className).toContain("py-1.5");
  });
});
