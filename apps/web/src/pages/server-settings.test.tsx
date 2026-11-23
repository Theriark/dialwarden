// @vitest-environment jsdom
// The typed editor page (screen 3): Reset discards an edit back to the
// server answer - never the pack default, which on a secret would queue a
// wipe of the stored password - and the server's lint of the stored values,
// including the server-evaluated rules, shows inline (the code review
// findings H2 and M3 of THE-2518).
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

const SETTING = {
  key: "expRate",
  label: "Exp rate",
  file: "settings",
  locator: { kind: "ini", section: null, key: "ExpRate" },
  type: "float",
  min: 0,
  max: 5,
  description: "How fast the experience grows.",
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
      paths: { linux: ["PalWorldSettings.ini"] },
      adapter: "ini",
      encoding: "utf-8",
      applyPolicy: "anytime",
    },
  ],
  settings: [SETTING],
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
  createdAt: "2026-11-23T00:00:00Z",
  updatedAt: "2026-11-23T00:00:00Z",
  lastEditedAt: null,
};

function settingsAnswer(overrides: Record<string, unknown> = {}) {
  return {
    serverId: "home",
    packId: "testpack",
    packVersion: "1.0",
    editable: true,
    files: [
      {
        fileId: "settings",
        path: "PalWorldSettings.ini",
        exists: true,
        sha256: null,
      },
    ],
    values: { expRate: 1 },
    lint: [],
    ...overrides,
  };
}

function stubWorld(extra?: Handler) {
  return stubFetch((route) => {
    const special = extra?.(route);
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
    if (method === "GET" && path === "/api/v1/servers/home") {
      return { status: 200, body: SERVER };
    }
    if (method === "GET" && path === "/api/v1/servers/home/settings") {
      return { status: 200, body: settingsAnswer() };
    }
    if (method === "GET" && path === "/api/v1/games/testpack/settings-meta") {
      return { status: 200, body: META };
    }
    return undefined;
  });
}

describe("ServerSettingsPage", () => {
  it("Reset discards the edit and the field falls back to the server answer", async () => {
    stubViewport(1280);
    stubWorld();
    startRouter("/servers/home/settings");

    const field = (await screen.findByLabelText(
      "Exp rate",
    )) as HTMLInputElement;
    expect(field.value).toBe("1");

    fireEvent.change(field, { target: { value: "2" } });
    expect(screen.getByText("Edited")).toBeTruthy();
    expect(screen.getByText("1 setting changed")).toBeTruthy();

    screen.getByRole("button", { name: "Reset" }).click();
    expect(screen.queryByText("Edited")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Review and save" }),
    ).toBeNull();
    expect((screen.getByLabelText("Exp rate") as HTMLInputElement).value).toBe(
      "1",
    );
  });

  it("shows the server's lint of the stored values inline", async () => {
    stubViewport(1280);
    stubWorld(([method, path]) => {
      if (method === "GET" && path === "/api/v1/servers/home/settings") {
        return {
          status: 200,
          body: settingsAnswer({
            values: { expRate: 2 },
            lint: [
              {
                fileId: "settings",
                settingKey: "expRate",
                code: "rule",
                severity: "warning",
                message: "The panel asks for a lower rate.",
                line: null,
                column: null,
                serverEvaluated: true,
              },
            ],
          }),
        };
      }
      return undefined;
    });
    startRouter("/servers/home/settings");

    await screen.findByText("The panel asks for a lower rate.");

    // The server's word about the stored values never blocks the save.
    const field = (await screen.findByLabelText(
      "Exp rate",
    )) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "4" } });
    const save = screen.getByRole("button", {
      name: "Review and save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });
});
