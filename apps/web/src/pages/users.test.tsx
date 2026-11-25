// @vitest-environment jsdom
// The Users page: the list with stored and acting roles, the Free fallback
// badge and hint, the invitations card on Free (402) and on Paid (the link
// shown once), the role change refused on Free with the hint, and the
// read-only state of a viewer.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { actingGrants, assignableFor, inFallback, manageable } from "./users";

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

/** Opens the row menu of a user and picks one action. */
async function chooseAction(
  userEv: ReturnType<typeof userEvent.setup>,
  name: string,
  action: string,
): Promise<void> {
  await userEv.click(
    screen.getByRole("button", { name: `Actions for ${name}` }),
  );
  await userEv.click(await screen.findByRole("menuitem", { name: action }));
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
    // An admin never manages another admin (the role rule, not the self one).
    expect(manageable(admin, user("u5", "admin"))).toBe(false);
    expect(manageable(owner, user("u5", "admin"))).toBe(true);
    expect(inFallback(FREE_USERS[1] as UserView)).toBe(true);
    expect(inFallback(PAID_USERS[1] as UserView)).toBe(false);
    // The access follows the acting role (live check F4): a stored editor
    // acting as a viewer reads its write grants; on Paid they stay writes.
    expect(actingGrants(FREE_USERS[2] as UserView)).toEqual([
      { server: "home", level: "read" },
    ]);
    expect(actingGrants(PAID_USERS[2] as UserView)).toEqual([
      { server: "home", level: "write" },
    ]);
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
    // The Access column of the editor follows the acting role (F4): its
    // write grant on Home reads as read while the role is paused.
    const table = screen.getByRole("table", { name: "Users" });
    const editorRow = within(table).getByText("u3 person").closest("tr");
    expect(editorRow).not.toBeNull();
    expect(
      within(editorRow as HTMLElement).getByText("1 server, read only"),
    ).toBeDefined();
    expect(screen.queryByText("1 server, 1 for writing")).toBeNull();
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
    // On Paid the editor's write grant reads as a write (F4).
    expect(screen.getByText("1 server, 1 for writing")).toBeDefined();
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

  it("deletes, anonymises and exports exactly the chosen user", async () => {
    stubViewport(1280);
    Object.assign(URL, {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => undefined,
    });
    // The download anchor's click would navigate, which jsdom refuses.
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const calls: string[] = [];
    stubWorld(paidFromUi(), PAID_USERS, OWNER, ([method, path]) => {
      if (method !== "GET" || path === "/api/v1/users/u3/export") {
        calls.push(`${method} ${path}`);
      }
      if (method === "DELETE" && path === "/api/v1/users/u3") {
        return { status: 204 };
      }
      if (method === "POST" && path === "/api/v1/users/u3/anonymise") {
        return {
          status: 200,
          body: user("u3", "editor", "editor", { name: "Erased user u3" }),
        };
      }
      if (method === "GET" && path === "/api/v1/users/u3/export") {
        return { status: 200, body: { user: { id: "u3" } } };
      }
      return undefined;
    });
    startRouter("/users");
    await screen.findByRole("table", { name: "Users" });
    const userEv = userEvent.setup();

    await chooseAction(userEv, "u3 person", "Delete");
    const del = await screen.findByRole("alertdialog", {
      name: "Delete this user?",
    });
    await userEv.click(within(del).getByRole("button", { name: "Delete" }));
    await screen.findByText("User deleted");
    expect(calls).toEqual(["DELETE /api/v1/users/u3"]);

    await chooseAction(userEv, "u3 person", "Anonymise");
    const anon = await screen.findByRole("alertdialog", {
      name: "Anonymise this user?",
    });
    await userEv.click(within(anon).getByRole("button", { name: "Anonymise" }));
    await screen.findByText("User anonymised");
    expect(calls.at(-1)).toBe("POST /api/v1/users/u3/anonymise");

    await chooseAction(userEv, "u3 person", "Export data");
    await screen.findByText("Export started");
    expect(calls.at(-1)).toBe("GET /api/v1/users/u3/export");
    expect(calls.length).toBe(3);
    // The export handed one file to the browser's download.
    expect(anchorClick).toHaveBeenCalledTimes(1);
    anchorClick.mockRestore();
  });

  it("makes a reset link for the chosen user and none for an SSO user", async () => {
    stubViewport(1280);
    const calls: string[] = [];
    const users = [
      ...PAID_USERS,
      user("u4", "viewer", "viewer", { sso: true, localPassword: false }),
    ];
    stubWorld(paidFromUi(), users, OWNER, ([method, path]) => {
      if (method === "POST" && path.endsWith("/password-reset")) {
        calls.push(`${method} ${path}`);
        return {
          status: 201,
          body: {
            token: "reset-value",
            link: "https://dw.example.test/reset#reset-value",
            expiresAt: "2026-11-26T10:00:00Z",
          },
        };
      }
      return undefined;
    });
    const { client } = startRouter("/users");
    await screen.findByRole("table", { name: "Users" });
    const userEv = userEvent.setup();

    await userEv.click(
      screen.getByRole("button", { name: "Actions for u4 person" }),
    );
    const ssoItem = await screen.findByRole("menuitem", {
      name: "Password reset link",
    });
    expect(ssoItem.getAttribute("aria-disabled")).toBe("true");
    await userEv.keyboard("{Escape}");

    await chooseAction(userEv, "u3 person", "Password reset link");
    const confirm = await screen.findByRole("alertdialog", {
      name: "Make a password reset link?",
    });
    await userEv.click(
      within(confirm).getByRole("button", { name: "Make the link" }),
    );
    const reveal = await screen.findByRole("dialog", {
      name: "Password reset link",
    });
    expect(within(reveal).getByLabelText("Reset link").textContent).toBe(
      "https://dw.example.test/reset#reset-value",
    );
    expect(calls).toEqual(["POST /api/v1/users/u3/password-reset"]);
    // Only the dialog holds the link: no mutation in the cache keeps it.
    await waitFor(() => {
      const held = client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data);
      expect(JSON.stringify(held)).not.toContain("reset-value");
    });
  });

  it("changes a role on Paid, with the button off until the role differs", async () => {
    stubViewport(1280);
    const bodies: unknown[] = [];
    stubWorld(paidFromUi(), PAID_USERS, OWNER, ([method, path], init) => {
      if (method === "PUT" && path === "/api/v1/users/u3/role") {
        bodies.push(bodyOf(init));
        return { status: 200, body: user("u3", "viewer") };
      }
      return undefined;
    });
    startRouter("/users");
    await screen.findByRole("table", { name: "Users" });
    const userEv = userEvent.setup();
    await chooseAction(userEv, "u3 person", "Change role");
    const dialog = await screen.findByRole("dialog", {
      name: "Change the role",
    });
    const submit = within(dialog).getByRole("button", { name: "Change role" });
    expect(submit).toHaveProperty("disabled", true);
    await userEv.selectOptions(within(dialog).getByLabelText("Role"), "viewer");
    expect(submit).toHaveProperty("disabled", false);
    await userEv.click(submit);
    await screen.findByText("Role changed");
    expect(bodies).toEqual([{ role: "viewer" }]);
  });

  it("sends no grants for an admin and read grants after a switch to viewer", async () => {
    stubViewport(1280);
    const bodies: unknown[] = [];
    stubWorld(paidFromUi(), PAID_USERS, OWNER, ([method, path], init) => {
      if (method === "POST" && path === "/api/v1/invitations") {
        bodies.push(bodyOf(init));
        return { status: 422, body: { error: "validation" } };
      }
      return undefined;
    });
    startRouter("/users");
    await screen.findByRole("table", { name: "Users" });
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole("button", { name: "Invite" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Invite a teammate",
    });
    await userEv.type(
      within(dialog).getByLabelText("E-mail address"),
      "new@example.test",
    );
    const role = within(dialog).getByLabelText("Role");
    const create = within(dialog).getByRole("button", {
      name: "Create the link",
    });
    // Editor with write on Home, then viewer: the grant drops to read.
    await userEv.selectOptions(role, "editor");
    const home = await within(dialog).findByRole("radiogroup", {
      name: "Home",
    });
    fireEvent.click(within(home).getByRole("radio", { name: "Write" }));
    await userEv.selectOptions(role, "viewer");
    await userEv.click(create);
    // Admin: every server, so no grants are sent.
    await userEv.selectOptions(role, "admin");
    await userEv.click(create);
    await waitFor(() => {
      expect(bodies.length).toBe(2);
    });
    expect(bodies).toEqual([
      {
        email: "new@example.test",
        role: "viewer",
        grants: [{ server: "home", level: "read" }],
      },
      { email: "new@example.test", role: "admin", grants: [] },
    ]);
  });

  it("names the inviter and revokes the chosen invitation", async () => {
    stubViewport(1280);
    const calls: string[] = [];
    stubWorld(paidFromUi(), PAID_USERS, OWNER, ([method, path]) => {
      if (method === "GET" && path === "/api/v1/invitations") {
        return {
          status: 200,
          body: {
            items: [
              {
                id: "i7",
                email: "guest@example.test",
                role: "viewer",
                grants: [],
                invitedBy: "u1",
                createdAt: "2026-11-25T10:00:00Z",
                expiresAt: "2026-11-28T10:00:00Z",
              },
            ],
          },
        };
      }
      if (method === "DELETE") {
        calls.push(`${method} ${path}`);
        return { status: 204 };
      }
      return undefined;
    });
    startRouter("/users");
    await screen.findByText("guest@example.test");
    expect(screen.getByText("by u1 person")).toBeDefined();
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole("button", { name: "Revoke" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Revoke this invitation?",
    });
    await userEv.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await screen.findByText("Invitation revoked");
    expect(calls).toEqual(["DELETE /api/v1/invitations/i7"]);
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
