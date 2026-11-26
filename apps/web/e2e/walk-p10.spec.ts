// The P10-B2 walk and screenshots (references/ui-standard.md): the screens
// this fix task changed, at 1440, 768 and 390 in light and dark, saved as
// CI artifacts (p10-SCREEN-WIDTH-THEME.jpg). It runs last, after the visual
// walk, with the owner, the team of the P8 walk and one Palworld server on
// Paid. The editor of that walk gets a read grant on the server for the
// duration of this walk (P10-A L22) and its write grant back at the end;
// a schedule is made for the list and removed again; the licence is taken
// out for the Free view of the reports page and put back. The instance is
// left as it was found.
/* eslint-disable security/detect-non-literal-fs-filename -- one shots folder the CI job owns */
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const PAID_LICENCE = process.env.E2E_PAID_LICENCE ?? "";
const SHOTS = "e2e-shots";
const WIDTHS = [1440, 768, 390] as const;
const THEMES = ["light", "dark"] as const;
const SERVER = "palworld-home";

const OWNER = {
  email: "owner@example.net",
  password: "correct horse battery staple",
};
const EDITOR = {
  email: "editor@example.net",
  password: "editor passphrase for the walk",
};

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/** The Servers tile on Paid: the licence's own limit, or none. */
const PAID_TILE = /Paid plan: (up to \d+ servers|no server limit)/;

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

async function csrfOf(page: Page): Promise<string> {
  const session = (await (
    await page.request.get("/api/v1/auth/session")
  ).json()) as { csrfToken: string };
  return session.csrfToken;
}

async function signOut(page: Page): Promise<void> {
  const csrf = await csrfOf(page);
  await page.request.post("/api/v1/auth/logout", {
    headers: { "x-csrf-token": csrf },
  });
  await page.context().clearCookies();
}

/** The editor's grant on the one server, set by the owner through the API. */
async function grantEditor(page: Page, level: "read" | "write"): Promise<void> {
  const csrf = await csrfOf(page);
  const users = (await (await page.request.get("/api/v1/users")).json()) as {
    items: { id: string; email: string }[];
  };
  const editor = users.items.find((item) => item.email === EDITOR.email);
  expect(editor).toBeDefined();
  const saved = await page.request.put(
    `/api/v1/users/${editor?.id ?? ""}/grants`,
    {
      headers: { "x-csrf-token": csrf },
      data: { servers: [{ server: SERVER, level }] },
    },
  );
  expect(saved.ok()).toBeTruthy();
}

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
        path: `${SHOTS}/p10-${name}-${width}-${theme}.jpg`,
        type: "jpeg",
        quality: 75,
        fullPage: full,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 720 });
}

test("an editor with a read grant sees every server screen read-only, with the grant named", async ({
  page,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, OWNER);
  await grantEditor(page, "read");
  await signOut(page);

  await signIn(page, EDITOR);
  // The fleet card offers a view, not an edit.
  await expect(
    page.getByRole("link", { name: "View settings" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit settings" })).toHaveCount(
    0,
  );

  // The settings: disabled fields, the grant sentence, no save bar.
  const settingsReady = async (p: Page) => {
    await expect(
      p.getByRole("heading", { name: "Palworld Home settings" }),
    ).toBeVisible();
    await expect(
      p.getByText(
        /You are signed in as editor with read access to this server: you read these settings/,
      ),
    ).toBeVisible();
  };
  await page.goto(`/servers/${SERVER}/settings`);
  await settingsReady(page);
  await page.getByLabel("Search settings").fill("Experience rate");
  if ((page.viewportSize()?.width ?? 0) < 640) {
    await page.getByText("Rates", { exact: true }).first().click();
  }
  await expect(page.getByLabel("Experience rate")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Review and save" }),
  ).toHaveCount(0);
  // The server refuses a write on a read grant with 403, as before; the
  // page never sends one, so the API answer is checked directly.
  const csrf = await csrfOf(page);
  const refused = await page.request.post(
    `/api/v1/servers/${SERVER}/change-sets`,
    {
      headers: { "x-csrf-token": csrf },
      data: { edits: [{ settingKey: "ExpRate", value: 3 }] },
    },
  );
  expect(refused.status()).toBe(403);
  await shoot(
    page,
    "settings-read-grant",
    settingsReady,
    `/servers/${SERVER}/settings`,
  );

  // The history: the grant sentence, no restore control.
  const historyReady = async (p: Page) => {
    await expect(
      p.getByRole("heading", { name: "Palworld Home history" }),
    ).toBeVisible();
    await expect(
      p.getByText(
        /You are signed in as editor with read access to this server: you read this history/,
      ),
    ).toBeVisible();
    await expect(p.getByText("First import").first()).toBeVisible();
  };
  await page.goto(`/servers/${SERVER}/history`);
  await historyReady(page);
  await expect(
    page.getByRole("button", { name: "Restore this version" }),
  ).toHaveCount(0);
  await shoot(
    page,
    "history-read-grant",
    historyReady,
    `/servers/${SERVER}/history`,
  );

  // The hooks: the actions are visible, none runs, the reason names the grant.
  const hooksReady = async (p: Page) => {
    await expect(
      p.getByRole("heading", { name: "Palworld Home hooks" }),
    ).toBeVisible();
    await expect(
      p.getByText(/Your grant on this server is read-only/),
    ).toBeVisible();
  };
  await page.goto(`/servers/${SERVER}/hooks`);
  await hooksReady(page);
  await expect(page.getByRole("button", { name: "Run stop" })).toBeDisabled();
  await shoot(page, "hooks-read-grant", hooksReady, `/servers/${SERVER}/hooks`);

  // The launch flags: the grant sentence and disabled flags.
  const launchReady = async (p: Page) => {
    await expect(
      p.getByRole("heading", { name: "Palworld Home launch" }),
    ).toBeVisible();
    await expect(
      p.getByText(
        /You are signed in as editor with read access to this server: you read these flags/,
      ),
    ).toBeVisible();
  };
  await page.goto(`/servers/${SERVER}/launch`);
  await launchReady(page);
  await shoot(
    page,
    "launch-read-grant",
    launchReady,
    `/servers/${SERVER}/launch`,
  );

  // The About page tells a reader below admin who sees the outbound list.
  await page.goto("/about");
  await expect(
    page.getByText(/The owner and admins see the configured notification/),
  ).toBeVisible();
  await expect(page.getByText(/No outbound connection/)).toHaveCount(0);

  await signOut(page);
  await signIn(page, OWNER);
  await grantEditor(page, "write");
  await signOut(page);
});

test("the owner's fleet tile, schedules with labels and the reports page on Free", async ({
  page,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, OWNER);

  // The Servers tile names the Paid plan's own limit (L11).
  await expect(page.getByText(PAID_TILE)).toBeVisible();
  await expect(page.getByText(/on Free/)).toHaveCount(0);
  await shoot(
    page,
    "fleet",
    async (p) => {
      await expect(p.getByRole("heading", { name: "Fleet" })).toBeVisible();
      await expect(p.getByText(PAID_TILE)).toBeVisible();
    },
    "/",
  );

  // One schedule through the API: the list shows the pack's label on its
  // chip (L3) and the form of a new one shows no Edited marker before a
  // change (L4).
  const csrf = await csrfOf(page);
  const runAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  runAt.setUTCSeconds(0, 0);
  const created = await page.request.post("/api/v1/schedules", {
    headers: { "x-csrf-token": csrf },
    data: {
      server: SERVER,
      name: "P10 label check",
      edits: [{ settingKey: "ExpRate", value: 4 }],
      runHooks: "none",
      timezone: "Europe/Lisbon",
      runAt: runAt.toISOString(),
    },
  });
  expect(created.status()).toBe(201);
  const schedule = (await created.json()) as { id: string };

  await page.goto("/schedules");
  await expect(page.getByText("P10 label check").first()).toBeVisible();
  await expect(
    page.getByText("Experience rate: set to 4").first(),
  ).toBeVisible();
  await expect(page.getByText("ExpRate: set to 4")).toHaveCount(0);
  await expect(page.getByText("Runs and reverts due this week")).toBeVisible();
  await shoot(
    page,
    "schedules",
    async (p) => {
      await expect(p.getByText("P10 label check").first()).toBeVisible();
      await expect(
        p.getByText("Experience rate: set to 4").first(),
      ).toBeVisible();
    },
    "/schedules",
  );
  await shoot(
    page,
    "schedules-form",
    async (p) => {
      await p.getByRole("button", { name: "New schedule" }).first().click();
      const form = p.getByRole("form", { name: "New schedule" });
      await form.getByLabel("Server").selectOption(SERVER);
      await form.getByLabel("Add a setting").selectOption("ExpRate");
      await form.getByRole("button", { name: "Add", exact: true }).click();
      await expect(form.getByLabel("Experience rate")).toBeVisible();
      await expect(form.getByText("Edited", { exact: true })).toHaveCount(0);
      await expect(
        form.getByRole("button", { name: /Remove Experience rate/ }),
      ).toBeVisible();
    },
    "/schedules",
    false,
  );
  const removed = await page.request.delete(
    `/api/v1/schedules/${schedule.id}`,
    { headers: { "x-csrf-token": csrf } },
  );
  expect(removed.ok()).toBeTruthy();

  // The reports page on Paid: the Copied state of the Markdown tab does not
  // reach the Discord tab (L7).
  await page.goto("/reports");
  await page.getByRole("button", { name: "Last 30 days" }).click();
  await page.getByRole("button", { name: "Build the report" }).click();
  await expect(page.getByLabel("Report preview")).toBeVisible();
  await page.getByRole("tab", { name: "Markdown" }).click();
  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: "Copy Markdown" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  await page.getByRole("tab", { name: "Discord" }).click();
  await expect(
    page
      .getByRole("tabpanel")
      .getByRole("button", { name: "Copy the message" }),
  ).toBeVisible();

  // The key goes out: the reports page says Paid before any build (L6).
  await page.goto("/settings/licence");
  await page.getByRole("button", { name: "Remove the key" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Remove the licence key",
  });
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Licence removed").first()).toBeVisible();
  const reportsFreeReady = async (p: Page) => {
    await expect(
      p.getByText("Reports is part of the Paid plan."),
    ).toBeVisible();
    await expect(
      p.getByRole("button", { name: "Build the report" }),
    ).toBeDisabled();
  };
  await page.goto("/reports");
  await reportsFreeReady(page);
  await shoot(page, "reports-free", reportsFreeReady, "/reports");

  // The fleet tile on Free names the editable servers.
  await page.goto("/");
  await expect(page.getByText(/Free plan: 3 editable servers/)).toBeVisible();

  // The key goes back in: Paid again, as the instance was found.
  await page.goto("/settings/licence");
  await page.getByLabel("Key").fill(PAID_LICENCE);
  await page.getByRole("button", { name: "Use this key" }).click();
  await expect(page.getByText("Paid plan is on").first()).toBeVisible();
  await page.goto("/");
  await expect(page.getByText(PAID_TILE)).toBeVisible();
});
