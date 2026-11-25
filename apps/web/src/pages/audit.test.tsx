// @vitest-environment jsdom
// The Audit page: the rows in words, the chain status from the verification
// endpoint (valid, or broken at row N), the search over the loaded rows,
// the server-side filters in the request, the density toggle, and the CSV
// export behind the Paid hint on Free.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry, AuditVerify } from "../api/schema";
import { entitlement, OWNER, paidFromUi } from "../test/fixtures";
import { resetAfterEach, stubFetch, stubViewport } from "../test/render";
import { startRouter } from "../test/start";
import {
  chainWords,
  dateBounds,
  EXPORT_PAID_SENTENCE,
  matchesSearch,
} from "./audit";

afterEach(resetAfterEach);

function row(id: number, action: string, label = "owner@example.test") {
  return {
    id,
    at: "2026-11-25T10:00:00Z",
    actor: {
      id: label === "anonymous" ? "anonymous" : "u1",
      label,
      erased: false,
    },
    action,
    targetType: "users",
    targetId: "u2",
    serverId: null,
    data: { status: label === "anonymous" ? 401 : 200, params: {} },
    ip: null,
  } satisfies AuditEntry;
}

const ROWS: AuditEntry[] = [
  row(3, "PUT /api/v1/users/:id/role"),
  row(2, "POST /api/v1/auth/login", "anonymous"),
  row(1, "POST /api/v1/invitations"),
];

const VALID: AuditVerify = { valid: true, count: 3, headHash: "abc" };
const BROKEN: AuditVerify = {
  valid: false,
  firstBrokenId: 2,
  reason: "hash_mismatch",
};

function stubWorld(paid: boolean, verify: AuditVerify): string[] {
  const seen: string[] = [];
  stubFetch(([method, path]) => {
    if (method === "GET" && path === "/api/v1/setup") {
      return { status: 200, body: { required: false } };
    }
    if (method === "GET" && path === "/api/v1/auth/session") {
      return { status: 200, body: OWNER };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: paid ? paidFromUi() : entitlement() };
    }
    if (method === "GET" && path === "/api/v1/servers") {
      return { status: 200, body: { items: [] } };
    }
    if (method === "GET" && path === "/api/v1/users") {
      return { status: 200, body: { items: [] } };
    }
    if (method === "GET" && path === "/api/v1/audit/verify") {
      return { status: 200, body: verify };
    }
    if (method === "GET" && path.startsWith("/api/v1/audit?")) {
      seen.push(path);
      return { status: 200, body: { items: ROWS, nextBefore: null } };
    }
    return undefined;
  });
  return seen;
}

describe("AuditPage", () => {
  it("puts the chain status and the filters in words", () => {
    expect(chainWords(VALID)).toBe("Chain valid, 3 rows");
    expect(chainWords(BROKEN)).toBe(
      "Chain broken at row 2: a row was changed after it was written",
    );
    // The inputs are local days: local midnight to the last millisecond.
    expect(dateBounds("2026-11-01", "")).toEqual({
      from: new Date(2026, 10, 1).toISOString(),
    });
    expect(dateBounds("nope", "2026-11-30")).toEqual({
      to: new Date(2026, 10, 30, 23, 59, 59, 999).toISOString(),
    });
    expect(matchesSearch(ROWS[0] as AuditEntry, "role changed")).toBe(true);
    expect(matchesSearch(ROWS[0] as AuditEntry, "token")).toBe(false);
  });

  it("renders the rows, the valid chain and narrows with the search", async () => {
    stubViewport(1280);
    const seen = stubWorld(true, VALID);
    startRouter("/audit");
    await screen.findByRole("table", { name: "Audit log" });
    // The status sits in the badge and in the live region for readers.
    expect((await screen.findAllByText("Chain valid, 3 rows")).length).toBe(2);
    expect(screen.getByText("Role changed")).toBeDefined();
    expect(screen.getByText("Invitation made")).toBeDefined();
    expect(screen.getByText("Refused")).toBeDefined();
    expect(seen[0]).toBe("/api/v1/audit?limit=50");
    expect(
      screen.getByText("3 of 3 loaded rows shown · everything loaded"),
    ).toBeDefined();
    // On Paid the export is live and no hint shows.
    expect(screen.getByRole("button", { name: "Export CSV" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByText(EXPORT_PAID_SENTENCE)).toBeNull();

    fireEvent.change(screen.getByLabelText("Search the loaded rows"), {
      target: { value: "invitation" },
    });
    await waitFor(() => {
      expect(screen.queryByText("Role changed")).toBeNull();
    });
    expect(screen.getByText("Invitation made")).toBeDefined();
    expect(
      screen.getByText("1 of 3 loaded rows shown · everything loaded"),
    ).toBeDefined();

    // The density toggle is a pressed-state group.
    const compact = screen.getByRole("button", { name: "Compact" });
    fireEvent.click(compact);
    expect(compact.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("dw.audit.density")).toBe("compact");

    // A date filter goes to the server, from local midnight of that day.
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-11-01" },
    });
    const from = encodeURIComponent(new Date(2026, 10, 1).toISOString());
    await waitFor(() => {
      expect(seen).toContain(`/api/v1/audit?from=${from}&limit=50`);
    });
  });

  it("shows the broken chain at row N and the export hint on Free", async () => {
    stubViewport(1280);
    stubWorld(false, BROKEN);
    startRouter("/audit");
    await screen.findByRole("table", { name: "Audit log" });
    await screen.findAllByText(
      "Chain broken at row 2: a row was changed after it was written",
    );
    expect(screen.getByText(EXPORT_PAID_SENTENCE)).toBeDefined();
    expect(screen.getByRole("button", { name: "Export CSV" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows an editor the read-only state", async () => {
    stubViewport(1280);
    stubFetch(([method, path]) => {
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
        return { status: 200, body: paidFromUi() };
      }
      return undefined;
    });
    startRouter("/audit");
    await screen.findByText("Read by the owner and admins");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
