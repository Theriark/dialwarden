// @vitest-environment jsdom
// The hooks page: the owner sets a docker proxy hook and the actions show
// what it runs; a run goes through the confirm dialog; a viewer sees
// everything disabled with the reason.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HooksView, SignedIn } from "../api/schema";
import { entitlement, OWNER } from "../test/fixtures";
import {
  bodyOf,
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";
import { hooksErrorMessage, sourceWord } from "./server-hooks";
import { ApiError } from "../api/client";

afterEach(resetAfterEach);

const SERVER = {
  id: "home",
  name: "Home",
  packId: "palworld",
  displayName: "Palworld",
  os: "linux",
  connector: { kind: "local", root: "/srv/home" },
  hasPassword: false,
  demo: false,
  editable: true,
  createdAt: "2026-11-23T00:00:00Z",
  updatedAt: "2026-11-23T00:00:00Z",
  lastEditedAt: null,
};

const VIEWER: SignedIn = {
  ...OWNER,
  user: { ...OWNER.user, role: "viewer" },
};

function view(overrides: Partial<HooksView> = {}): HooksView {
  return {
    packId: "palworld",
    hooksSupported: ["save", "stop"],
    hook: null,
    probes: [
      { kind: "palworldRest", host: null, port: null, hasPassword: false },
    ],
    available: { save: null, stop: null, start: null, restart: null },
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

function stubWorld(session: SignedIn, extra?: Handler) {
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
      return { status: 200, body: entitlement() };
    }
    if (method === "GET" && path === "/api/v1/servers/home") {
      return { status: 200, body: SERVER };
    }
    if (method === "GET" && path === "/api/v1/servers/home/hooks") {
      return { status: 200, body: view() };
    }
    if (method === "GET" && path === "/api/v1/servers/home/status") {
      return {
        status: 200,
        body: {
          state: "unknown",
          players: null,
          source: null,
          at: "2026-11-24T18:00:00Z",
          pending: 0,
        },
      };
    }
    return undefined;
  });
}

describe("ServerHooksPage", () => {
  it("lets the owner set a docker proxy hook and shows what it runs", async () => {
    stubViewport(1280);
    const configured = view({
      hook: {
        kind: "dockerProxy",
        url: "http://127.0.0.1:2375",
        containerLabel: "dialwarden=e2e",
      },
      available: {
        save: "palworldRest",
        stop: "palworldRest",
        start: "dockerProxy",
        restart: "dockerProxy",
      },
      updatedAt: "2026-11-24T18:05:00Z",
      updatedBy: "owner@example.test",
    });
    const fetchMock = stubWorld(OWNER, ([method, path]) => {
      if (method === "PUT" && path === "/api/v1/servers/home/hooks") {
        return { status: 200, body: configured };
      }
      return undefined;
    });
    startRouter("/servers/home/hooks");

    await screen.findByRole("heading", { name: "Home hooks" });
    expect(screen.getAllByText("Not available").length).toBe(4);
    expect(
      screen.getAllByText(
        "No probe is configured for this server. Set one up on the Hooks tab.",
      ).length,
    ).toBe(2);

    fireEvent.click(screen.getByLabelText(/Docker socket proxy/));
    fireEvent.change(screen.getByLabelText("Proxy address"), {
      target: { value: "http://127.0.0.1:2375" },
    });
    fireEvent.change(screen.getByLabelText("Container label"), {
      target: { value: "dialwarden=e2e" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save hook" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (item) => item[1]?.method === "PUT",
      );
      expect(call?.[0]).toBe("/api/v1/servers/home/hooks");
      expect(bodyOf(call?.[1] ?? {})).toEqual({
        hook: {
          kind: "dockerProxy",
          url: "http://127.0.0.1:2375",
          containerLabel: "dialwarden=e2e",
        },
      });
    });
    await screen.findByText("Hook saved");
    expect(screen.getAllByText("docker proxy").length).toBe(2);
    expect(screen.getAllByText("Palworld REST API").length).toBe(2);
    expect(screen.queryByText("Not available")).toBeNull();
    expect(
      screen.getByText(/Last changed .* by owner@example.test/),
    ).toBeTruthy();
  });

  it("runs an action after the confirm dialog", async () => {
    stubViewport(1280);
    const fetchMock = stubWorld(OWNER, ([method, path]) => {
      if (method === "GET" && path === "/api/v1/servers/home/hooks") {
        return {
          status: 200,
          body: view({
            hook: {
              kind: "dockerProxy",
              url: "http://127.0.0.1:2375",
              containerLabel: "dialwarden=e2e",
            },
            available: {
              save: null,
              stop: "dockerProxy",
              start: "dockerProxy",
              restart: "dockerProxy",
            },
          }),
        };
      }
      if (method === "POST" && path === "/api/v1/servers/home/hooks/run") {
        return {
          status: 200,
          body: {
            action: "restart",
            source: "dockerProxy",
            at: "2026-11-24T18:10:00Z",
            stopped: null,
            flushed: null,
          },
        };
      }
      return undefined;
    });
    startRouter("/servers/home/hooks");

    await screen.findByRole("heading", { name: "Home hooks" });
    fireEvent.click(await screen.findByRole("button", { name: "Run restart" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Run the restart hook?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Run restart" }),
    );
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((item) =>
        String(item[0]).endsWith("/hooks/run"),
      );
      expect(bodyOf(call?.[1] ?? {})).toEqual({ action: "restart" });
    });
    await screen.findByText("Restart ran");
  });

  it("keeps a viewer out of the controls with the reason", async () => {
    stubViewport(1280);
    stubWorld(VIEWER);
    startRouter("/servers/home/hooks");
    await screen.findByRole("heading", { name: "Home hooks" });
    expect(
      screen.getByText(/Only the owner or an admin changes the hook/),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText(/SSH command/) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Save hook" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Run stop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("puts the hook refusals into sentences", () => {
    expect(
      hooksErrorMessage(new ApiError(422, { error: "hook_needs_sftp" })),
    ).toContain("SFTP");
    expect(
      hooksErrorMessage(
        new ApiError(422, { error: "unknown_probe", kind: "a2s" } as never),
      ),
    ).toBe("This pack has no a2s probe.");
    expect(
      hooksErrorMessage(new ApiError(409, { error: "hook_not_configured" })),
    ).toContain("No hook can run this action");
    expect(sourceWord("sshCommand")).toBe("SSH command");
    expect(sourceWord("other")).toBe("other");
  });
});
