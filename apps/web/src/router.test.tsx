// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "./api/client";
import { createAppRouter } from "./router";
import {
  OWNER,
  renderWithProviders,
  stubFetch,
  testQueryClient,
} from "./test/render";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrf(null);
});

function start(path: string) {
  const client = testQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(client, history);
  renderWithProviders(<RouterProvider router={router} />, client);
  return router;
}

describe("router", () => {
  it("sends a fresh instance to setup", async () => {
    stubFetch(([method, path]) => {
      if (method === "GET" && path === "/api/v1/setup") {
        return { status: 200, body: { required: true } };
      }
      if (method === "GET" && path === "/api/v1/auth/session") {
        return { status: 401, body: { error: "unauthenticated" } };
      }
      return undefined;
    });
    const router = start("/settings/licence");
    await screen.findByText("Set up Dialwarden");
    expect(router.state.location.pathname).toBe("/setup");
    expect(screen.getByLabelText("Setup token")).toBeDefined();
  });

  it("sends an anonymous visitor to sign-in with the redirect", async () => {
    stubFetch(([method, path]) => {
      if (method === "GET" && path === "/api/v1/setup") {
        return { status: 200, body: { required: false } };
      }
      if (method === "GET" && path === "/api/v1/auth/session") {
        return { status: 401, body: { error: "unauthenticated" } };
      }
      return undefined;
    });
    const router = start("/about");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/about" });
  });

  it("shows the wrong-credentials sentence and keeps the form", async () => {
    stubFetch(([method, path]) => {
      if (method === "GET" && path === "/api/v1/setup") {
        return { status: 200, body: { required: false } };
      }
      if (method === "GET" && path === "/api/v1/auth/session") {
        return { status: 401, body: { error: "unauthenticated" } };
      }
      if (method === "POST" && path === "/api/v1/auth/login") {
        return { status: 401, body: { error: "invalid_credentials" } };
      }
      return undefined;
    });
    start("/login");
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("E-mail address"),
      "owner@example.test",
    );
    await user.type(screen.getByLabelText("Password"), "not-the-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The e-mail address or password is wrong.",
    );
  });

  it("opens the shell with the navigation for a signed-in user", async () => {
    stubFetch(([method, path]) => {
      if (method === "GET" && path === "/api/v1/auth/session") {
        return { status: 200, body: OWNER };
      }
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 500, body: { error: "internal" } };
      }
      return undefined;
    });
    const router = start("/presets");
    await screen.findByText("Coming in a later phase");
    expect(router.state.location.pathname).toBe("/presets");
    // jsdom has no matchMedia, so the shell renders its phone layout: four
    // tabs plus More, with the other entries behind the More sheet.
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const label of ["Fleet", "Activity", "Settings", "More"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(nav.querySelectorAll("a").length).toBe(4);
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("dialog", { name: "More" });
    for (const label of ["Schedules", "Matrix", "Reports", "Users"]) {
      expect(screen.getByText(label)).toBeDefined();
    }
    await waitFor(() => {
      expect(document.title).toBe("Presets · Dialwarden");
    });
  });
});
