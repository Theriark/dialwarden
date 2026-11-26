// @vitest-environment jsdom
// The notifications settings: the channel list, an edit that keeps the
// stored secret and address when their fields stay as shown, the explicit
// removal that sends null, the send test's success and error states, the
// Free plan hint and the sentence for an editor.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelView } from "../../api/schema";
import {
  inputOfChannelState,
  stateOfChannel,
  validateChannelForm,
} from "../../components/channel-form";
import { entitlement, OWNER } from "../../test/fixtures";
import {
  bodyOf,
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../../test/render";
import { startRouter } from "../../test/start";
import { targetWords } from "./notifications";

afterEach(resetAfterEach);

const WEBHOOK: ChannelView = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Ops hook",
  kind: "webhook",
  enabled: true,
  types: ["change.applied", "drift.detected"],
  settings: {
    kind: "webhook",
    url: "https://hooks.example.net/***",
    host: "hooks.example.net",
    hasSigningSecret: true,
    allowPrivateHost: false,
  },
  lastDeliveryAt: "2026-11-26T05:00:00Z",
  lastResult: "failed",
  lastError: "http_500",
  failures: 2,
  createdAt: "2026-11-25T00:00:00Z",
  updatedAt: "2026-11-26T00:00:00Z",
};

const IN_APP: ChannelView = {
  ...WEBHOOK,
  id: "33333333-3333-4333-8333-333333333333",
  name: "Bell",
  kind: "in_app",
  settings: { kind: "in_app" },
  lastDeliveryAt: null,
  lastResult: null,
  lastError: null,
  failures: 0,
};

function stubWorld(extra?: Handler) {
  const puts: unknown[] = [];
  stubFetch((route, init) => {
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
    if (method === "GET" && path === "/api/v1/notifications/channels") {
      return { status: 200, body: { items: [WEBHOOK, IN_APP] } };
    }
    if (
      method === "PUT" &&
      path === `/api/v1/notifications/channels/${WEBHOOK.id}`
    ) {
      puts.push(bodyOf(init));
      return { status: 200, body: WEBHOOK };
    }
    if (method === "GET" && path.startsWith("/api/v1/notifications?")) {
      return { status: 200, body: { items: [], unread: 0, nextBefore: null } };
    }
    return undefined;
  });
  return puts;
}

describe("NotificationsPage", () => {
  it("lists the channels with their target, result and failures", async () => {
    stubViewport(1440);
    stubWorld();
    startRouter("/settings/notifications");
    await screen.findByText("Ops hook");
    expect(screen.getByText("hooks.example.net · signed")).toBeTruthy();
    expect(screen.getByText("Failed", { exact: true })).toBeTruthy();
    expect(screen.getByText("2 · The receiver answered 500.")).toBeTruthy();
    expect(screen.getAllByText("Drift found").length).toBe(2);
    expect(screen.getByText("Bell")).toBeTruthy();
  });

  it("keeps the stored secret and address when the fields stay as shown", async () => {
    stubViewport(1440);
    const puts = stubWorld();
    startRouter("/settings/notifications");
    await screen.findByText("Ops hook");

    const card = screen.getByText("Ops hook").closest("section");
    expect(card).not.toBeNull();
    if (card === null) return;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Ops hook" });
    const url = within(dialog).getByLabelText(
      "Webhook address",
    ) as HTMLInputElement;
    expect(url.value).toBe("https://hooks.example.net/***");
    const secret = within(dialog).getByLabelText(
      "Signing secret",
    ) as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.placeholder).toBe("Stored; leave empty to keep it");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Ops hook renamed" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save channel" }),
    );
    await waitFor(() => {
      expect(puts.length).toBe(1);
    });
    expect(puts[0]).toEqual({
      name: "Ops hook renamed",
      enabled: true,
      types: ["change.applied", "drift.detected"],
      settings: { kind: "webhook", allowPrivateHost: false },
    });
  });

  it("removes the stored secret only through the explicit box", async () => {
    stubViewport(1440);
    const puts = stubWorld();
    startRouter("/settings/notifications");
    await screen.findByText("Ops hook");
    const card = screen.getByText("Ops hook").closest("section");
    if (card === null) return;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Ops hook" });
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Remove the stored signing secret",
      }),
    );
    expect(
      (within(dialog).getByLabelText("Signing secret") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save channel" }),
    );
    await waitFor(() => {
      expect(puts.length).toBe(1);
    });
    expect(
      (puts[0] as { settings: { signingSecret: unknown } }).settings
        .signingSecret,
    ).toBeNull();
  });

  it("shows the send test's error and success states", async () => {
    stubViewport(1440);
    let answer: { ok: boolean; error: string | null } = {
      ok: false,
      error: "host_refused",
    };
    stubWorld(([method, path]) => {
      if (
        method === "POST" &&
        path === `/api/v1/notifications/channels/${WEBHOOK.id}/test`
      ) {
        return { status: 200, body: answer };
      }
      return undefined;
    });
    startRouter("/settings/notifications");
    await screen.findByText("Ops hook");
    const card = screen.getByText("Ops hook").closest("section");
    if (card === null) return;
    fireEvent.click(within(card).getByRole("button", { name: "Send test" }));
    await within(card).findByText("Test message not delivered");
    expect(
      within(card).getByText(
        /The host is not allowed: private and local addresses need the private host switch\. \(host_refused\)/,
      ),
    ).toBeTruthy();
    answer = { ok: true, error: null };
    fireEvent.click(within(card).getByRole("button", { name: "Send test" }));
    await within(card).findByText("Test message delivered");
  });

  it("renders the upgrade hint on Free and a sentence for an editor", async () => {
    stubViewport(1440);
    stubWorld(([method, path]) => {
      if (method === "GET" && path === "/api/v1/notifications/channels") {
        return {
          status: 402,
          body: {
            error: "payment_required",
            plan: "free",
            feature: "notifications",
          },
        };
      }
      return undefined;
    });
    startRouter("/settings/notifications");
    await screen.findByText("Notification channels is part of the Paid plan.");
    expect(
      screen.getByText("Notifications are off on the Free plan"),
    ).toBeTruthy();
  });

  it("tells an editor who sets the channels up", async () => {
    stubViewport(1440);
    stubWorld(([method, path]) => {
      if (method === "GET" && path === "/api/v1/auth/session") {
        return {
          status: 200,
          body: { ...OWNER, user: { ...OWNER.user, role: "editor" } },
        };
      }
      return undefined;
    });
    startRouter("/settings/notifications");
    await screen.findByText(
      /The owner and admins set up the notification channels/,
    );
    expect(screen.queryByRole("button", { name: "Add channel" })).toBeNull();
  });

  it("builds the input and words the target", () => {
    const state = stateOfChannel(WEBHOOK);
    expect(validateChannelForm(state, true).size).toBe(0);
    expect(
      validateChannelForm({ ...state, url: "http://x" }, true).get("url"),
    ).toBe("The address must start with https://.");
    expect(
      inputOfChannelState(
        {
          ...state,
          url: "https://new.example.net/hook",
          signingSecret: "test-secret-test",
        },
        true,
      ).settings,
    ).toEqual({
      kind: "webhook",
      url: "https://new.example.net/hook",
      signingSecret: "test-secret-test",
      allowPrivateHost: false,
    });
    const smtp = inputOfChannelState(
      {
        ...state,
        kind: "smtp",
        host: "mail.example.net",
        port: "465",
        security: "tls",
        username: "",
        password: "",
        from: "dw@example.net",
        to: "a@example.net, b@example.net",
      },
      false,
    );
    expect(smtp.settings).toEqual({
      kind: "smtp",
      host: "mail.example.net",
      port: 465,
      security: "tls",
      username: null,
      from: "dw@example.net",
      to: ["a@example.net", "b@example.net"],
      allowPrivateHost: false,
    });
    expect(targetWords(IN_APP)).toBe("The bell in the top bar");
  });
});
