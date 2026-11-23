// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { keys } from "../../api/queries";
import type { Entitlement } from "../../api/schema";
import { entitlement, paidFromEnvironment } from "../../test/fixtures";
import {
  headerOf,
  OWNER,
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../../test/render";
import { startRouter } from "../../test/start";
import { THEME_KEY } from "../../theme/theme";

afterEach(resetAfterEach);

function stubSignedIn(current: Entitlement = entitlement(), extra?: Handler) {
  return stubFetch((route, init) => {
    const special = extra?.(route, init);
    if (special !== undefined) {
      return special;
    }
    const [method, path] = route;
    if (method === "GET" && path === "/api/v1/auth/session") {
      return { status: 200, body: OWNER };
    }
    if (method === "GET" && path === "/api/v1/setup") {
      return { status: 200, body: { required: false } };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: current };
    }
    return undefined;
  });
}

const mainNav = () => screen.getByRole("navigation", { name: "Main" });

describe("AppShell", () => {
  it("renders the phone layout: four tabs plus More, the rest in a sheet", async () => {
    // No viewport stub: jsdom has no matchMedia, which the shell treats as the
    // narrowest width.
    stubSignedIn();
    const { router } = startRouter("/schedules");
    await screen.findByText("Coming in a later phase");
    expect(router.state.location.pathname).toBe("/schedules");
    const nav = mainNav();
    for (const label of ["Fleet", "Activity", "Settings", "More"]) {
      expect(within(nav).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(within(nav).getAllByRole("link").length).toBe(4);
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    for (const label of ["Schedules", "Matrix", "Reports", "Users"]) {
      expect(within(sheet).getByText(label)).toBeDefined();
    }
    await waitFor(() => {
      expect(document.title).toBe("Schedules · Dialwarden");
    });
  });

  it("renders the navigation column at 1440 and remembers the rail", async () => {
    stubViewport(1440);
    stubSignedIn();
    startRouter("/schedules");
    await screen.findByText("Coming in a later phase");
    const links = within(mainNav()).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Fleet",
      "Presets",
      "Schedules",
      "Matrix",
      "Reports",
      "Activity",
      "Users",
      "Settings",
    ]);
    const active = links.filter((link) => link.getAttribute("aria-current"));
    expect(active.map((link) => link.textContent)).toEqual(["Schedules"]);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Collapse navigation" }),
    );
    expect(window.localStorage.getItem("dw.nav")).toBe("rail");
    expect(
      screen.getByRole("button", { name: "Expand navigation" }),
    ).toBeDefined();
    // The rail keeps every entry reachable by name.
    expect(
      within(mainNav()).getByRole("link", { name: "Users" }),
    ).toBeDefined();

    resetAfterEach();
    window.localStorage.setItem("dw.nav", "rail");
    stubViewport(1440);
    stubSignedIn();
    startRouter("/schedules");
    await screen.findByText("Coming in a later phase");
    expect(
      screen.getByRole("button", { name: "Expand navigation" }),
    ).toBeDefined();
  });

  it("opens the navigation sheet at 768 and closes it on a choice", async () => {
    stubViewport(768);
    stubSignedIn();
    const { router } = startRouter("/schedules");
    await screen.findByText("Coming in a later phase");
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const sheet = await screen.findByRole("dialog", { name: "Navigation" });
    await user.click(within(sheet).getByRole("link", { name: "Matrix" }));
    await screen.findByRole("heading", { name: "Matrix" });
    expect(router.state.location.pathname).toBe("/matrix");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    });
  });

  it("shows the Development licence banner while an internal-dev licence is effective", async () => {
    stubSignedIn(paidFromEnvironment());
    startRouter("/schedules");
    const banner = await screen.findByText(
      "Development licence, not for production",
    );
    expect(banner.closest("[role=status]")).not.toBeNull();
    expect(screen.getByText("(Theriark Development)")).toBeDefined();
  });

  it("signs out from the account menu", async () => {
    const calls: (string | null)[] = [];
    stubSignedIn(entitlement(), ([method, path], init) => {
      if (method === "POST" && path === "/api/v1/auth/logout") {
        calls.push(headerOf(init, "x-csrf-token"));
        return { status: 204 };
      }
      return undefined;
    });
    const { router, client } = startRouter("/schedules");
    await screen.findByText("Coming in a later phase");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Account menu for Owner Person" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(router.state.location.pathname).toBe("/login");
    expect(calls).toEqual(["csrf-test"]);
    expect(client.getQueryData(keys.session)).toBeNull();
  });

  it("reaches About from the account menu", async () => {
    stubSignedIn(entitlement(), ([method, path]) => {
      if (method === "GET" && path === "/healthz") {
        return { status: 500, body: { error: "internal" } };
      }
      if (method === "GET" && path === "/api/v1/plan/registry") {
        return { status: 500, body: { error: "internal" };
      }
      return undefined;
    });
    const { router } = startRouter("/schedules");
    await screen.findByText("Coming in a later phase");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Account menu for Owner Person" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "About" }));
    await screen.findByRole("heading", { name: "About" });
    expect(router.state.location.pathname).toBe("/about");
  });

  it("switches the theme from the menu and stores the choice", async () => {
    stubSignedIn();
    startRouter("/schedules");
    await screen.findByText("Coming in a later phase");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Theme" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Dark" }),
    );
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });
});
