// @vitest-environment jsdom
// The typed editor page (screen 3): Reset discards an edit back to the
// server answer - never the pack default, which on a secret would queue a
// wipe of the stored password - a cleared secret box means keep, and the
// server's lint of the stored values, including the server-evaluated rules,
// shows inline until the user edits that value (the code review findings
// H2 and M3 of THE-2518, M6 and L4 of THE-2526).
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

const SECRET = {
  key: "adminSecret",
  label: "Admin secret",
  file: "settings",
  locator: { kind: "ini", section: null, key: "AdminPassword" },
  type: "string",
  secret: true,
  description: "Who may administer the server.",
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
  settings: [SETTING, SECRET],
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
    values: { expRate: 1, adminSecret: "••••••" },
    lint: [],
    ...overrides,
  };
}

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
  it("lets a viewer read but not edit, even where the plan allows edits", async () => {
    stubViewport(1280);
    // The settings answer says editable (the plan's flag, the same for every
    // role); the session says viewer.
    stubWorld(([method, path]) =>
      method === "GET" && path === "/api/v1/auth/session"
        ? {
            status: 200,
            body: { ...OWNER, user: { ...OWNER.user, role: "viewer" } },
          }
        : undefined,
    );
    startRouter("/servers/home/settings");
    const field = (await screen.findByLabelText(
      "Exp rate",
    )) as HTMLInputElement;
    expect(field.value).toBe("1");
    expect(field.disabled).toBe(true);
    expect(
      screen.getByText(/You are signed in as viewer: you read these settings/),
    ).toBeTruthy();
    fireEvent.change(field, { target: { value: "2" } });
    expect(screen.queryByText("Edited")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Review and save" }),
    ).toBeNull();
  });

  it("lets an editor edit where the plan allows edits", async () => {
    stubViewport(1280);
    stubWorld(([method, path]) =>
      method === "GET" && path === "/api/v1/auth/session"
        ? {
            status: 200,
            body: { ...OWNER, user: { ...OWNER.user, role: "editor" } },
          }
        : undefined,
    );
    startRouter("/servers/home/settings");
    const field = (await screen.findByLabelText(
      "Exp rate",
    )) as HTMLInputElement;
    expect(field.disabled).toBe(false);
    expect(screen.queryByText(/You are signed in as/)).toBeNull();
  });

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

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => {
      expect(screen.queryByText("Edited")).toBeNull();
    });
    expect(
      screen.queryByRole("button", { name: "Review and save" }),
    ).toBeNull();
    expect((screen.getByLabelText("Exp rate") as HTMLInputElement).value).toBe(
      "1",
    );
  });

  it("a secret typed and cleared again keeps the stored value", async () => {
    stubViewport(1280);
    stubWorld();
    startRouter("/servers/home/settings");

    const field = (await screen.findByLabelText(
      "Admin secret",
    )) as HTMLInputElement;
    expect(field.value).toBe("");

    fireEvent.change(field, { target: { value: "n" } });
    expect(screen.getByText("Edited")).toBeTruthy();
    expect(screen.getByText("1 setting changed")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Admin secret"), {
      target: { value: "" },
    });
    await waitFor(() => {
      expect(screen.queryByText("Edited")).toBeNull();
    });
    expect(
      screen.queryByRole("button", { name: "Review and save" }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Admin secret") as HTMLInputElement).placeholder,
    ).toBe("Unchanged");
  });

  it("shows the server's lint of the stored values inline", async () => {
    stubViewport(1280);
    stubWorld(([method, path]) => {
      if (method === "GET" && path === "/api/v1/servers/home/settings") {
        return {
          status: 200,
          body: settingsAnswer({
            values: { expRate: 2, adminSecret: "••••••" },
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

    // The server's word about the stored values never blocks the save, and
    // it leaves the field once the user edits that value: it spoke about
    // the stored 2, not the draft.
    const field = (await screen.findByLabelText(
      "Exp rate",
    )) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "4" } });
    const save = screen.getByRole("button", {
      name: "Review and save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await waitFor(() => {
      expect(screen.queryByText("The panel asks for a lower rate.")).toBeNull();
    });

    // Back at the stored value, the server's message applies again.
    fireEvent.change(screen.getByLabelText("Exp rate"), {
      target: { value: "2" },
    });
    await screen.findByText("The panel asks for a lower rate.");
  });
});
