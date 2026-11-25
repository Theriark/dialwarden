// The e2e walk of P8 (dev-work-plan P8-B) over the server built from source,
// after the editor and P6 walks left the owner, one server and the Paid
// licence entered through the licence page. Four accounts: the owner from
// first-run setup, and an admin, an editor and a viewer the owner invites
// here (the admin accepts through the invitation page, the others through
// the API). The walk covers the Users, Audit, API tokens, Privacy and
// Single sign-on screens on Paid, every role's view, the Free fallback with
// its hints after the licence key is removed, the switch back to Paid
// without a reload, and the screenshots of every P8 screen at 1440, 768
// and 390 in light and dark. No identity provider runs here: the single
// sign-on walk checks the form, the redirect address and a refused address.
/* eslint-disable security/detect-non-literal-fs-filename -- one shots folder the CI job owns */
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const PAID_LICENCE = process.env.E2E_PAID_LICENCE ?? "";
const SHOTS = "e2e-shots";
const WIDTHS = [1440, 768, 390] as const;
const THEMES = ["light", "dark"] as const;

const OWNER = {
  name: "Owner Quinn",
  email: "owner@example.net",
  password: "correct horse battery staple",
};

/** The teammates this walk makes; the passwords are throwaway test values. */
const ADMIN = {
  name: "Admin Avery",
  email: "admin@example.net",
  password: "admin passphrase for the walk",
};
const EDITOR = {
  name: "Editor Eli",
  email: "editor@example.net",
  password: "editor passphrase for the walk",
};
const VIEWER = {
  name: "Viewer Vic",
  email: "viewer@example.net",
  password: "viewer passphrase for the walk",
};

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function signIn(
  page: Page,
  account: { email: string; password: string },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

async function signOut(page: Page): Promise<void> {
  const csrf = await csrfOf(page);
  await page.request.post("/api/v1/auth/logout", {
    headers: { "x-csrf-token": csrf },
  });
  await page.context().clearCookies();
}

async function csrfOf(page: Page): Promise<string> {
  const session = (await (
    await page.request.get("/api/v1/auth/session")
  ).json()) as { csrfToken: string };
  return session.csrfToken;
}

/** An invitation through the API, accepted through the API: a teammate. */
async function addTeammate(
  page: Page,
  account: { name: string; email: string; password: string },
  role: "admin" | "editor" | "viewer",
  grants: { server: string; level: "read" | "write" }[],
): Promise<void> {
  const csrf = await csrfOf(page);
  const invited = await page.request.post("/api/v1/invitations", {
    headers: { "x-csrf-token": csrf },
    data: { email: account.email, role, grants },
  });
  expect(invited.status()).toBe(201);
  const { token } = (await invited.json()) as { token: string };
  // The accept is public: a fresh request context holds no session.
  const accepted = await page
    .context()
    .request.fetch("/api/v1/invitations/accept", {
      method: "POST",
      headers: { cookie: "" },
      data: { token, name: account.name, password: account.password },
    });
  expect(accepted.status()).toBe(201);
}

/** The reveal dialog: copy, confirm and close; the value shown is returned. */
async function takeRevealed(page: Page, label: string): Promise<string> {
  const value = (await page.getByLabel(label).textContent()) ?? "";
  expect(value).not.toBe("");
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await page.getByRole("checkbox", { name: "I have copied it" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel(label)).toHaveCount(0);
  return value;
}

test("the owner invites the team; the admin joins through the invitation page", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);

  // The Users page: the owner alone, every stored role in force.
  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByText(OWNER.name).first()).toBeVisible();
  await expect(page.getByText("Every stored role is in force")).toBeVisible();
  await expect(page.getByText("No open invitation")).toBeVisible();

  // Invite the admin through the dialog; the link is shown once.
  await page.getByRole("button", { name: "Invite" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a teammate" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("E-mail address").fill(ADMIN.email);
  await dialog.getByLabel("Role").selectOption("admin");
  await dialog.getByRole("button", { name: "Create the link" }).click();
  await expect(
    page.getByRole("dialog", { name: "Invitation link" }),
  ).toBeVisible();
  const link = await takeRevealed(page, "Invitation link");
  expect(link).toContain("/invite#");
  await expect(page.getByText(ADMIN.email)).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();

  // The editor writes and the viewer reads the one server, through the API.
  await addTeammate(page, EDITOR, "editor", [
    { server: "palworld-home", level: "write" },
  ]);
  await addTeammate(page, VIEWER, "viewer", [
    { server: "palworld-home", level: "read" },
  ]);
  await page.reload();
  await expect(page.getByText(EDITOR.email)).toBeVisible();
  await expect(page.getByText("1 server, 1 for writing").first()).toBeVisible();
  await expect(page.getByText("1 server, read only").first()).toBeVisible();

  // The admin accepts on the invitation page and lands on the fleet.
  await signOut(page);
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Join this Dialwarden" }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill(ADMIN.name);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Password again").fill(ADMIN.password);
  await page.getByRole("button", { name: "Accept the invitation" }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("button", { name: `Account menu for ${ADMIN.name}` }),
  ).toBeVisible();

  // The same link answers 410 the second time.
  await signOut(page);
  await page.goto(link);
  await page.getByLabel("Your name").fill("Someone Else");
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Password again").fill(ADMIN.password);
  await page.getByRole("button", { name: "Accept the invitation" }).click();
  await expect(
    page.getByText("This invitation is no longer valid."),
  ).toBeVisible();
});

test("the audit log: rows in words, the chain, the filters and the CSV export", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.getByText(/Chain valid, \d+ rows/).first()).toBeVisible();
  await expect(page.getByText("Invitation made").first()).toBeVisible();
  await expect(page.getByText("Invitation accepted").first()).toBeVisible();
  // The refused second accept of the walk before is a refused sign-in.
  await expect(page.getByText("Refused").first()).toBeVisible();

  // The action filter asks the server for one route pattern.
  await page.getByLabel("Action").selectOption("POST /api/v1/invitations");
  await expect(page.getByText("Invitation accepted")).toHaveCount(0);
  await expect(page.getByText("Invitation made").first()).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Invitation accepted").first()).toBeVisible();

  // The search narrows the loaded rows; the density toggle is remembered.
  await page.getByLabel("Search the loaded rows").fill("accepted");
  await expect(page.getByText("Invitation made")).toHaveCount(0);
  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.getByRole("button", { name: "Compact" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Clear" }).click();

  // Verify again keeps the chain valid; the export downloads the CSV.
  await page.getByRole("button", { name: "Verify again" }).click();
  await expect(page.getByText(/Chain valid, \d+ rows/).first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("dialwarden-audit.csv");
  await expect(page.getByText("Export started").first()).toBeVisible();
});

test("API tokens: made once, copied, listed and revoked", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto("/settings/tokens");
  await expect(page.getByText("Ready")).toBeVisible();
  await expect(page.getByText("No token yet")).toBeVisible();
  await page.getByLabel("Name").fill("Backup script");
  await page.getByLabel("Acts as").selectOption("viewer");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(
    page.getByRole("dialog", { name: "Your new API token" }),
  ).toBeVisible();
  const value = await takeRevealed(page, "API token");
  expect(value.length).toBeGreaterThan(20);

  // The list shows the name, the role and the prefix only.
  await expect(page.getByText("Backup script").first()).toBeVisible();
  await expect(page.getByText(value)).toHaveCount(0);
  await expect(page.getByText(`${value.slice(0, 8)}`).first()).toBeVisible();

  // The token reads the servers as a viewer: a bearer request works.
  const listed = await page.context().request.fetch("/api/v1/servers", {
    headers: { authorization: `Bearer ${value}`, cookie: "" },
  });
  expect(listed.status()).toBe(200);

  await page.getByRole("button", { name: "Revoke" }).first().click();
  const confirm = page.getByRole("alertdialog", {
    name: "Revoke this token?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Token revoked").first()).toBeVisible();
  await expect(page.getByText("No token yet")).toBeVisible();
  const refused = await page.context().request.fetch("/api/v1/servers", {
    headers: { authorization: `Bearer ${value}`, cookie: "" },
  });
  expect(refused.status()).toBe(401);
});

test("privacy: snapshot retention, the audit address setting and the own export", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto("/settings/privacy");
  await expect(
    page.getByRole("heading", { name: "Snapshot retention" }),
  ).toBeVisible();
  await expect(page.getByText("On every plan")).toBeVisible();

  await page
    .getByRole("radio", { name: /Keep the newest versions of every file/ })
    .check();
  await page.getByLabel("Versions to keep").fill("25");
  await page.getByRole("button", { name: "Save retention" }).click();
  await expect(
    page.getByText("Snapshot retention saved").first(),
  ).toBeVisible();

  await page.getByRole("radio", { name: /^None/ }).check();
  await page.getByRole("radio", { name: /Remove rows older than/ }).check();
  await page.getByLabel("Days to keep").last().fill("400");
  await page.getByRole("button", { name: "Save audit settings" }).click();
  await expect(page.getByText("Audit settings saved").first()).toBeVisible();

  // The settings came back from the server: a reload shows them.
  await page.reload();
  await expect(page.getByLabel("Versions to keep")).toHaveValue("25");
  await expect(page.getByRole("radio", { name: /^None/ })).toBeChecked();
  await expect(page.getByLabel("Days to keep").last()).toHaveValue("400");

  // Back to the defaults for the walks after this one, then the own export.
  await page.getByRole("radio", { name: /Keep every snapshot/ }).check();
  await page.getByRole("button", { name: "Save retention" }).click();
  await expect(
    page.getByText("Snapshot retention saved").first(),
  ).toBeVisible();
  await page.getByRole("radio", { name: /^Truncated/ }).check();
  await page.getByRole("radio", { name: /Keep every row/ }).check();
  await page.getByRole("button", { name: "Save audit settings" }).click();
  await expect(page.getByText("Audit settings saved").first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my data" }).click();
  expect((await download).suggestedFilename()).toBe("dialwarden-export.json");
});

test("single sign-on: the form, the redirect address and a refused provider", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto("/settings/sso");
  await expect(page.getByRole("heading", { name: "Provider" })).toBeVisible();
  await expect(page.getByText("Off").first()).toBeVisible();
  await expect(page.getByLabel("Redirect address")).toContainText(
    "/api/v1/auth/oidc/callback",
  );
  await expect(
    page.getByText("The owner keeps the local sign-in"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();

  // A group row, then an http issuer: refused before any connection.
  await page.getByRole("button", { name: "Add a group" }).click();
  await page.getByLabel("Group 1").fill("game-admins");
  await page.getByLabel("Role").selectOption("admin");
  await page.getByLabel("Discovery URL (issuer)").fill("http://127.0.0.1:1/x");
  await page.getByLabel("Client id").fill("dialwarden");
  await page
    .getByRole("switch", { name: "Sign in through the provider" })
    .click();
  await page.getByRole("button", { name: "Save and turn on" }).click();
  await expect(
    page.getByText("The provider address is not allowed."),
  ).toBeVisible();
  // Nothing was stored: the sign-in page offers no single sign-on.
  const status = (await (
    await page.request.get("/api/v1/auth/oidc")
  ).json()) as {
    enabled: boolean;
  };
  expect(status.enabled).toBe(false);
});

test("each role sees its own view: admin, editor and viewer", async ({
  page,
}) => {
  test.setTimeout(180_000);

  // The admin manages editors and viewers, never the owner.
  await signIn(page, ADMIN);
  await page.goto("/users");
  await expect(page.getByRole("table", { name: "Users" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Actions for ${OWNER.name}` }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: `Actions for ${EDITOR.name}` })
    .click();
  await page.getByRole("menuitem", { name: "Server grants" }).click();
  const grants = page.getByRole("dialog", { name: "Server grants" });
  await expect(grants).toBeVisible();
  await grants
    .getByRole("radiogroup", { name: "Palworld Home" })
    .getByRole("radio", { name: "Read" })
    .check();
  await grants.getByRole("button", { name: "Save grants" }).click();
  await expect(page.getByText("Grants saved").first()).toBeVisible();
  await expect(page.getByText("1 server, read only").first()).toBeVisible();
  // Back to write for the editor's walk below.
  await page
    .getByRole("button", { name: `Actions for ${EDITOR.name}` })
    .click();
  await page.getByRole("menuitem", { name: "Server grants" }).click();
  await grants
    .getByRole("radiogroup", { name: "Palworld Home" })
    .getByRole("radio", { name: "Write" })
    .check();
  await grants.getByRole("button", { name: "Save grants" }).click();
  await expect(page.getByText("Grants saved").first()).toBeVisible();
  // The admin reads the audit log but cannot set up single sign-on.
  await page.goto("/audit");
  await expect(page.getByRole("table", { name: "Audit log" })).toBeVisible();
  await page.goto("/settings/sso");
  await expect(
    page.getByText("Only the owner can set up single sign-on."),
  ).toBeVisible();
  await signOut(page);

  // The editor sees the granted server and edits it; no team screens.
  await signIn(page, EDITOR);
  await expect(page.getByText("Palworld Home").first()).toBeVisible();
  await page.goto("/users");
  await expect(page.getByText("Managed by the owner and admins")).toBeVisible();
  await page.goto("/audit");
  await expect(page.getByText("Read by the owner and admins")).toBeVisible();
  await page.goto("/settings/privacy");
  await expect(
    page.getByText("The owner and admins set the retention"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download my data" }),
  ).toBeVisible();
  await page.goto("/settings/tokens");
  const roles = await page
    .getByLabel("Acts as")
    .locator("option")
    .allTextContents();
  expect(roles).toEqual(["Editor", "Viewer"]);
  await signOut(page);

  // The viewer reads the granted server and nothing writes.
  await signIn(page, VIEWER);
  await expect(page.getByText("Palworld Home").first()).toBeVisible();
  await page.goto("/servers/palworld-home/settings");
  await expect(
    page.getByRole("heading", { name: "Palworld Home settings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review and save" }),
  ).toHaveCount(0);
  await page.goto("/users");
  await expect(page.getByText("Managed by the owner and admins")).toBeVisible();
});

async function shoot(
  page: Page,
  name: string,
  ready: (page: Page) => Promise<void>,
  path: string,
  full = true,
): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of WIDTHS) {
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : 900,
      });
      await page.goto(path);
      await ready(page);
      await page.screenshot({
        path: `${SHOTS}/p8-${name}-${width}-${theme}.jpg`,
        type: "jpeg",
        quality: 75,
        fullPage: full,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 720 });
}

test("the Free fallback and the switch back, without a reload", async ({
  page,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, OWNER);

  // The owner removes the licence key: the instance is Free at once.
  await page.goto("/settings/licence");
  await page.getByRole("button", { name: "Remove the key" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Remove the licence key",
  });
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Licence removed").first()).toBeVisible();
  await expect(page.getByText("Dialwarden Free")).toBeVisible();

  // Client-side navigation only from here: the pages refetch what the
  // plan changes, with no reload.
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Users" }).click();
  await expect(page).toHaveURL("/users");
  await expect(page.getByText("Acts as viewer on Free")).toHaveCount(3);
  await expect(page.getByText("Roles paused on the Free plan")).toBeVisible();
  await expect(
    page.getByText("More than one user is part of the Paid plan."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite" })).toBeDisabled();

  await nav.getByRole("link", { name: "Audit" }).click();
  await expect(page).toHaveURL("/audit");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await expect(
    page.getByText("The audit log is part of the Paid plan."),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Audit log" })).toBeVisible();

  await nav.getByRole("link", { name: "Settings" }).click();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("link", { name: "API tokens" }).click();
  await expect(page.getByText("Stopped on Free")).toBeVisible();
  await expect(
    page.getByText("API tokens is part of the Paid plan."),
  ).toBeVisible();
  await sections.getByRole("link", { name: "Single sign-on" }).click();
  await expect(page.getByText("Single sign-on is off")).toBeVisible();
  await expect(
    page.getByText("Single sign-on is part of the Paid plan."),
  ).toBeVisible();

  // The Free views at every width and theme.
  await shoot(
    page,
    "users-free",
    async (p) => {
      await expect(p.getByText("Roles paused on the Free plan")).toBeVisible();
    },
    "/users",
  );
  await shoot(
    page,
    "audit-free",
    async (p) => {
      await expect(
        p.getByText("The audit log is part of the Paid plan."),
      ).toBeVisible();
    },
    "/audit",
  );
  await shoot(
    page,
    "tokens-free",
    async (p) => {
      await expect(p.getByText("Stopped on Free")).toBeVisible();
    },
    "/settings/tokens",
  );
  await shoot(
    page,
    "sso-free",
    async (p) => {
      await expect(p.getByText("Single sign-on is off")).toBeVisible();
    },
    "/settings/sso",
  );

  // A stored admin acts as a viewer on Free: the team screens are read-only.
  await signOut(page);
  await signIn(page, ADMIN);
  await page.goto("/users");
  await expect(page.getByText("Managed by the owner and admins")).toBeVisible();
  await signOut(page);
  await signIn(page, OWNER);

  // The key goes back in: everything returns, still without a reload.
  await page.goto("/settings/licence");
  await page.getByLabel("Key").fill(PAID_LICENCE);
  await page.getByRole("button", { name: "Use this key" }).click();
  await expect(page.getByText("Paid plan is on").first()).toBeVisible();
  await nav.getByRole("link", { name: "Users" }).click();
  await expect(page).toHaveURL("/users");
  await expect(page.getByRole("table", { name: "Users" })).toBeVisible();
  await expect(page.getByText("Acts as viewer on Free")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite" })).toBeEnabled();
  await nav.getByRole("link", { name: "Audit" }).click();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await nav.getByRole("link", { name: "Settings" }).click();
  await sections.getByRole("link", { name: "API tokens" }).click();
  await expect(page.getByText("Ready")).toBeVisible();
  await sections.getByRole("link", { name: "Single sign-on" }).click();
  await expect(page.getByRole("heading", { name: "Provider" })).toBeVisible();
});

test("every P8 screen at 1440, 768 and 390 in light and dark", async ({
  page,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, OWNER);

  // One open invitation and one reset link for the public pages below.
  const csrf = await csrfOf(page);
  const invited = await page.request.post("/api/v1/invitations", {
    headers: { "x-csrf-token": csrf },
    data: { email: "shots@example.net", role: "viewer", grants: [] },
  });
  expect(invited.status()).toBe(201);
  const { link: inviteLink } = (await invited.json()) as { link: string };
  const users = (await (await page.request.get("/api/v1/users")).json()) as {
    items: { id: string; email: string }[];
  };
  const viewer = users.items.find((item) => item.email === VIEWER.email);
  expect(viewer).toBeDefined();
  const reset = await page.request.post(
    `/api/v1/users/${viewer?.id ?? ""}/password-reset`,
    { headers: { "x-csrf-token": csrf } },
  );
  expect(reset.status()).toBe(201);
  const { link: resetLink } = (await reset.json()) as { link: string };
  // One token, so the list has a row.
  const made = await page.request.post("/api/v1/tokens", {
    headers: { "x-csrf-token": csrf },
    data: { name: "Screenshot token", role: "viewer" },
  });
  expect(made.status()).toBe(201);

  await shoot(
    page,
    "users",
    async (p) => {
      await expect(p.getByRole("heading", { name: "Users" })).toBeVisible();
      await expect(p.getByText(ADMIN.email)).toBeVisible();
    },
    "/users",
  );
  await shoot(
    page,
    "users-invite",
    async (p) => {
      await expect(p.getByRole("heading", { name: "Users" })).toBeVisible();
      await p.getByRole("button", { name: "Invite" }).click();
      const dialog = p.getByRole("dialog", { name: "Invite a teammate" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Role").selectOption("editor");
      await expect(
        dialog.getByRole("radiogroup", { name: "Palworld Home" }),
      ).toBeVisible();
    },
    "/users",
    false,
  );
  await shoot(
    page,
    "audit",
    async (p) => {
      await expect(
        p
          .getByRole("table", { name: "Audit log" })
          .or(p.getByRole("list", { name: "Audit log" })),
      ).toBeVisible();
      await expect(p.getByText(/Chain valid/).first()).toBeVisible();
    },
    "/audit",
  );
  await shoot(
    page,
    "tokens",
    async (p) => {
      await expect(p.getByText("Screenshot token").first()).toBeVisible();
    },
    "/settings/tokens",
  );
  await shoot(
    page,
    "privacy",
    async (p) => {
      await expect(
        p.getByRole("heading", { name: "Snapshot retention" }),
      ).toBeVisible();
    },
    "/settings/privacy",
  );
  await shoot(
    page,
    "sso",
    async (p) => {
      await expect(p.getByRole("heading", { name: "Provider" })).toBeVisible();
    },
    "/settings/sso",
  );

  // The public pages, signed out.
  await signOut(page);
  await shoot(
    page,
    "invite",
    async (p) => {
      await expect(
        p.getByRole("heading", { name: "Join this Dialwarden" }),
      ).toBeVisible();
    },
    inviteLink,
  );
  await shoot(
    page,
    "reset",
    async (p) => {
      await expect(
        p.getByRole("heading", { name: "Choose a new password" }),
      ).toBeVisible();
    },
    resetLink,
  );

  // Leave the instance as the visual walk expects: Paid, the token gone.
  await signIn(page, OWNER);
  const again = await csrfOf(page);
  const tokens = (await (await page.request.get("/api/v1/tokens")).json()) as {
    items: { id: string }[];
  };
  for (const token of tokens.items) {
    await page.request.delete(`/api/v1/tokens/${token.id}`, {
      headers: { "x-csrf-token": again },
    });
  }
});
