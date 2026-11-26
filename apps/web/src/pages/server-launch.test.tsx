// @vitest-environment jsdom
// The launch page (dev-work-plan P6-C): who edits the flags. The server's
// answer carries this caller's grant (P10-A L22): an editor with a read
// grant gets disabled flags, no save bar and a sentence about the grant,
// while the owner edits a flag and gets the save bar (P10-B2 review L1,
// test check G1).
import { fireEvent, screen } from "@testing-library/react";
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

const PORT = {
  key: "Port",
  label: "Game port",
  file: "launch",
  locator: { kind: "launch", flag: "-port" },
  type: "int",
  default: 7777,
  min: 1024,
  max: 65535,
  group: "Network",
  description: "The UDP port the server listens on for players.",
  restartRequired: true,
};

const NAME = {
  key: "ServerName",
  label: "Server name",
  file: "launch",
  locator: { kind: "launch", flag: "-name" },
  type: "string",
  default: "Home",
  group: "Server",
  description: "The name shown in the server browser.",
};

const META = {
  id: "testpack",
  version: "1.0",
  displayName: "Test Pack",
  steamAppId: 1,
  os: ["linux"],
  files: [
    {
      id: "settings",
      paths: { linux: ["Settings.ini"] },
      adapter: "ini",
      encoding: "utf-8",
      applyPolicy: "anytime",
    },
    {
      id: "launch",
      paths: { linux: ["launch.txt"] },
      adapter: "launch",
      encoding: "utf-8",
      applyPolicy: "stopped-only",
    },
  ],
  settings: [PORT, NAME],
  rules: [],
  presets: [],
  hooksSupported: [],
  sources: [],
};

const SERVER = {
  id: "home",
  name: "Home",
  packId: "testpack",
  displayName: "Test Pack",
  os: "linux",
  connector: { kind: "local", root: "/srv/home" },
  hasPassword: false,
  demo: false,
  editable: true,
  access: "write",
  createdAt: "2026-11-23T00:00:00Z",
  updatedAt: "2026-11-23T00:00:00Z",
  lastEditedAt: null,
};

function settingsAnswer(access: "read" | "write") {
  return {
    serverId: "home",
    packId: "testpack",
    packVersion: "1.0",
    editable: true,
    access,
    files: [
      { fileId: "settings", path: "Settings.ini", exists: true, sha256: null },
      { fileId: "launch", path: "launch.txt", exists: true, sha256: null },
    ],
    values: { Port: 7777, ServerName: "Home" },
    lint: [],
  };
}

function stubWorld(role: string, access: "read" | "write", extra?: Handler) {
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
      return { status: 200, body: { ...OWNER, user: { ...OWNER.user, role } } };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: entitlement() };
    }
    if (method === "GET" && path === "/api/v1/servers/home") {
      return { status: 200, body: { ...SERVER, access } };
    }
    if (method === "GET" && path === "/api/v1/servers/home/settings") {
      return { status: 200, body: settingsAnswer(access) };
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
    if (method === "GET" && path === "/api/v1/games/testpack/settings-meta") {
      return { status: 200, body: META };
    }
    return undefined;
  });
}

describe("ServerLaunchPage", () => {
  it("keeps an editor whose grant only reads this server out of the flags (L22)", async () => {
    stubViewport(1280);
    stubWorld("editor", "read");
    startRouter("/servers/home/launch");
    await screen.findByRole("heading", { name: "Home launch" });
    expect(
      screen.getByText(
        /You are signed in as editor with read access to this server: you read these flags\. A write grant from the owner or an admin changes them\./,
      ),
    ).toBeTruthy();
    const port = (await screen.findByLabelText(
      "Game port",
    )) as HTMLInputElement;
    expect(port.value).toBe("7777");
    expect(port.disabled).toBe(true);
    const name = screen.getByLabelText("Server name") as HTMLInputElement;
    expect(name.disabled).toBe(true);
    // A programmatic change reaches no draft either: no save bar appears.
    fireEvent.change(port, { target: { value: "7778" } });
    expect(screen.queryByText(/flag changed/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Review and save" }),
    ).toBeNull();
    // The plan's own notice stays off: the server is editable on this plan.
    expect(screen.queryByText(/read-only on the Free plan/)).toBeNull();
  });

  it("lets the owner edit a flag and offers the save bar", async () => {
    stubViewport(1280);
    stubWorld("owner", "write");
    startRouter("/servers/home/launch");
    await screen.findByRole("heading", { name: "Home launch" });
    expect(screen.queryByText(/You are signed in as/)).toBeNull();
    const port = (await screen.findByLabelText(
      "Game port",
    )) as HTMLInputElement;
    expect(port.disabled).toBe(false);
    fireEvent.change(port, { target: { value: "7778" } });
    await screen.findByText("1 flag changed");
    expect(
      screen.getByRole("button", { name: "Review and save" }),
    ).toBeTruthy();
  });
});
