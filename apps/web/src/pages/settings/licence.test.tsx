// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { keys, PLAN_DEPENDENT_KEYS } from "../../api/queries";
import type { Entitlement, LicenceState } from "../../api/schema";
import { DevLicenceBanner } from "../../components/dev-licence-banner";
import {
  entitlement,
  paidFromEnvironment,
  paidFromUi,
  registry,
} from "../../test/fixtures";
import {
  bodyOf,
  cardOf,
  deferred,
  headerOf,
  OWNER,
  renderWithProviders,
  resetAfterEach,
  stubFetch,
  testQueryClient,
  withSession,
  type Answer,
} from "../../test/render";
import { LicencePage, stateKind, stateLabel } from "./licence";

afterEach(resetAfterEach);

type Extra = (
  method: string,
  path: string,
  init: RequestInit,
) => Answer | Promise<Answer> | undefined;

function answers(current: Entitlement, extra?: Extra) {
  return stubFetch(([method, path], init) => {
    const special = extra?.(method, path, init);
    if (special !== undefined) {
      return special;
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: current };
    }
    if (method === "GET" && path === "/api/v1/plan/registry") {
      return { status: 200, body: registry };
    }
    if (method === "GET" && path === "/api/v1/plan/editable-servers") {
      return { status: 200, body: { servers: ["a", "b"], chosen: [], max: 3 } };
    }
    return undefined;
  });
}

function renderLicence(session = OWNER) {
  const client = testQueryClient();
  withSession(client, session);
  const { container } = renderWithProviders(<LicencePage />, client);
  return { client, container };
}

/** Cached answers for every plan-dependent key, fresh before the change. */
function seedPlanDependent(client: QueryClient): void {
  for (const queryKey of PLAN_DEPENDENT_KEYS) {
    client.setQueryData(queryKey, { cached: true });
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(false);
  }
}

/** Every plan-dependent answer is stale after the licence change. */
function expectPlanDependentInvalidated(client: QueryClient): void {
  for (const queryKey of PLAN_DEPENDENT_KEYS) {
    expect({
      queryKey,
      invalidated: client.getQueryState(queryKey)?.isInvalidated,
    }).toEqual({ queryKey, invalidated: true });
  }
}

const VIEWER = { ...OWNER, user: { ...OWNER.user, role: "viewer" } };
const SWITCH = "Use the Free plan on this instance";

const freeSwitch = () =>
  screen.findByRole<HTMLButtonElement>("switch", { name: SWITCH });

describe("LicencePage", () => {
  it("shows the loading placeholders, then the Free state", async () => {
    answers(entitlement());
    const { container } = renderLicence();
    expect(screen.getAllByLabelText("Loading").length).toBeGreaterThan(0);
    await screen.findByText("Dialwarden Free");
    expect(screen.getByText("No licence")).toBeDefined();
    expect(screen.getByLabelText("Key")).toBeDefined();
    await screen.findByText("What Paid adds");
    expect(screen.getByText("Scheduled changes")).toBeDefined();
    expect(screen.queryByText("Managed by the environment")).toBeNull();
    const paidList = cardOf(container, "What Paid adds");
    const hint = await within(paidList).findByRole("status");
    expect(hint.textContent).toContain("The Free plan includes 3 editable");
    expect(hint.textContent).toContain("2 of 3 in use");
  });

  it("shows a Paid environment licence with the Free switch", async () => {
    answers(paidFromEnvironment());
    renderLicence();
    await screen.findByText("Dialwarden Paid");
    expect(screen.getByText("Managed by the environment")).toBeDefined();
    expect(screen.getByText("Internal development")).toBeDefined();
    expect(screen.getByText("Theriark Development")).toBeDefined();
    const toggle = await freeSwitch();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(false);
    expect(screen.queryByText("What Paid adds")).toBeNull();
  });

  it("switches the instance to Free and back, sending the flag", async () => {
    const paid = paidFromEnvironment();
    const free = entitlement({
      source: "none",
      envLicence: { present: true, state: "active", ignored: true },
    });
    let ignored = false;
    const sent: { body: unknown; csrf: string | null }[] = [];
    answers(paid, (method, path, init) => {
      if (method === "PUT" && path === "/api/v1/licence/environment") {
        sent.push({ body: bodyOf(init), csrf: headerOf(init, "x-csrf-token") });
        ignored = !ignored;
        return { status: 200, body: ignored ? free : paid };
      }
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 200, body: ignored ? free : paid };
      }
      return undefined;
    });
    renderLicence();
    const user = userEvent.setup();
    const toggle = await freeSwitch();
    await user.click(toggle);
    await screen.findByText("Dialwarden Free");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await screen.findByText("This instance now runs the Free plan");
    await user.click(toggle);
    await screen.findByText("Dialwarden Paid");
    expect(sent).toEqual([
      { body: { ignored: true }, csrf: "csrf-test" },
      { body: { ignored: false }, csrf: "csrf-test" },
    ]);
  });

  it("holds the switch while the change is pending and shows a failure", async () => {
    const gate = deferred<Answer>();
    answers(paidFromEnvironment(), (method, path) => {
      if (method === "PUT" && path === "/api/v1/licence/environment") {
        return gate.promise;
      }
      return undefined;
    });
    renderLicence();
    const user = userEvent.setup();
    const toggle = await freeSwitch();
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle.disabled).toBe(true);
    });
    gate.resolve({ status: 500, body: { error: "internal" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The server hit an error. Check its log.",
    );
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("warns 30 days before the updates end", async () => {
    const paid = paidFromUi();
    const licence = paid.licence;
    if (licence === null) {
      throw new Error("the Paid fixture has no licence");
    }
    answers({ ...paid, licence: { ...licence, warn30: true } });
    renderLicence();
    await screen.findByText("Updates end soon");
    expect(screen.getByText("Added in the UI")).toBeDefined();
    expect(screen.getByText("Example Guild")).toBeDefined();
    expect(screen.getByText("Remove the key")).toBeDefined();
  });

  it("explains an unusable environment licence", async () => {
    answers(
      entitlement({
        source: "environment",
        state: "invalid_signature",
        envLicence: {
          present: true,
          state: "invalid_signature",
          ignored: false,
        },
      }),
    );
    renderLicence();
    const alert = await screen.findByText(/not usable: signature not valid/);
    expect(alert.textContent).toContain("runs Free");
  });

  it("stores a pasted key, flips to Paid and refreshes what depends on it", async () => {
    const sent: { body: unknown; csrf: string | null }[] = [];
    let current = entitlement();
    let healthReads = 0;
    answers(current, (method, path, init) => {
      if (method === "PUT" && path === "/api/v1/licence") {
        sent.push({ body: bodyOf(init), csrf: headerOf(init, "x-csrf-token") });
        current = paidFromUi();
        return { status: 200, body: current };
      }
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 200, body: current };
      }
      if (method === "GET" && path === "/healthz") {
        healthReads += 1;
        return { status: 500, body: { error: "internal" } };
      }
      return undefined;
    });
    const { client } = renderLicence();
    client.setQueryData(keys.health, { status: "ok" });
    seedPlanDependent(client);
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Key");
    await user.type(field, "  DW1.example.key  ");
    await user.click(screen.getByRole("button", { name: "Use this key" }));
    await screen.findByText("Paid plan is on");
    await screen.findByText("Dialwarden Paid");
    expect(sent).toEqual([
      { body: { token: "DW1.example.key" }, csrf: "csrf-test" },
    ]);
    expect(screen.getByText("Added in the UI")).toBeDefined();
    expect(screen.getByText("Example Guild")).toBeDefined();
    expect(screen.getByText("Remove the key")).toBeDefined();
    expect(screen.queryByText("What Paid adds")).toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Key").value).toBe("");
    // The About facts (nobody watches them here) are marked stale, so About
    // reads the new plan badge on its next visit.
    expect(client.getQueryState(keys.health)?.isInvalidated).toBe(true);
    expect(healthReads).toBe(0);
    // The users, invitations, audit, tokens, single sign-on and servers
    // answer differently on the new plan: all of them are fetched again.
    expectPlanDependentInvalidated(client);
  });

  it("shows the server reason when a pasted key is refused", async () => {
    answers(entitlement(), (method, path) => {
      if (method === "PUT" && path === "/api/v1/licence") {
        return {
          status: 422,
          body: { error: "invalid_licence", reason: "bad_signature" },
        };
      }
      return undefined;
    });
    renderLicence();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Key");
    await user.type(field, "DW1.not.a.key");
    await user.click(screen.getByRole("button", { name: "Use this key" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("(bad_signature)");
  });

  it("removes a UI key that overrides the environment licence", async () => {
    const overriding = entitlement({
      ...paidFromUi(),
      envLicence: { present: true, state: "active", ignored: false },
    });
    let current = overriding;
    let deletes = 0;
    answers(current, (method, path) => {
      if (method === "DELETE" && path === "/api/v1/licence") {
        deletes += 1;
        current = paidFromEnvironment();
        return { status: 200, body: current };
      }
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 200, body: current };
      }
      return undefined;
    });
    const { client } = renderLicence();
    seedPlanDependent(client);
    const user = userEvent.setup();
    const toggle = await freeSwitch();
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/A key added in the UI decides/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Remove the key" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Remove the licence key",
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await screen.findByText("Licence removed");
    expect(deletes).toBe(1);
    await screen.findByText("Managed by the environment");
    expect(screen.queryByText("Added in the UI")).toBeNull();
    expect(screen.queryByText(/A key added in the UI decides/)).toBeNull();
    expect((await freeSwitch()).disabled).toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expectPlanDependentInvalidated(client);
  });

  it("tells a non-owner what only the owner can change", async () => {
    answers(paidFromEnvironment());
    renderLicence(VIEWER);
    await screen.findByText("Dialwarden Paid");
    expect(
      screen.getByText("Only the owner can add or remove a licence key."),
    ).toBeDefined();
    expect(screen.queryByLabelText("Key")).toBeNull();
    expect((await freeSwitch()).disabled).toBe(true);
    expect(screen.getByText("Only the owner can change this.")).toBeDefined();
  });

  it("shows the error state with a retry when the entitlement fails", async () => {
    answers(entitlement(), (method, path) => {
      if (method === "GET" && path === "/api/v1/entitlement") {
        return { status: 500, body: { error: "internal" } };
      }
      return undefined;
    });
    renderLicence();
    await screen.findByText("Something went wrong");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });
});

describe("licence state words", () => {
  it("names every state of contract C1 with a matching badge", () => {
    const expected: Record<LicenceState, [string, string]> = {
      active: ["Active", "success"],
      term_ended_for_this_version: [
        "Updates ended for this version",
        "warning",
      ],
      revoked: ["Revoked", "error"],
      invalid_signature: ["Signature not valid", "error"],
      malformed: ["Not a licence key", "error"],
      dev_window_passed: ["Development window passed", "warning"],
      none: ["No licence", "neutral"],
    };
    for (const [state, [label, kind]] of Object.entries(expected)) {
      expect(stateLabel(state as LicenceState)).toBe(label);
      expect(stateKind(state as LicenceState)).toBe(kind);
    }
  });
});

describe("DevLicenceBanner", () => {
  it("shows only while an internal-dev licence is effective", () => {
    const { unmount } = renderWithProviders(
      <DevLicenceBanner entitlement={paidFromEnvironment()} />,
    );
    expect(
      screen.getByText("Development licence, not for production"),
    ).toBeDefined();
    unmount();
    renderWithProviders(<DevLicenceBanner entitlement={entitlement()} />);
    expect(
      screen.queryByText("Development licence, not for production"),
    ).toBeNull();
  });

  it("stays hidden on Free, also while a development licence is ignored", () => {
    const ignored = entitlement({
      plan: "free",
      envLicence: { present: true, state: "active", ignored: true },
    });
    renderWithProviders(<DevLicenceBanner entitlement={ignored} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays hidden for a customer licence", () => {
    renderWithProviders(<DevLicenceBanner entitlement={paidFromUi()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
