// @vitest-environment jsdom
// The matrix page: many servers with the differing rows marked and the
// differences-only switch, one server with the nothing-to-compare state, no
// server at all, and the Free plan with the upgrade hint.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Matrix, Server } from "../api/schema";
import { entitlement, OWNER } from "../test/fixtures";
import {
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";
import { cellText, gamesOf } from "./matrix";

afterEach(resetAfterEach);

function server(
  id: string,
  name: string,
  packId: string,
  displayName: string,
): Server {
  return {
    id,
    name,
    packId,
    displayName,
    os: "linux",
    connector: { kind: "local", root: `/srv/${id}` },
    hasPassword: false,
    demo: false,
    editable: true,
    access: "write",
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    lastEditedAt: null,
  };
}

const MANY: Matrix = {
  packId: "palworld",
  displayName: "Palworld",
  groups: ["Rates", "Server"],
  group: null,
  servers: [
    { id: "home", name: "Home", editable: true, error: null },
    { id: "away", name: "Away", editable: false, error: null },
    { id: "far", name: "Far", editable: true, error: "connection refused" },
  ],
  rows: [
    {
      key: "ExpRate",
      label: "Experience rate",
      group: "Rates",
      secret: false,
      values: { home: 1, away: 2 },
      differs: true,
    },
    {
      key: "ServerName",
      label: "Server name",
      group: "Server",
      secret: false,
      values: { home: "Pals", away: "Pals" },
      differs: false,
    },
    {
      key: "AdminPassword",
      label: "Admin password",
      group: "Server",
      secret: true,
      values: {},
      differs: false,
    },
  ],
  differing: 1,
};

function stubWorld(servers: unknown[], extra?: Handler) {
  const seen: string[] = [];
  stubFetch((route, init) => {
    const special = extra?.(route, init);
    if (special !== undefined) {
      return special;
    }
    const [method, path] = route;
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
      return { status: 200, body: { items: servers } };
    }
    if (method === "GET" && path.startsWith("/api/v1/fleet/matrix?")) {
      seen.push(path);
      return { status: 200, body: MANY };
    }
    return undefined;
  });
  return seen;
}

const THREE = [
  server("home", "Home", "palworld", "Palworld"),
  server("away", "Away", "palworld", "Palworld"),
  server("far", "Far", "palworld", "Palworld"),
];

describe("MatrixPage", () => {
  it("marks the differing rows with a badge and narrows to them", async () => {
    stubViewport(1440);
    const seen = stubWorld(THREE);
    startRouter("/matrix");

    const table = await screen.findByRole("table", {
      name: "Palworld settings by server",
    });
    expect(seen[0]).toBe("/api/v1/fleet/matrix?game=palworld");
    expect(screen.getByText("1 of 3 settings differ")).toBeTruthy();
    const rows = within(table).getAllByRole("row");
    // The header row, then one row per setting.
    expect(rows.length).toBe(4);
    expect(within(table).getByText("Differs")).toBeTruthy();
    expect(within(table).getAllByText("Same").length).toBe(2);
    expect(within(table).getByText("Read-only")).toBeTruthy();
    expect(within(table).getByText("Unreadable")).toBeTruthy();
    expect(within(table).getAllByText("hidden").length).toBe(3);

    fireEvent.click(screen.getByRole("switch", { name: "Differences only" }));
    await waitFor(() => {
      expect(within(table).getAllByRole("row").length).toBe(2);
    });
    expect(within(table).queryByText("Same")).toBeNull();
  });

  it("asks for one group and for a server choice through the API", async () => {
    stubViewport(1440);
    const seen = stubWorld(THREE);
    startRouter("/matrix");
    await screen.findByRole("table", { name: "Palworld settings by server" });

    fireEvent.change(screen.getByLabelText("Settings group"), {
      target: { value: "Rates" },
    });
    await waitFor(() => {
      expect(seen).toContain("/api/v1/fleet/matrix?game=palworld&group=Rates");
    });
    fireEvent.click(screen.getByLabelText("Far"));
    await waitFor(() => {
      expect(seen).toContain(
        "/api/v1/fleet/matrix?game=palworld&group=Rates&servers=home%2Caway",
      );
    });
  });

  it("says when one server is alone and when no server is chosen", async () => {
    stubViewport(1440);
    stubWorld(
      [server("solo", "Solo", "valheim", "Valheim")],
      ([method, path]) => {
        if (method === "GET" && path.startsWith("/api/v1/fleet/matrix?")) {
          return {
            status: 200,
            body: {
              ...MANY,
              packId: "valheim",
              displayName: "Valheim",
              servers: [
                { id: "solo", name: "Solo", editable: true, error: null },
              ],
              rows: [MANY.rows[1]],
              differing: 0,
            },
          };
        }
        return undefined;
      },
    );
    startRouter("/matrix");
    await screen.findByText("Only one server to show");
    expect(
      screen.getByRole("table", { name: "Valheim settings by server" }),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Servers" })).toBeNull();
  });

  it("shows the designed empty state without servers", async () => {
    stubViewport(1440);
    stubWorld([]);
    startRouter("/matrix");
    await screen.findByText("No servers to compare");
    expect(screen.getByRole("link", { name: "Add server" })).toBeTruthy();
  });

  it("renders the upgrade hint on Free", async () => {
    stubViewport(1440);
    stubWorld(THREE, ([method, path]) => {
      if (method === "GET" && path.startsWith("/api/v1/fleet/matrix?")) {
        return {
          status: 402,
          body: {
            error: "payment_required",
            plan: "free",
            feature: "fleet.matrix",
          },
        };
      }
      return undefined;
    });
    startRouter("/matrix");
    await screen.findByText(
      "The fleet settings matrix is part of the Paid plan.",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("counts the games and words the cells", () => {
    expect(gamesOf(THREE)).toEqual([
      { packId: "palworld", displayName: "Palworld", count: 3 },
    ]);
    expect(cellText(MANY.rows[0] as Matrix["rows"][number], "home")).toBe("1");
    expect(cellText(MANY.rows[0] as Matrix["rows"][number], "far")).toBe("—");
    expect(cellText(MANY.rows[2] as Matrix["rows"][number], "home")).toBe(
      "hidden",
    );
  });
});
