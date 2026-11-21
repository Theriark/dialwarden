// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "../api/queries";
import type { SignedIn } from "../api/schema";
import { entitlement } from "../test/fixtures";
import {
  bodyOf,
  headerOf,
  OWNER,
  resetAfterEach,
  stubFetch,
  type Answer,
} from "../test/render";
import { startRouter } from "../test/start";

afterEach(resetAfterEach);

interface World {
  setupRequired: boolean;
  session: SignedIn | null;
  setup: (init: RequestInit) => Answer;
}

function stubWorld(world: World) {
  return stubFetch(([method, path], init) => {
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
    if (method === "POST" && path === "/api/v1/setup") {
      return world.setup(init);
    }
    return undefined;
  });
}

function world(setup: World["setup"]): World {
  return { setupRequired: true, session: null, setup };
}

const EMAIL = "owner@example.test";
const PASSWORD = "correct horse battery";
const SUBMIT = "Create the owner account";

async function fillOwner(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Your name"), "Owner Person");
  await user.type(screen.getByLabelText("E-mail address"), EMAIL);
  await user.type(screen.getByLabelText("Password"), PASSWORD);
  await user.type(screen.getByLabelText("Password again"), PASSWORD);
  await user.type(screen.getByLabelText("Setup token"), " tok-123 ");
}

const submitButton = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: SUBMIT });

/**
 * XMLHttpRequest as the import uses it: records the request, and lets the
 * test report progress and finish the upload.
 */
class FakeXhr {
  static last: FakeXhr | null = null;
  static count = 0;
  method = "";
  url = "";
  body: unknown = null;
  status = 0;
  responseText = "";
  readonly headers = new Map<string, string>();
  private readonly listeners = new Map<string, () => void>();
  private readonly uploadListeners = new Map<
    string,
    (event: ProgressEvent) => void
  >();
  readonly upload = {
    addEventListener: (type: string, fn: (event: ProgressEvent) => void) => {
      this.uploadListeners.set(type, fn);
    },
  };

  constructor() {
    FakeXhr.last = this;
    FakeXhr.count += 1;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, fn);
  }

  send(body: unknown): void {
    this.body = body;
  }

  progress(loaded: number, total: number): void {
    const event = { lengthComputable: true, loaded, total };
    this.uploadListeners.get("progress")?.(event as unknown as ProgressEvent);
  }

  finish(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.listeners.get("load")?.();
  }

  fail(): void {
    this.listeners.get("error")?.();
  }
}

function stubXhr(): void {
  FakeXhr.last = null;
  FakeXhr.count = 0;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

const importFile = () =>
  new File(["DWBX-synthetic"], "dialwarden-20261121.dwbx", {
    type: "application/octet-stream",
  });

async function openImport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", {
      name: "Restore from an app backup instead",
    }),
  );
  await user.upload(screen.getByLabelText("Export file"), importFile());
  await user.type(screen.getByLabelText("Setup token"), "tok-123");
}

describe("first-run setup", () => {
  it("creates the owner with the setup token and opens the fleet", async () => {
    const inits: RequestInit[] = [];
    const state = world((init) => {
      inits.push(init);
      state.setupRequired = false;
      state.session = OWNER;
      return { status: 201, body: OWNER };
    });
    stubWorld(state);
    const { router, client } = startRouter("/setup");
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: SUBMIT });
    expect(button.hasAttribute("disabled")).toBe(true);
    await fillOwner(user);
    expect(submitButton().disabled).toBe(false);
    await user.click(submitButton());
    await screen.findByRole("heading", { name: "Fleet" });
    expect(router.state.location.pathname).toBe("/");
    expect(inits.length).toBe(1);
    const init = inits[0] ?? {};
    expect(headerOf(init, "x-dialwarden-setup-token")).toBe("tok-123");
    expect(bodyOf(init)).toEqual({
      name: "Owner Person",
      email: EMAIL,
      password: PASSWORD,
    });
    expect(client.getQueryData(keys.setup)).toEqual({ required: false });
    expect(client.getQueryData(keys.session)).toEqual(OWNER);
    expect(screen.getByText("Welcome, Owner Person")).toBeDefined();
  });

  it("keeps the button off below 12 characters or on a mismatch", async () => {
    stubWorld(world(() => ({ status: 500, body: { error: "internal" } })));
    startRouter("/setup");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Your name"), "Owner");
    await user.type(screen.getByLabelText("E-mail address"), "o@example.test");
    await user.type(screen.getByLabelText("Setup token"), "tok-123");
    await user.type(screen.getByLabelText("Password"), "short-pass1");
    await user.type(screen.getByLabelText("Password again"), "short-pass1");
    expect(submitButton().disabled).toBe(true);
    await user.type(screen.getByLabelText("Password"), "2");
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "The two passwords differ.",
    );
    await user.type(screen.getByLabelText("Password again"), "2");
    expect(submitButton().disabled).toBe(false);
  });

  it("shows the done frame when an owner already exists", async () => {
    stubWorld(world(() => ({ status: 409, body: { error: "setup_done" } })));
    startRouter("/setup");
    const user = userEvent.setup();
    await fillOwner(user);
    await user.click(submitButton());
    await screen.findByRole("heading", { name: "Setup is done" });
    expect(
      screen.getByRole("link", { name: "Go to the sign-in page" }),
    ).toBeDefined();
  });

  it("lands a refused token on its field", async () => {
    stubWorld(
      world(() => ({ status: 403, body: { error: "setup_token_invalid" } })),
    );
    startRouter("/setup");
    const user = userEvent.setup();
    await fillOwner(user);
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The setup token does not match.");
    expect(
      screen.getByLabelText("Setup token").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(submitButton().disabled).toBe(false);
  });

  it("lands validation issues on their fields in plain words", async () => {
    stubWorld(
      world(() => ({
        status: 400,
        body: {
          error: "validation",
          issues: [{ path: "email", message: "Invalid email address" }],
        },
      })),
    );
    startRouter("/setup");
    const user = userEvent.setup();
    await fillOwner(user);
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The e-mail address is not valid.");
    expect(
      screen.getByLabelText("E-mail address").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("imports an app backup with the passphrase and token in headers", async () => {
    const state = world(() => ({ status: 500, body: { error: "internal" } }));
    stubWorld(state);
    stubXhr();
    const { router } = startRouter("/setup");
    const user = userEvent.setup();
    await openImport(user);
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Import the backup",
    });
    expect(button.disabled).toBe(true);
    await user.type(
      screen.getByLabelText("Passphrase of the export"),
      "export passphrase 2026",
    );
    expect(button.disabled).toBe(false);
    await user.click(button);
    const xhr = FakeXhr.last;
    expect(xhr).not.toBeNull();
    if (xhr === null) {
      return;
    }
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/v1/setup/import");
    expect(xhr.headers.get("x-dialwarden-passphrase")).toBe(
      "export passphrase 2026",
    );
    expect(xhr.headers.get("x-dialwarden-setup-token")).toBe("tok-123");
    expect(xhr.headers.get("content-type")).toBe("application/octet-stream");
    expect(xhr.body).toBeInstanceOf(File);
    act(() => {
      xhr.progress(50, 100);
    });
    const bar = await screen.findByRole("progressbar", {
      name: "Upload progress",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByRole("button", { name: "Importing" })).toBeDefined();
    state.setupRequired = false;
    act(() => {
      xhr.finish(200, {
        status: "imported",
        createdAt: "2026-11-21T10:00:00Z",
        reencrypted: 3,
      });
    });
    await screen.findByRole("heading", { name: "Sign in" });
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.getByText("Backup imported")).toBeDefined();
  });

  it("refuses a passphrase the server would reject before uploading", async () => {
    stubWorld(world(() => ({ status: 500, body: { error: "internal" } })));
    stubXhr();
    startRouter("/setup");
    const user = userEvent.setup();
    await openImport(user);
    await user.type(
      screen.getByLabelText("Passphrase of the export"),
      "pässwörd-1234-long",
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Only letters, digits, spaces");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Import the backup",
      }).disabled,
    ).toBe(true);
    expect(FakeXhr.count).toBe(0);
  });

  it("shows the server's import error and a lost connection", async () => {
    stubWorld(world(() => ({ status: 500, body: { error: "internal" } })));
    stubXhr();
    startRouter("/setup");
    const user = userEvent.setup();
    await openImport(user);
    await user.type(
      screen.getByLabelText("Passphrase of the export"),
      "export passphrase 2026",
    );
    const button = screen.getByRole("button", { name: "Import the backup" });
    await user.click(button);
    act(() => {
      FakeXhr.last?.finish(415, { error: "octet_stream_required" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Choose a backup export file first.");
    expect(screen.queryByRole("progressbar")).toBeNull();

    await user.click(button);
    act(() => {
      FakeXhr.last?.fail();
    });
    await screen.findByText(
      "The server could not be reached. Check the connection.",
    );
  });
});
