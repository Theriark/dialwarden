// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevLicenceBanner } from "../../components/dev-licence-banner";
import {
  entitlement,
  paidFromEnvironment,
  registry,
} from "../../test/fixtures";
import {
  renderWithProviders,
  stubFetch,
  testQueryClient,
  withSession,
  type Answer,
} from "../../test/render";
import { LicencePage } from "./licence";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function answers(
  current: ReturnType<typeof entitlement>,
  extra?: (method: string, path: string) => Answer | undefined,
) {
  return stubFetch(([method, path]) => {
    const special = extra?.(method, path);
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

function renderLicence() {
  const client = testQueryClient();
  withSession(client);
  return renderWithProviders(<LicencePage />, client);
}

describe("LicencePage", () => {
  it("shows the loading placeholders, then the Free state", async () => {
    answers(entitlement());
    renderLicence();
    expect(screen.getAllByLabelText("Loading").length).toBeGreaterThan(0);
    await screen.findByText("Dialwarden Free");
    expect(screen.getByText("No licence")).toBeDefined();
    expect(screen.getByLabelText("Key")).toBeDefined();
    await screen.findByText("What Paid adds");
    expect(screen.getByText("Scheduled changes")).toBeDefined();
    expect(screen.queryByText("Managed by the environment")).toBeNull();
    const hint = await screen.findByRole("status");
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
    const toggle = screen.getByRole("switch", {
      name: "Use the Free plan on this instance",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("What Paid adds")).toBeNull();
  });

  it("switches the instance to Free and back", async () => {
    const paid = paidFromEnvironment();
    const free = entitlement({
      source: "none",
      envLicence: { present: true, state: "active", ignored: true },
    });
    let ignored = false;
    answers(paid, (method, path) => {
      if (method === "PUT" && path === "/api/v1/licence/environment") {
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
    const toggle = await screen.findByRole("switch", {
      name: "Use the Free plan on this instance",
    });
    await user.click(toggle);
    await screen.findByText("Dialwarden Free");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await screen.findByText("Dialwarden Paid");
  });

  it("warns 30 days before the updates end", async () => {
    const paid = paidFromEnvironment();
    answers(
      entitlement({
        ...paid,
        source: "ui",
        envLicence: { present: false, state: "none", ignored: false },
        licence: {
          ...(paid.licence ?? {
            lidHash8: null,
            last6: "",
            customerName: null,
            kind: null,
            issuedAt: null,
            updatesUntil: null,
            warn30: false,
          }),
          kind: "customer",
          customerName: "Example Guild",
          warn30: true,
        },
      }),
    );
    renderLicence();
    await screen.findByText("Updates end soon");
    expect(screen.getByText("Added in the UI")).toBeDefined();
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

  it("stays hidden when the development licence is ignored", () => {
    const ignored = entitlement({
      plan: "free",
      envLicence: { present: true, state: "active", ignored: true },
    });
    renderWithProviders(<DevLicenceBanner entitlement={ignored} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
