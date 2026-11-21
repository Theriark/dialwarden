// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { keys } from "../api/queries";
import type { SignedIn } from "../api/schema";
import { readPendingChallenge, setPendingChallenge } from "../api/session";
import { entitlement } from "../test/fixtures";
import {
  bodyOf,
  OWNER,
  resetAfterEach,
  stubFetch,
  type Answer,
} from "../test/render";
import { startRouter } from "../test/start";

afterEach(resetAfterEach);

interface World {
  session: SignedIn | null;
  /** What POST /api/v1/auth/login/totp answers; it records the bodies. */
  totp: (body: unknown) => Answer;
  bodies: unknown[];
}

function stubWorld(world: World) {
  return stubFetch(([method, path], init) => {
    if (method === "GET" && path === "/api/v1/setup") {
      return { status: 200, body: { required: false } };
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
    if (method === "POST" && path === "/api/v1/auth/login") {
      return {
        status: 200,
        body: { status: "totp_required", challenge: "c-1" },
      };
    }
    if (method === "POST" && path === "/api/v1/auth/login/totp") {
      const body = bodyOf(init);
      world.bodies.push(body);
      return world.totp(body);
    }
    return undefined;
  });
}

function world(totp: World["totp"]): World {
  return { session: null, totp, bodies: [] };
}

const CODE_LABEL = "Code from your authenticator app";

const continueButton = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Continue" });

describe("second sign-in step", () => {
  it("follows a totp_required answer, keeps the challenge out of the URL and signs in", async () => {
    const state = world(() => {
      state.session = OWNER;
      return { status: 200, body: OWNER };
    });
    stubWorld(state);
    const { router, client } = startRouter("/login?redirect=%2Fpresets");
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("E-mail address"),
      "owner@example.test",
    );
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Second step" });
    expect(router.state.location.pathname).toBe("/login/2fa");
    expect(router.state.location.search).toEqual({ redirect: "/presets" });
    expect(router.state.location.href).not.toContain("c-1");
    expect(readPendingChallenge()).toBe("c-1");

    await user.type(screen.getByLabelText(CODE_LABEL), "123 456");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Coming in a later phase");
    expect(router.state.location.pathname).toBe("/presets");
    expect(state.bodies).toEqual([{ challenge: "c-1", code: "123456" }]);
    expect(client.getQueryData(keys.session)).toEqual(OWNER);
    expect(readPendingChallenge()).toBeNull();
  });

  it("asks for the password first when there is no challenge", async () => {
    stubWorld(world(() => ({ status: 401, body: { error: "invalid_code" } })));
    startRouter("/login/2fa");
    const alert = await screen.findByRole("status");
    expect(alert.textContent).toContain("Sign in with your password first.");
    expect(
      screen.getByRole("link", { name: "Start the sign-in again" }),
    ).toBeDefined();
    expect(screen.queryByLabelText(CODE_LABEL)).toBeNull();
  });

  it("sends a recovery code instead of the app code", async () => {
    const state = world(() => {
      state.session = OWNER;
      return { status: 200, body: OWNER };
    });
    stubWorld(state);
    setPendingChallenge("c-2");
    const { router } = startRouter("/login/2fa");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Use a recovery code" }),
    );
    expect(screen.queryByLabelText(CODE_LABEL)).toBeNull();
    await user.type(screen.getByLabelText("Recovery code"), " abcd-efgh ");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Fleet" });
    expect(router.state.location.pathname).toBe("/");
    expect(state.bodies).toEqual([
      { challenge: "c-2", recoveryCode: "abcd-efgh" },
    ]);
  });

  it("explains an expired step, disables Continue and drops the challenge on restart", async () => {
    stubWorld(
      world(() => ({ status: 401, body: { error: "challenge_expired" } })),
    );
    setPendingChallenge("c-3");
    const { router } = startRouter("/login/2fa");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(CODE_LABEL), "000000");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const alert = await screen.findByRole("status");
    expect(alert.textContent).toContain(
      "The sign-in step expired after five minutes.",
    );
    expect(continueButton().disabled).toBe(true);
    expect(readPendingChallenge()).toBeNull();

    await user.click(
      screen.getByRole("link", { name: "Start the sign-in again" }),
    );
    await screen.findByRole("heading", { name: "Sign in" });
    expect(router.state.location.pathname).toBe("/login");
    await router.navigate({ to: "/login/2fa" });
    const again = await screen.findByRole("status");
    expect(again.textContent).toContain("Sign in with your password first.");
  });

  it("shows the wrong-code sentence and keeps the form", async () => {
    const state = world(() => ({
      status: 401,
      body: { error: "invalid_code" },
    }));
    stubWorld(state);
    setPendingChallenge("c-4");
    startRouter("/login/2fa");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(CODE_LABEL), "111111");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The code is wrong or was already used.",
    );
    expect(screen.getByLabelText<HTMLInputElement>(CODE_LABEL).value).toBe(
      "111111",
    );
    expect(continueButton().disabled).toBe(false);
    expect(state.bodies).toEqual([{ challenge: "c-4", code: "111111" }]);
  });
});
