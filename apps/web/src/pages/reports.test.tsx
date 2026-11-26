// @vitest-environment jsdom
// The reports page: the selection becomes the query, the preview looks like
// the export with the chips, the Markdown and Discord tabs carry the
// server's texts with a Copied state each (P9 live check L7), and the Free
// plan renders the upgrade hint before anything is built (L6) as well as on
// a 402 of the build.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entitlement, Report } from "../api/schema";
import { entitlement, OWNER, paidFromUi } from "../test/fixtures";
import {
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";
import { selectionOf, utcWords } from "./reports";

afterEach(() => {
  resetAfterEach();
  Reflect.deleteProperty(navigator, "clipboard");
});

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

function stubWorld(plan: Entitlement, extra?: Handler) {
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
      return { status: 200, body: plan };
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
              access: "write",
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

/** A clipboard that accepts every write (jsdom has none). */
function stubClipboard() {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

describe("ReportsPage", () => {
  it("builds the report and previews it like the export", async () => {
    stubViewport(1440);
    const seen = stubWorld(paidFromUi());
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

  it("keeps the Copied state of one tab out of the next (L7)", async () => {
    stubViewport(1440);
    stubWorld(paidFromUi());
    const writeText = stubClipboard();
    startRouter("/reports");
    await screen.findByText("No report built yet");
    fireEvent.click(screen.getByRole("button", { name: "Build the report" }));
    await screen.findByLabelText("Report preview");

    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    const panel = await screen.findByRole("tabpanel");
    fireEvent.click(
      within(panel).getByRole("button", { name: "Copy Markdown" }),
    );
    await within(panel).findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith(REPORT.markdown);

    // The Discord tab's own button starts fresh: it never says Copied for
    // a text that was not copied.
    fireEvent.click(screen.getByRole("tab", { name: "Discord" }));
    const next = await screen.findByRole("tabpanel");
    await within(next).findByRole("button", { name: "Copy the message" });
    expect(within(next).queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("says before anything is built that reports are Paid, on Free (L6)", async () => {
    stubViewport(1440);
    const seen = stubWorld(entitlement());
    startRouter("/reports");
    await screen.findByText("Reports is part of the Paid plan.");
    expect(screen.getByText("What a report holds")).toBeTruthy();
    expect(screen.queryByText("No report built yet")).toBeNull();
    const build = screen.getByRole("button", {
      name: "Build the report",
    }) as HTMLButtonElement;
    expect(build.disabled).toBe(true);
    expect(seen).toEqual([]);
  });

  it("sends the chosen servers and renders the upgrade hint on a 402 of the build", async () => {
    stubViewport(1440);
    const seen: string[] = [];
    // The entitlement still says Paid (the licence ended meanwhile): the
    // build goes out and its 402 renders the hint.
    stubWorld(paidFromUi(), ([method, path]) => {
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
