// @vitest-environment jsdom
// The presets page (screen 7): the two server selects start on a placeholder
// with the empty value, so Create and Apply with diff stay off until a real
// choice (live check F12), and a preset the server already holds answers in
// plain words instead of the raw 422 (live check F11).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { entitlement, OWNER } from "../test/fixtures";
import {
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";

afterEach(resetAfterEach);

function server(id: string, name: string) {
  return {
    id,
    name,
    packId: "testpack",
    displayName: "Test Pack",
    os: "linux",
    connector: { kind: "local", root: `/srv/${id}` },
    hasPassword: false,
    demo: false,
    editable: true,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    lastEditedAt: null,
  };
}

const PRESET = {
  id: "p1",
  name: "Weekend rates",
  description: "Double experience for the weekend.",
  packId: "testpack",
  createdAt: "2026-11-23T12:00:00Z",
  values: { expRate: 2 },
};

function stubWorld(extra?: Handler) {
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
      return { status: 200, body: OWNER };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: entitlement() };
    }
    if (method === "GET" && path === "/api/v1/servers") {
      return {
        status: 200,
        body: { items: [server("home", "Home"), server("away", "Away")] },
      };
    }
    if (method === "GET" && path === "/api/v1/presets") {
      return { status: 200, body: { items: [PRESET] } };
    }
    return undefined;
  });
}

describe("PresetsPage", () => {
  it("Apply to starts on a placeholder and Apply with diff waits for a choice", async () => {
    stubViewport(1280);
    stubWorld();
    startRouter("/presets");

    const select = (await screen.findByLabelText(
      "Apply to",
    )) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.options[0]?.textContent).toBe("Choose a server");
    const apply = screen.getByRole("button", {
      name: "Apply with diff",
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(select, { target: { value: "away" } });
    expect(select.value).toBe("away");
    expect(apply.disabled).toBe(false);
  });

  it("From server starts on a placeholder and Create waits for a choice", async () => {
    stubViewport(1280);
    stubWorld();
    startRouter("/presets");

    fireEvent.click(
      await screen.findByRole("button", { name: "Create preset" }),
    );
    const select = (await screen.findByLabelText(
      "From server",
    )) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.options[0]?.textContent).toBe("Choose a server");
    const create = screen.getByRole("button", {
      name: "Create",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });

  it("says in plain words when the server already holds the preset", async () => {
    stubViewport(1280);
    stubWorld(([method, path]) => {
      if (method === "POST" && path === "/api/v1/presets/p1/apply") {
        return { status: 422, body: { error: "no_change" } };
      }
      return undefined;
    });
    startRouter("/presets");

    const select = (await screen.findByLabelText(
      "Apply to",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "home" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply with diff" }));

    await screen.findByText("This server already holds these values.");
    await waitFor(() => {
      expect(screen.queryByText(/answered 422/)).toBeNull();
    });
  });
});
