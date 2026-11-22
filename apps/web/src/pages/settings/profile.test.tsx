// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "../../api/queries";
import type { SignedIn } from "../../api/schema";
import {
  bodyOf,
  cardOf,
  OWNER,
  renderWithProviders,
  resetAfterEach,
  stubFetch,
  testQueryClient,
  withSession,
  type Answer,
} from "../../test/render";
import { ProfilePage } from "./profile";

// The QR code is drawn from the otpauth URI; the drawing itself is not under
// test, and jsdom has no canvas.
vi.mock("qrcode", () => ({
  toDataURL: async () => "data:image/png;base64,QUJD",
}));

afterEach(resetAfterEach);

const WITH_TOTP: SignedIn = {
  ...OWNER,
  user: { ...OWNER.user, totpEnabled: true },
};

const CODES = [
  "aaaa-1111",
  "bbbb-2222",
  "cccc-3333",
  "dddd-4444",
  "eeee-5555",
  "ffff-6666",
  "gggg-7777",
  "hhhh-8888",
  "iiii-9999",
  "jjjj-0000",
];

const PASSWORD = "owner pass 1";
const NEW_PASSWORD = "new passphrase 2026";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

interface World {
  session: SignedIn;
  sessionReads: number;
  bodies: Map<string, unknown[]>;
}

type Extra = (method: string, path: string) => Answer | undefined;

function stubProfile(world: World, extra?: Extra) {
  return stubFetch(([method, path], init) => {
    const body = bodyOf(init);
    if (method !== "GET") {
      const list = world.bodies.get(path) ?? [];
      list.push(body);
      world.bodies.set(path, list);
    }
    const special = extra?.(method, path);
    if (special !== undefined) {
      return special;
    }
    if (method === "GET" && path === "/api/v1/auth/session") {
      world.sessionReads += 1;
      return { status: 200, body: world.session };
    }
    if (method === "PATCH" && path === "/api/v1/auth/profile") {
      const name =
        typeof body === "object" && body !== null && "name" in body
          ? String(body.name)
          : "";
      world.session = {
        ...world.session,
        user: { ...world.session.user, name },
      };
      return { status: 200, body: { user: world.session.user } };
    }
    if (method === "POST" && path === "/api/v1/auth/password") {
      return { status: 204 };
    }
    if (method === "POST" && path === "/api/v1/auth/totp/enrol") {
      const otpauthUri = `otpauth://totp/Dialwarden:owner?secret=${TOTP_SECRET}`;
      return { status: 200, body: { secret: TOTP_SECRET, otpauthUri } };
    }
    if (method === "POST" && path === "/api/v1/auth/totp/enable") {
      world.session = WITH_TOTP;
      return { status: 200, body: { recoveryCodes: CODES } };
    }
    if (method === "POST" && path === "/api/v1/auth/totp/disable") {
      world.session = OWNER;
      return { status: 204 };
    }
    return undefined;
  });
}

function world(session: SignedIn = OWNER): World {
  return { session, sessionReads: 0, bodies: new Map() };
}

function renderProfile(session: SignedIn = OWNER) {
  const client = testQueryClient();
  withSession(client, session);
  const { container } = renderWithProviders(<ProfilePage />, client);
  return { client, container };
}

function fieldIn(scope: HTMLElement, label: string): HTMLInputElement {
  return within(scope).getByLabelText<HTMLInputElement>(label);
}

function buttonIn(scope: HTMLElement, name: string): HTMLButtonElement {
  return within(scope).getByRole<HTMLButtonElement>("button", { name });
}

const CODES_TITLE = "Save your recovery codes";

const dialogNamed = (name: string) => screen.findByRole("dialog", { name });
const alertDialogNamed = (name: string) =>
  screen.findByRole("alertdialog", { name });
const codesDialog = () => screen.queryByRole("dialog", { name: CODES_TITLE });

describe("ProfilePage", () => {
  it("saves the name and keeps Save off while nothing changed", async () => {
    const state = world();
    stubProfile(state);
    const { container } = renderProfile();
    const user = userEvent.setup();
    const card = cardOf(container, "Profile");
    const save = buttonIn(card, "Save");
    expect(save.disabled).toBe(true);
    expect(fieldIn(card, "E-mail address").readOnly).toBe(true);
    await user.type(fieldIn(card, "Name"), " Jr");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await screen.findByText("Profile saved");
    expect(state.bodies.get("/api/v1/auth/profile")).toEqual([
      { name: "Owner Person Jr" },
    ]);
    await waitFor(() => {
      expect(save.disabled).toBe(true);
    });
  });

  it("changes the password and clears the form", async () => {
    const state = world();
    stubProfile(state);
    const { container } = renderProfile();
    const user = userEvent.setup();
    const card = cardOf(container, "Password");
    const button = buttonIn(card, "Change password");
    await user.type(fieldIn(card, "Current password"), PASSWORD);
    await user.type(fieldIn(card, "New password"), NEW_PASSWORD);
    expect(button.disabled).toBe(true);
    await user.type(fieldIn(card, "New password again"), NEW_PASSWORD);
    expect(button.disabled).toBe(false);
    await user.click(button);
    await screen.findByText("Password changed");
    expect(state.bodies.get("/api/v1/auth/password")).toEqual([
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    ]);
    expect(fieldIn(card, "Current password").value).toBe("");
    expect(fieldIn(card, "New password").value).toBe("");
    expect(fieldIn(card, "New password again").value).toBe("");
  });

  it("lands a wrong current password on its field", async () => {
    stubProfile(world(), (method, path) => {
      if (method === "POST" && path === "/api/v1/auth/password") {
        return { status: 401, body: { error: "invalid_credentials" } };
      }
      return undefined;
    });
    const { container } = renderProfile();
    const user = userEvent.setup();
    const card = cardOf(container, "Password");
    await user.type(fieldIn(card, "Current password"), "wrong");
    await user.type(fieldIn(card, "New password"), NEW_PASSWORD);
    await user.type(fieldIn(card, "New password again"), NEW_PASSWORD);
    await user.click(buttonIn(card, "Change password"));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toContain("The current password is wrong.");
    const current = fieldIn(card, "Current password");
    expect(current.getAttribute("aria-invalid")).toBe("true");
  });

  it("turns two-factor on and keeps the recovery codes until they are saved", async () => {
    const state = world();
    stubProfile(state);
    const { client, container } = renderProfile();
    const user = userEvent.setup();
    const card = cardOf(container, "Two-factor sign-in");
    expect(within(card).getByText("Off")).toBeDefined();
    await user.click(buttonIn(card, "Turn on"));
    const enrol = await dialogNamed("Turn on two-factor sign-in");
    await user.type(fieldIn(enrol, "Password"), PASSWORD);
    await user.click(buttonIn(enrol, "Continue"));
    const scan = await dialogNamed("Scan the code");
    expect(state.bodies.get("/api/v1/auth/totp/enrol")).toEqual([
      { password: PASSWORD },
    ]);
    const qrName = "QR code for the authenticator app";
    await within(scan).findByRole("img", { name: qrName });
    const setupKey = within(scan).getByLabelText("Setup key");
    expect(setupKey.textContent).toBe(TOTP_SECRET);
    const turnOn = buttonIn(scan, "Turn on");
    await user.type(fieldIn(scan, "Code from the app"), "12 34");
    expect(turnOn.disabled).toBe(true);
    await user.type(fieldIn(scan, "Code from the app"), " 56");
    expect(turnOn.disabled).toBe(false);
    await user.click(turnOn);
    const codes = await dialogNamed(CODES_TITLE);
    expect(state.bodies.get("/api/v1/auth/totp/enable")).toEqual([
      { code: "123456" },
    ]);
    const shown = () => within(codes).getByLabelText("Recovery codes");
    expect(shown().textContent).toBe(CODES.join("\n"));
    // The session is not refetched while the codes are on screen, and a
    // refetch from elsewhere (the badge flips to On) must not take them away.
    expect(state.sessionReads).toBe(0);
    await client.invalidateQueries({ queryKey: keys.session });
    await within(card).findByText("On");
    expect(codesDialog()).not.toBeNull();
    expect(shown().textContent).toBe(CODES.join("\n"));
    // Neither Escape nor Done closes the dialog before the codes are saved.
    const done = buttonIn(codes, "Done");
    expect(done.disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(codesDialog()).not.toBeNull();
    await user.click(within(codes).getByLabelText("I have saved these codes"));
    expect(done.disabled).toBe(false);
    await user.click(done);
    await waitFor(() => {
      expect(codesDialog()).toBeNull();
    });
    await screen.findByText("Two-factor sign-in is on");
    expect(within(card).getByText("On")).toBeDefined();
  });

  it("turns two-factor off with the password and a code", async () => {
    const state = world(WITH_TOTP);
    stubProfile(state);
    const { container } = renderProfile(WITH_TOTP);
    const user = userEvent.setup();
    const card = cardOf(container, "Two-factor sign-in");
    expect(within(card).getByText("On")).toBeDefined();
    await user.click(buttonIn(card, "Turn off"));
    const dialog = await alertDialogNamed("Turn off two-factor sign-in");
    const confirm = buttonIn(dialog, "Turn off");
    expect(confirm.disabled).toBe(true);
    await user.type(fieldIn(dialog, "Password"), PASSWORD);
    await user.type(fieldIn(dialog, "Code from the app"), "65 43 21");
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    await screen.findByText("Two-factor sign-in is off");
    expect(state.bodies.get("/api/v1/auth/totp/disable")).toEqual([
      { password: PASSWORD, code: "654321" },
    ]);
    await within(card).findByText("Off");
  });

  it("turns two-factor off with a recovery code when the app is lost", async () => {
    const state = world(WITH_TOTP);
    stubProfile(state);
    const { container } = renderProfile(WITH_TOTP);
    const user = userEvent.setup();
    const card = cardOf(container, "Two-factor sign-in");
    await user.click(buttonIn(card, "Turn off"));
    const dialog = await alertDialogNamed("Turn off two-factor sign-in");
    await user.click(buttonIn(dialog, "Use a recovery code"));
    expect(within(dialog).queryByLabelText("Code from the app")).toBeNull();
    await user.type(fieldIn(dialog, "Password"), PASSWORD);
    await user.type(fieldIn(dialog, "Recovery code"), " bbbb-2222 ");
    await user.click(buttonIn(dialog, "Turn off"));
    await screen.findByText("Two-factor sign-in is off");
    expect(state.bodies.get("/api/v1/auth/totp/disable")).toEqual([
      { password: PASSWORD, recoveryCode: "bbbb-2222" },
    ]);
  });

  it("shows the server's refusal inside the disable dialog", async () => {
    stubProfile(world(WITH_TOTP), (method, path) => {
      if (method === "POST" && path === "/api/v1/auth/totp/disable") {
        return { status: 401, body: { error: "invalid_code" } };
      }
      return undefined;
    });
    const { container } = renderProfile(WITH_TOTP);
    const user = userEvent.setup();
    const card = cardOf(container, "Two-factor sign-in");
    await user.click(buttonIn(card, "Turn off"));
    const dialog = await alertDialogNamed("Turn off two-factor sign-in");
    await user.type(fieldIn(dialog, "Password"), PASSWORD);
    await user.type(fieldIn(dialog, "Code from the app"), "000000");
    await user.click(buttonIn(dialog, "Turn off"));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "The code is wrong or was already used.",
    );
    expect(within(card).getByText("On")).toBeDefined();
  });
});
