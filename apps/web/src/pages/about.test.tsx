// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entitlement, health, registry } from "../test/fixtures";
import {
  renderWithProviders,
  stubFetch,
  testQueryClient,
  withSession,
} from "../test/render";
import { AboutPage, NOT_AFFILIATED, SOURCE_AVAILABLE } from "./about";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AboutPage", () => {
  it("shows the build facts, the plans and the legal words", async () => {
    stubFetch(([method, path]) => {
      if (method !== "GET") {
        return undefined;
      }
      if (path === "/healthz") {
        return { status: 200, body: health };
      }
      if (path === "/api/v1/plan/registry") {
        return { status: 200, body: registry };
      }
      if (path === "/api/v1/entitlement") {
        return { status: 200, body: entitlement() };
      }
      return undefined;
    });
    const client = testQueryClient();
    withSession(client);
    renderWithProviders(<AboutPage />, client);
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
  });

  it("shows the error state when the health check fails", async () => {
    stubFetch(([, path]) => {
      if (path === "/healthz") {
        return { status: 503, body: { error: "not_ready" } };
      }
      if (path === "/api/v1/plan/registry") {
        return { status: 200, body: registry };
      }
      return undefined;
    });
    const client = testQueryClient();
    withSession(client);
    renderWithProviders(<AboutPage />, client);
    await screen.findByText("Something went wrong");
    expect(
      screen.getByText("The server answered 503 (not_ready)."),
    ).toBeDefined();
  });
});
