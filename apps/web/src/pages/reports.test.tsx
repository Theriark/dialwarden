// @vitest-environment jsdom
// The reports page: the selection becomes the query, the preview looks like
// the export with the chips, the Markdown and Discord tabs carry the
// server's texts, and the Free plan renders the upgrade hint.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Report } from "../api/schema";
import { entitlement, OWNER } from "../test/fixtures";
import {
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";
import { selectionOf, utcWords } from "./reports";

afterEach(resetAfterEach);

const REPORT: Report = {
  generatedAt: "2026-11-26T10:00:00.000Z",
  from: "2026-11-19T10:00:00.000Z",
  to: null,
  servers: [
    {
      id: "home",
      name: "Home",
      game: "Palworld",
      entries: [
        {
          changeSetId: "cs-1",
          at: "2026-11-25T22:10:00.000Z",
          author: "Owner Person",
          cause: "app",
          status: "applied",
          chips: [
            "Experience rate: 1 to 2 (restart required)",
            "Admin password: changed (secret, hidden)",
          ],
        },
      ],
    },
  ],
  entryCount: 1,
  truncated: false,
  markdown: "# Dialwarden change report\n\n- **x** by Owner",
  discord: {
    content:
      "**Dialwarden change report** (1 change sets on 1 servers)\n**Home**\n- 2026-11-25 22:10 UTC, app: Experience rate: 1 to 2; Admin password: changed (secret, hidden)",
  },
};

function stubWorld(extra?: Handler) {
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
      return {
        status: 200,
        body: {
          items: [
            {
              id: "home",
              name: "Home",
              packId: "palworld",
              displayName: "Palworld",
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
        },
      };
    }
    if (method === "GET" && path.startsWith("/api/v1/reports/changes")) {
      seen.push(path);
      return { status: 200, body: REPORT };
    }
    return undefined;
  });
  return seen;
}

describe("ReportsPage", () => {
  it("builds the report and previews it like the export", async () => {
    stubViewport(1440);
    const seen = stubWorld();
    startRouter("/reports");
    await screen.findByText("No report built yet");

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-11-19T10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build the report" }));
    const preview = await screen.findByLabelText("Report preview");
    expect(seen[0]).toBe(
      "/api/v1/reports/changes?from=2026-11-19T10%3A00%3A00.000Z",
    );
    expect(within(preview).getByText("Home (Palworld)")).toBeTruthy();
    expect(within(preview).getByText("2026-11-25 22:10 UTC")).toBeTruthy();
    expect(within(preview).getByText("Experience rate: 1 to 2")).toBeTruthy();
    expect(
      within(preview).getByText("Admin password: changed (secret, hidden)"),
    ).toBeTruthy();
    expect(within(preview).getByText("Restart required")).toBeTruthy();
    const print = screen.getByRole("link", { name: /Open the print view/ });
    expect(print.getAttribute("href")).toBe(
      "/api/v1/reports/changes/print?from=2026-11-19T10%3A00%3A00.000Z",
    );
    expect(print.getAttribute("target")).toBe("_blank");

    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    expect(
      (await screen.findByLabelText("Markdown text")).textContent,
    ).toContain("# Dialwarden change report");
    fireEvent.click(screen.getByRole("tab", { name: "Discord" }));
    const discord = await screen.findByLabelText("Discord preview");
    expect(within(discord).getByText("Dialwarden change report")).toBeTruthy();
    expect(within(discord).getByText("Experience rate: 1 to 2")).toBeTruthy();
  });

  it("sends the chosen servers and renders the upgrade hint on Free", async () => {
    stubViewport(1440);
    const seen: string[] = [];
    stubWorld(([method, path]) => {
      if (method === "GET" && path.startsWith("/api/v1/reports/changes")) {
        seen.push(path);
        return {
          status: 402,
          body: { error: "payment_required", plan: "free", feature: "reports" },
        };
      }
      return undefined;
    });
    startRouter("/reports");
    await screen.findByText("No report built yet");
    fireEvent.click(screen.getByLabelText("Every server I may read"));
    fireEvent.click(await screen.findByLabelText("Home"));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Build the report" }));
    await screen.findByText("Reports is part of the Paid plan.");
    await waitFor(() => {
      expect(seen).toContain("/api/v1/reports/changes?servers=home");
    });
  });

  it("turns the form into the query and words the times", () => {
    expect(selectionOf("2026-11-19T10:00", "", ["home"], true)).toEqual({
      from: "2026-11-19T10:00:00.000Z",
    });
    expect(
      selectionOf("", "2026-11-26T10:00", ["home", "away"], false),
    ).toEqual({
      to: "2026-11-26T10:00:00.000Z",
      servers: ["home", "away"],
    });
    expect(utcWords("2026-11-25T22:10:00.000Z")).toBe("2026-11-25 22:10 UTC");
  });
});
