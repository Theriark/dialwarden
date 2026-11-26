// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Entitlement } from "../api/schema";
import {
  entitlement,
  health,
  OWNER,
  paidFromEnvironment,
  registry,
} from "../test/fixtures";
import {
  renderWithProviders,
  resetAfterEach,
  stubFetch,
  testQueryClient,
  withSession,
  type Answer,
} from "../test/render";
import {
  AboutPage,
  NOT_AFFILIATED,
  OUTBOUND_FOR_MANAGERS,
  SOURCE_AVAILABLE,
} from "./about";

afterEach(resetAfterEach);

function answers(current: Entitlement, overrides: [string, Answer][] = []) {
  const special = new Map(overrides);
  return stubFetch(([method, path]) => {
    if (method !== "GET") {
      return undefined;
    }
    const override = special.get(path);
    if (override !== undefined) {
      return override;
    }
    if (path === "/healthz") {
      return { status: 200, body: health };
    }
    if (path === "/api/v1/plan/registry") {
      return { status: 200, body: registry };
    }
    if (path === "/api/v1/entitlement") {
      return { status: 200, body: current };
    }
    if (path === "/api/v1/notifications/channels") {
      // The channels are Paid: a Free instance answers 402, and then the
      // no-outbound sentence is true.
      return {
        status: 402,
        body: { error: "payment_required", plan: "free" },
      };
    }
    return undefined;
  });
}

function renderAbout(session = OWNER) {
  const client = testQueryClient();
  withSession(client, session);
  renderWithProviders(<AboutPage />, client);
}

describe("AboutPage", () => {
  it("shows the build facts, the plans and the legal words", async () => {
    answers(entitlement());
    renderAbout();
    await screen.findByText("27.0.0");
    expect(screen.getByText(health.revision)).toBeDefined();
    expect(screen.getAllByText("21 Nov 2026, 18:00").length).toBe(2);
    await screen.findByText("Editable servers");
    expect(screen.getByText("As many as the licence covers")).toBeDefined();
    expect(screen.getAllByText("Unlimited").length).toBe(3);
    expect(screen.getByText("Not in this version")).toBeDefined();
    expect(screen.getByText("Free (this instance)")).toBeDefined();
    expect(screen.getByText("Two-factor sign-in")).toBeDefined();
    expect(screen.getByText(SOURCE_AVAILABLE)).toBeDefined();
    expect(screen.getByText(NOT_AFFILIATED)).toBeDefined();
    expect(SOURCE_AVAILABLE).toContain("source-available under FCL-1.0-MIT");
    expect(NOT_AFFILIATED).toContain("product of Theriark");
    expect(screen.getByText(/No outbound connection/)).toBeDefined();
    expect(screen.getByText("none")).toBeDefined();
  });

  it("marks the Paid column on a Paid instance", async () => {
    answers(paidFromEnvironment(), [
      ["/healthz", { status: 200, body: { ...health, plan: "paid" } }],
    ]);
    renderAbout();
    await screen.findByText("Paid (this instance)");
    expect(screen.queryByText("Free (this instance)")).toBeNull();
    expect(screen.getByText("Paid")).toBeDefined();
  });

  it("shows the error state when the health check fails", async () => {
    answers(entitlement(), [
      ["/healthz", { status: 503, body: { error: "not_ready" } }],
    ]);
    renderAbout();
    await screen.findByText("Something went wrong");
    expect(
      screen.getByText("The server answered 503 (not_ready)."),
    ).toBeDefined();
    await screen.findByText("Editable servers");
  });

  // P9-C review N5: a failure other than the Free 402 must not claim that
  // nothing is configured.
  it("shows an error with Retry when the channels cannot be read, not the no-outbound sentence", async () => {
    answers(paidFromEnvironment(), [
      [
        "/api/v1/notifications/channels",
        { status: 500, body: { error: "internal" } },
      ],
    ]);
    renderAbout();
    await screen.findByText("27.0.0");
    const card = await screen.findByText("Outbound connections");
    const section = card.closest("section");
    expect(section).not.toBeNull();
    if (section === null) return;
    await within(section).findByText("Something went wrong");
    expect(
      within(section).getByText("The server hit an error. Check its log."),
    ).toBeDefined();
    expect(
      within(section).getByRole("button", { name: "Retry" }),
    ).toBeDefined();
    expect(screen.queryByText(/No outbound connection/)).toBeNull();
  });

  it("tells a reader below admin who sees the outbound list", async () => {
    const fetchMock = answers(paidFromEnvironment());
    renderAbout({ ...OWNER, user: { ...OWNER.user, role: "editor" } });
    await screen.findByText("27.0.0");
    expect(screen.getByText(OUTBOUND_FOR_MANAGERS)).toBeDefined();
    expect(screen.queryByText(/No outbound connection/)).toBeNull();
    // The channels are never asked for below admin (the route is 403).
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/api/v1/notifications/channels"),
      ),
    ).toBe(false);
  });

  it("shows the error state when the registry fails", async () => {
    answers(entitlement(), [
      ["/api/v1/plan/registry", { status: 500, body: { error: "internal" } }],
    ]);
    renderAbout();
    await screen.findByText("Something went wrong");
    expect(
      screen.getByText("The server hit an error. Check its log."),
    ).toBeDefined();
    await screen.findByText("27.0.0");
    expect(screen.getByText(SOURCE_AVAILABLE)).toBeDefined();
  });
});
