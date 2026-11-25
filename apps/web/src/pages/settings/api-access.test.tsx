// @vitest-environment jsdom
// The API tokens page: on Free the form is stopped with the hint and the
// list keeps its revoke; on Paid a new token is shown once and the list
// refreshes; the role choice never reaches above the signed-in user's own.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { TokenView } from "../../api/schema";
import { entitlement, OWNER, paidFromUi } from "../../test/fixtures";
import {
  bodyOf,
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../../test/render";
import { startRouter } from "../../test/start";

afterEach(resetAfterEach);

const EXISTING: TokenView = {
  id: "t1",
  name: "Backup script",
  role: "viewer",
  prefix: "dw_ab12",
  createdAt: "2026-11-24T10:00:00Z",
  lastUsedAt: null,
};

function stubWorld(paid: boolean, session = OWNER, extra?: Handler) {
  return stubFetch((route, init) => {
    const special = extra?.(route, init);
    if (special !== undefined) {
      return special;
    }
    const [method, path] = route;
    if (method === "GET" && path === "/api/v1/setup") {
      return { status: 200, body: { required: false } };
    }
    if (method === "GET" && path === "/api/v1/auth/session") {
      return { status: 200, body: session };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: paid ? paidFromUi() : entitlement() };
    }
    if (method === "GET" && path === "/api/v1/tokens") {
      return { status: 200, body: { items: [EXISTING] } };
    }
    return undefined;
  });
}

describe("ApiAccessPage", () => {
  it("stops the form on Free with the hint and keeps the list", async () => {
    stubViewport(1280);
    stubWorld(false);
    startRouter("/settings/tokens");
    await screen.findByText("Stopped on Free");
    expect(
      screen.getByText("API tokens is part of the Paid plan."),
    ).toBeDefined();
    expect(screen.getByLabelText("Name")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Create token" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(await screen.findByText("Backup script")).toBeDefined();
    expect(screen.getByRole("button", { name: "Revoke" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("makes a token on Paid and shows the value once", async () => {
    stubViewport(1280);
    const bodies: unknown[] = [];
    stubWorld(true, OWNER, ([method, path], init) => {
      if (method === "POST" && path === "/api/v1/tokens") {
        bodies.push(bodyOf(init));
        return {
          status: 201,
          body: {
            ...EXISTING,
            id: "t2",
            name: "Deploy job",
            role: "editor",
            prefix: "dw_cd34",
            token: "dw_cd34_value_shown_once",
          },
        };
      }
      return undefined;
    });
    startRouter("/settings/tokens");
    await screen.findByText("Ready");
    const user = userEvent.setup();
    const name = screen.getByLabelText("Name");
    await user.type(name, "Deploy job");
    await user.selectOptions(screen.getByLabelText("Acts as"), "editor");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const reveal = await screen.findByRole("dialog", {
      name: "Your new API token",
    });
    expect(within(reveal).getByLabelText("API token").textContent).toBe(
      "dw_cd34_value_shown_once",
    );
    expect(bodies).toEqual([{ name: "Deploy job", role: "editor" }]);
    await waitFor(() => {
      expect((name as HTMLInputElement).value).toBe("");
    });
  });

  it("offers an editor only the editor and viewer roles", async () => {
    stubViewport(1280);
    stubWorld(true, { ...OWNER, user: { ...OWNER.user, role: "editor" } });
    startRouter("/settings/tokens");
    await screen.findByText("Ready");
    const options = within(screen.getByLabelText("Acts as"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Editor", "Viewer"]);
  });
});
