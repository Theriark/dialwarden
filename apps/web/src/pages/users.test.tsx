// @vitest-environment jsdom
// The Users page: the list with stored and acting roles, the Free fallback
// badge and hint, the invitations card on Free (402) and on Paid (the link
// shown once), the role change refused on Free with the hint, and the
// read-only state of a viewer.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Entitlement, UserView } from "../api/schema";
import { entitlement, OWNER, paidFromUi } from "../test/fixtures";
import {
  bodyOf,
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";
import { assignableFor, inFallback, manageable } from "./users";

afterEach(resetAfterEach);

function user(
  id: string,
  role: UserView["role"],
  effectiveRole: UserView["role"] = role,
  extra: Partial<UserView> = {},
): UserView {
  return {
    id,
    email: `${id}@example.test`,
    name: `${id} person`,
    role,
    effectiveRole,
    totpEnabled: false,
    sso: false,
    localPassword: true,
    createdAt: "2026-11-20T10:00:00Z",
    grants: [],
    ...extra,
  };
}

const FREE_USERS: UserView[] = [
  user("u1", "owner", "owner", { email: "owner@example.test" }),
  user("u2", "admin", "viewer", { totpEnabled: true }),
  user("u3", "editor", "viewer", {
    grants: [{ server: "home", level: "write" }],
  }),
];

const PAID_USERS: UserView[] = [
  user("u1", "owner", "owner", { email: "owner@example.test" }),
  user("u2", "admin"),
  user("u3", "editor", "editor", {
    grants: [{ server: "home", level: "write" }],
  }),
];

const SERVERS = {
  items: [
    {
      id: "home",
      name: "Home",
      packId: "valheim",
      displayName: "Valheim",
      os: "linux",
      connector: { kind: "local", root: "/srv/home" },
      hasPassword: false,
      demo: false,
      editable: true,
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      lastEditedAt: null,
    },
  ],
};

const FREE_402 = {
  status: 402,
  body: { error: "payment_required", plan: "free", feature: "team.users" },
};

function stubWorld(
  plan: Entitlement,
  users: UserView[],
  session = OWNER,
  extra?: Handler,
) {
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
      return { status: 200, body: plan };
    }
    if (method === "GET" && path === "/api/v1/servers") {
      return { status: 200, body: SERVERS };
    }
    if (method === "GET" && path === "/api/v1/users") {
      return { status: 200, body: { items: users } };
    }
    if (method === "GET" && path === "/api/v1/invitations") {
      return plan.plan === "paid"
        ? { status: 200, body: { items: [] } }
        : FREE_402;
    }
    return undefined;
  });
}

describe("UsersPage", () => {
  it("knows who may manage whom", () => {
    expect(assignableFor("owner")).toEqual(["admin", "editor", "viewer"]);
    expect(assignableFor("admin")).toEqual(["editor", "viewer"]);
    expect(assignableFor("editor")).toEqual([]);
    const owner = OWNER.user;
    expect(manageable(owner, FREE_USERS[0] as UserView)).toBe(false);
    expect(manageable(owner, FREE_USERS[1] as UserView)).toBe(true);
    const admin = { ...owner, id: "u2", role: "admin" };
    expect(manageable(admin, FREE_USERS[1] as UserView)).toBe(false);
    expect(manageable(admin, FREE_USERS[2] as UserView)).toBe(true);
    expect(inFallback(FREE_USERS[1] as UserView)).toBe(true);
    expect(inFallback(PAID_USERS[1] as UserView)).toBe(false);
  });

  it("shows the Free fallback: acting-as-viewer badges, the reason and the hints", async () => {
    stubViewport(1280);
    stubWorld(entitlement(), FREE_USERS);
    startRouter("/users");
    await screen.findByRole("table", { name: "Users" });
    expect(screen.getAllByText("Acts as viewer on Free").length).toBe(2);
    expect(screen.getByText("Roles paused on the Free plan")).toBeDefined();
    expect(
      screen.getAllByText(
        "User roles and per-server grants is part of the Paid plan.",
      ).length,
    ).toBe(1);
    // The invitations card renders the 402 of the server as the hint.
    expect(
      screen.getByText("More than one user is part of the Paid plan."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Invite" })).toHaveProperty(
      "disabled",
      true,
    );
    // The stat strip counts the paused roles.
    expect(screen.getByText("Acting as viewer")).toBeDefined();
    expect(
      screen.getByText("Stored roles paused on the Free plan"),
    ).toBeDefined();
  });

  it("refuses a role change on Free with the hint inside the dialog", async () => {
    stubViewport(1280);
    stubWorld(entitlement(), FREE_USERS, OWNER, ([method, path]) => {
      if (method === "PUT" && path === "/api/v1/users/u3/role") {
        return {
          status: 402,
          body: {
            error: "payment_required",
            plan: "free",
            feature: "team.roles",
          },
        };
      }
      return undefined;
    });
    startRouter("/users");
    await screen.findByRole("table", { name: "Users" });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Actions for u3 person" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Change role" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Change the role",
    });
    await user.selectOptions(within(dialog).getByLabelText("Role"), "viewer");
    await user.click(
      within(dialog).getByRole("button", { name: "Change role" }),
    );
    await within(dialog).findByText(
      "User roles and per-server grants is part of the Paid plan.",
    );
  });

  it("invites a teammate on Paid and shows the link once", async () => {
    stubViewport(1280);
    const bodies: unknown[] = [];
    stubWorld(paidFromUi(), PAID_USERS, OWNER, ([method, path], init) => {
      if (method === "POST" && path === "/api/v1/invitations") {
        bodies.push(bodyOf(init));
        return {
          status: 201,
          body: {
            id: "i1",
            email: "new@example.test",
            role: "editor",
            grants: [{ server: "home", level: "write" }],
            invitedBy: "owner@example.test",
            createdAt: "2026-11-25T10:00:00Z",
            expiresAt: "2026-11-28T10:00:00Z",
            token: "value-shown-once",
            link: "https://dw.example.test/invite#value-shown-once",
          },
        };
      }
      return undefined;
    });
    startRouter("/users");
    await screen.findByRole("table", { name: "Users" });
    expect(screen.queryByText("Acts as viewer on Free")).toBeNull();
    expect(screen.getByText(/No open invitation/)).toBeDefined();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Invite" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Invite a teammate",
    });
    await user.type(
      within(dialog).getByLabelText("E-mail address"),
      "new@example.test",
    );
    await user.selectOptions(within(dialog).getByLabelText("Role"), "editor");
    // The grant editor appears for an editor: Home gets write.
    const home = await within(dialog).findByRole("radiogroup", {
      name: "Home",
    });
    fireEvent.click(within(home).getByRole("radio", { name: "Write" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Create the link" }),
    );
    const reveal = await screen.findByRole("dialog", {
      name: "Invitation link",
    });
    expect(within(reveal).getByLabelText("Invitation link").textContent).toBe(
      "https://dw.example.test/invite#value-shown-once",
    );
    expect(bodies).toEqual([
      {
        email: "new@example.test",
        role: "editor",
        grants: [{ server: "home", level: "write" }],
      },
    ]);
    expect(within(reveal).getByRole("button", { name: "Done" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows a viewer the read-only state", async () => {
    stubViewport(1280);
    const viewer = { ...OWNER, user: { ...OWNER.user, role: "viewer" } };
    stubWorld(paidFromUi(), PAID_USERS, viewer);
    startRouter("/users");
    await screen.findByText("Managed by the owner and admins");
    await waitFor(() => {
      expect(screen.queryByRole("table")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
  });
});
