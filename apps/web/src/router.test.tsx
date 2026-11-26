// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { currentCsrf } from "./api/client";
import { keys } from "./api/queries";
import type { SignedIn } from "./api/schema";
import { entitlement } from "./test/fixtures";
import {
  bodyOf,
  OWNER,
  resetAfterEach,
  stubFetch,
  type Handler,
} from "./test/render";
import { startRouter } from "./test/start";

afterEach(resetAfterEach);

/** What the owner types to sign in; the stubbed server accepts it as is. */
const OWNER_PASSPHRASE = "owner-passphrase-for-router-tests";

/** The instance as the route guards see it; a test changes it as it goes. */
interface World {
  setupRequired: boolean;
  session: SignedIn | null;
}

function stubWorld(world: World, extra?: Handler) {
  return stubFetch((route, init) => {
    const special = extra?.(route, init);
    if (special !== undefined) {
      return special;
    }
    const [method, path] = route;
    if (method === "GET" && path === "/api/v1/setup") {
      return { status: 200, body: { required: world.setupRequired } };
    }
    if (method === "GET" && path === "/api/v1/auth/session") {
      if (world.session === null) {
        return { status: 401, body: { error: "unauthenticated" } };
      }
      return { status: 200, body: world.session };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: entitlement() };
    }
    return undefined;
  });
}

const buttonNamed = (name: string) =>
  screen.getByRole<HTMLButtonElement>("button", { name });

async function signIn(password = OWNER_PASSPHRASE) {
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText("E-mail address"),
    "owner@example.test",
  );
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("router", () => {
  it("sends a fresh instance to setup", async () => {
    stubWorld({ setupRequired: true, session: null });
    const { router } = startRouter("/settings/licence");
    await screen.findByText("Set up Dialwarden");
    expect(router.state.location.pathname).toBe("/setup");
    expect(screen.getByLabelText("Setup token")).toBeDefined();
  });

  it("sends setup to sign-in once an owner exists", async () => {
    stubWorld({ setupRequired: false, session: null });
    const { router } = startRouter("/setup");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sends an anonymous visitor to sign-in with the redirect", async () => {
    stubWorld({ setupRequired: false, session: null });
    const { router } = startRouter("/about");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/about" });
  });

  it("sends a signed-in visitor of the sign-in page to the fleet", async () => {
    stubWorld({ setupRequired: false, session: OWNER });
    const { router } = startRouter("/login");
    await screen.findByRole("heading", { name: "Fleet" });
    expect(router.state.location.pathname).toBe("/");
  });

  it("shows the wrong-credentials sentence and keeps the form", async () => {
    stubWorld({ setupRequired: false, session: null }, ([method, path]) => {
      if (method === "POST" && path === "/api/v1/auth/login") {
        return { status: 401, body: { error: "invalid_credentials" } };
      }
      return undefined;
    });
    startRouter("/login");
    await signIn("not-the-password");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The e-mail address or password is wrong.",
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("E-mail address").value,
    ).toBe("owner@example.test");
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe(
      "not-the-password",
    );
    expect(buttonNamed("Sign in").disabled).toBe(false);
  });

  it("signs in, remembers the session and follows the redirect", async () => {
    const world: World = { setupRequired: false, session: null };
    const bodies: unknown[] = [];
    stubWorld(world, ([method, path], init) => {
      if (method === "POST" && path === "/api/v1/auth/login") {
        bodies.push(bodyOf(init));
        world.session = OWNER;
        return { status: 200, body: OWNER };
      }
      return undefined;
    });
    const { router, client } = startRouter("/login?redirect=%2Fschedules");
    await signIn();
    await screen.findByRole("heading", { name: "Schedules", level: 1 });
    expect(router.state.location.pathname).toBe("/schedules");
    expect(bodies).toEqual([
      { email: "owner@example.test", password: OWNER_PASSPHRASE },
    ]);
    expect(currentCsrf()).toBe("csrf-test");
    expect(client.getQueryData(keys.session)).toEqual(OWNER);
  });

  it("refuses an outside address as the redirect", async () => {
    const world: World = { setupRequired: false, session: null };
    stubWorld(world, ([method, path]) => {
      if (method === "POST" && path === "/api/v1/auth/login") {
        world.session = OWNER;
        return { status: 200, body: OWNER };
      }
      return undefined;
    });
    const { router } = startRouter(
      "/login?redirect=https%3A%2F%2Fexample.test%2F",
    );
    await signIn();
    await screen.findByRole("heading", { name: "Fleet" });
    expect(router.state.location.pathname).toBe("/");
  });

  it("opens the profile section for /settings", async () => {
    stubWorld({ setupRequired: false, session: OWNER });
    const { router } = startRouter("/settings");
    await screen.findByRole("heading", { name: "Profile" });
    expect(router.state.location.pathname).toBe("/settings/profile");
  });

  it("shows the not-found page for an unknown address", async () => {
    stubWorld({ setupRequired: false, session: OWNER });
    startRouter("/nothing-here");
    await screen.findByText("There is nothing here");
    expect(screen.getByRole("link", { name: "Go to the fleet" })).toBeDefined();
  });

  it("sends the user to sign in again when the server session ends", async () => {
    stubWorld({ setupRequired: false, session: OWNER }, ([method, path]) => {
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 401, body: { error: "unauthenticated" } };
      }
      return undefined;
    });
    const { router, client } = startRouter("/presets");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/presets" });
    expect(client.getQueryData(keys.session)).toBeNull();
    expect(currentCsrf()).toBeNull();
  });
});
