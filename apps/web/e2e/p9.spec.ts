// The e2e walk of P9 (dev-work-plan P9-C) over the server built from source,
// after the P8 walk left the owner, the team, one Palworld server and the
// Paid licence. A second Palworld server is added from a copy of the fixture
// folder, so the fleet layer has something to compare: the bulk apply of a
// preset to both, a run-at and a cron schedule with the calendar, the
// background drift check and an outside edit found by it, the notification
// channels with a masked secret kept through an edit, the send test's error
// state (the receiver is a name that resolves nowhere), the in-app bell, the
// matrix with many, one and no servers, the report preview, the Free
// fallback of every P9 screen after the key is removed, and the screenshots
// of every screen at 1440, 768 and 390 in light and dark. The instance is
// left as the visual walk expects: Paid, no preset, no schedule, no channel.
/* eslint-disable security/detect-non-literal-fs-filename -- the fixture folders of the CI job */
import { appendFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SERVER_DIR = process.env.E2E_SERVER_DIR ?? "";
const PAID_LICENCE = process.env.E2E_PAID_LICENCE ?? "";
const AWAY_DIR = join(dirname(SERVER_DIR), "palworld-away");
const SHOTS = "e2e-shots";
const WIDTHS = [1440, 768, 390] as const;
const THEMES = ["light", "dark"] as const;

const OWNER = {
  email: "owner@example.net",
  password: "correct horse battery staple",
};
const VIEWER = {
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

/** One applied change of the experience rate through the API. */
async function applyRate(
  page: Page,
  slug: string,
  value: number,
): Promise<void> {
  const csrf = await csrfOf(page);
  const created = await page.request.post(
    `/api/v1/servers/${slug}/change-sets`,
    {
      headers: { "x-csrf-token": csrf },
      data: { edits: [{ settingKey: "ExpRate", value }] },
    },
  );
  expect(created.ok()).toBeTruthy();
  const changeSet = (await created.json()) as { id: string };
  const applied = await page.request.post(
    `/api/v1/change-sets/${changeSet.id}/apply`,
    { headers: { "x-csrf-token": csrf }, data: { runHooks: "none" } },
  );
  expect(applied.ok()).toBeTruthy();
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
        path: `${SHOTS}/p9-${name}-${width}-${theme}.jpg`,
        type: "jpeg",
        quality: 75,
        fullPage: full,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 720 });
}

test("a second server joins and a preset is applied to both at once", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);

  // A copy of the fixture folder beside the first one (never inside the
  // data dir, which the Local connector refuses).
  if (!existsSync(AWAY_DIR)) {
    mkdirSync(AWAY_DIR, { recursive: true });
    cpSync(SERVER_DIR, AWAY_DIR, { recursive: true });
  }
  const csrf = await csrfOf(page);
  const added = await page.request.post("/api/v1/servers", {
    headers: { "x-csrf-token": csrf },
    data: {
      name: "Palworld Away",
      id: "palworld-away",
      packId: "palworld",
      os: "linux",
      connector: { kind: "local", root: AWAY_DIR },
    },
  });
  expect([201, 409]).toContain(added.status());

  const preset = await page.request.post("/api/v1/presets", {
    headers: { "x-csrf-token": csrf },
    data: {
      name: "Bulk rates",
      description: "Five times the experience, everywhere.",
      packId: "palworld",
      values: { ExpRate: 5 },
    },
  });
  expect(preset.status()).toBe(201);

  // The wizard: both servers, one draft each, save only, both applied.
  await page.goto("/presets");
  await expect(page.getByText("Bulk rates").first()).toBeVisible();
  await page.getByRole("button", { name: "Apply to many servers" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Apply Bulk rates to many servers",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Servers of Palworld (2 of 2 chosen)"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Next: review the diffs" }).click();
  await expect(
    dialog.getByText(/2 of 2 servers have a change set ready/),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Experience rate: \d+ → 5/).first(),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Next: hooks" }).click();
  await expect(dialog.getByRole("radio", { name: /Save only/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Apply to 2 servers" }).click();
  await expect(dialog.getByText("Every server took the preset")).toBeVisible();
  const results = dialog.getByRole("table", { name: "Results by server" });
  await expect(results.getByText("Applied")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Close" }).last().click();
  await expect(dialog).toHaveCount(0);

  // The files really hold the value on both servers.
  for (const slug of ["palworld-home", "palworld-away"]) {
    const settings = (await (
      await page.request.get(`/api/v1/servers/${slug}/settings`)
    ).json()) as { values: Record<string, unknown> };
    expect(settings.values["ExpRate"]).toBe(5);
  }
});

test("schedules: a run-at schedule, its replacement, a cron pattern and the calendar", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto("/schedules");
  await expect(page.getByText("No schedule yet")).toBeVisible();

  // A run-at schedule, typed with the editor's own field.
  await page.getByRole("button", { name: "New schedule" }).first().click();
  const form = page.getByRole("form", { name: "New schedule" });
  await form.getByLabel("Server").selectOption("palworld-home");
  await form.getByLabel("Name").fill("Weekend rates");
  await form.getByLabel("Time zone").selectOption("UTC");
  const runAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const runAtLocal = `${runAt.toISOString().slice(0, 10)}T04:00`;
  await form.getByLabel("Run at").fill(runAtLocal);
  await form.getByLabel("Add a setting").selectOption("ExpRate");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await form.getByLabel("Experience rate").fill("4");
  await expect(form.getByText(/Experience rate: 5 → 4/)).toBeVisible();
  await form.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByText("Schedule created").first()).toBeVisible();
  await expect(page.getByText("Weekend rates").first()).toBeVisible();
  await expect(
    page.getByText("Scheduled", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("grid", { name: /Schedules in/ })).toBeVisible();
  await expect(page.getByText("Runs due this week")).toBeVisible();

  // Editing replaces: the old one goes, the new one carries the new name.
  await page.getByRole("button", { name: "Edit" }).first().click();
  const edit = page.getByRole("form", { name: "Replace schedule" });
  await expect(edit.getByLabel("Server")).toBeDisabled();
  await edit.getByLabel("Name").fill("Weekend rates, renamed");
  await edit.getByRole("button", { name: "Replace schedule" }).click();
  await expect(page.getByText("Schedule replaced").first()).toBeVisible();
  await expect(page.getByText("Weekend rates, renamed").first()).toBeVisible();
  const listed = (await (
    await page.request.get("/api/v1/schedules")
  ).json()) as {
    items: { name: string }[];
  };
  expect(listed.items.map((item) => item.name)).toEqual([
    "Weekend rates, renamed",
  ]);

  // A cron schedule with a revert delay, then its deletion.
  await page.getByRole("button", { name: "New schedule" }).first().click();
  const cron = page.getByRole("form", { name: "New schedule" });
  await cron.getByLabel("Server").selectOption("palworld-away");
  await cron.getByLabel("Name").fill("Nightly reset");
  await cron.getByRole("radio", { name: /Repeat on a cron pattern/ }).check();
  await cron.getByLabel("Cron pattern").fill("0 4 * * *");
  await cron.getByLabel("Time zone").selectOption("UTC");
  await expect(cron.getByText(/Every day at 04:00 \(UTC\)/)).toBeVisible();
  await cron.getByLabel("Revert after (minutes, optional)").fill("60");
  await cron.getByLabel("Add a setting").selectOption("ExpRate");
  await cron.getByRole("button", { name: "Add", exact: true }).click();
  await cron.getByLabel("Experience rate").fill("2");
  await cron.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByText("Schedule created").first()).toBeVisible();
  await expect(page.getByText("Nightly reset").first()).toBeVisible();
  await expect(
    page.getByText("60 minutes after each run").first(),
  ).toBeVisible();

  const row = page.locator("li", { hasText: "Nightly reset" }).first();
  await row.getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Delete Nightly reset?",
  });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Schedule deleted").first()).toBeVisible();
  await expect(page.getByText("Nightly reset")).toHaveCount(0);

  // A viewer reads the schedules and makes none.
  await signOut(page);
  await signIn(page, VIEWER);
  await page.goto("/schedules");
  await expect(page.getByText(/You are signed in as viewer/)).toBeVisible();
  await expect(page.getByText("Weekend rates, renamed").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "New schedule" })).toHaveCount(
    0,
  );
  await signOut(page);
});

test("drift: the background check finds an outside edit, on the card, the fleet and the feed", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto("/servers/palworld-home/history");
  const card = page
    .locator("section", { hasText: "Background drift check" })
    .first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Checked: clean").first()).toBeVisible();

  // The timer goes on, every five minutes.
  await card.getByRole("switch", { name: "Check on a timer" }).click();
  await card.getByLabel("Every (minutes)").fill("5");
  await card.getByRole("button", { name: "Save drift settings" }).click();
  await expect(
    page.getByText("Background check every 5 minutes").first(),
  ).toBeVisible();

  // An edit outside Dialwarden: one comment line in the settings file.
  appendFileSync(
    join(
      SERVER_DIR,
      "Pal",
      "Saved",
      "Config",
      "LinuxServer",
      "PalWorldSettings.ini",
    ),
    "\n; edited outside Dialwarden by the P9 walk\n",
  );
  await card.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Checked: drift found").first()).toBeVisible();
  await expect(card.getByText("Drift found")).toBeVisible();
  await expect(
    page.getByText("Edited outside Dialwarden").first(),
  ).toBeVisible();

  // The fleet card carries the drift badge, linked to the history.
  await page.goto("/");
  const drift = page.getByRole("link", { name: "Drift" }).first();
  await expect(drift).toBeVisible();
  await drift.click();
  await expect(page).toHaveURL("/servers/palworld-home/history");

  // The Activity feed's Drift tab holds the event, linked to the history.
  await page.goto("/activity");
  await page.getByRole("tab", { name: "Drift" }).click();
  await expect(
    page.getByText(/Files changed outside Dialwarden/).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Palworld Home" }).first(),
  ).toBeVisible();

  // The timer goes off again, so nothing runs behind the later walks.
  await page.goto("/servers/palworld-home/history");
  await card.getByRole("switch", { name: "Check on a timer" }).click();
  await card.getByRole("button", { name: "Save drift settings" }).click();
  await expect(page.getByText("Background check off").first()).toBeVisible();
});

test("notifications: channels, a masked secret kept through an edit, the send test and the bell", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto("/settings/notifications");
  await expect(page.getByText("No channel yet")).toBeVisible();

  // The in-app channel.
  await page.getByRole("button", { name: "Add channel" }).first().click();
  let form = page.getByRole("form", { name: "New channel" });
  await form.getByLabel("Name").fill("Bell");
  await form.getByRole("radio", { name: /In-app/ }).check();
  await form.getByRole("button", { name: "All" }).click();
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByText("Channel created").first()).toBeVisible();
  await expect(page.getByText("The bell in the top bar").first()).toBeVisible();

  // A signed webhook to a name that resolves nowhere: stored, masked, and
  // the send test answers an error state in words.
  await page.getByRole("button", { name: "Add channel" }).first().click();
  form = page.getByRole("form", { name: "New channel" });
  await form.getByLabel("Name").fill("Ops hook");
  await form.getByRole("radio", { name: /Webhook/ }).check();
  await form
    .getByLabel("Webhook address")
    .fill("https://hooks.example.invalid/dialwarden");
  await form.getByLabel("Signing secret").fill("0123456789abcdef0123");
  await form.getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByText("Channel created").first()).toBeVisible();
  const hook = page.locator("section", { hasText: "Ops hook" }).first();
  await expect(hook.getByText("hooks.example.invalid · signed")).toBeVisible();
  await hook.getByRole("button", { name: "Send test" }).click();
  await expect(hook.getByText("Test message not delivered")).toBeVisible({
    timeout: 60_000,
  });

  // The edit shows the address masked and the secret as stored; saving
  // with both untouched keeps them.
  await hook.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("form", { name: "Edit channel" });
  await expect(edit.getByLabel("Webhook address")).toHaveValue(/\*\*\*$/);
  await expect(edit.getByLabel("Signing secret")).toHaveAttribute(
    "placeholder",
    "Stored; leave empty to keep it",
  );
  await edit.getByLabel("Name").fill("Ops hook, renamed");
  await edit.getByRole("button", { name: "Save channel" }).click();
  await expect(page.getByText("Channel saved").first()).toBeVisible();
  const renamed = page
    .locator("section", { hasText: "Ops hook, renamed" })
    .first();
  await expect(
    renamed.getByText("hooks.example.invalid · signed"),
  ).toBeVisible();

  // An applied change reaches the bell through the in-app channel.
  await applyRate(page, "palworld-away", 7);
  await page.goto("/");
  const bell = page.getByRole("button", {
    name: /^Notifications, \d+ unread$/,
  });
  await expect(bell).toBeVisible({ timeout: 30_000 });
  await bell.click();
  const inbox = page.getByRole("dialog", { name: "Notifications" });
  await expect(
    inbox.getByText(/Change applied on Palworld Away/).first(),
  ).toBeVisible();
  await inbox.getByRole("button", { name: "Mark all as read" }).click();
  await expect(
    inbox.getByRole("button", { name: "Mark all as read" }),
  ).toBeDisabled();
  await inbox.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();

  // The About page names the webhook host as the only outbound connection.
  await page.goto("/about");
  await expect(page.getByText("hooks.example.invalid").first()).toBeVisible();
});

test("matrix: many servers with the differences marked, one server, no server", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  // The two servers differ on one value after the bell walk's apply.
  await page.goto("/matrix");
  const table = page.getByRole("table", {
    name: "Palworld settings by server",
  });
  await expect(table).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ settings differ/)).toBeVisible();
  await expect(table.getByText("Differs").first()).toBeVisible();
  await expect(table.getByText("Same").first()).toBeVisible();
  const all = await table.getByRole("row").count();
  await page.getByRole("switch", { name: "Differences only" }).click();
  await expect.poll(() => table.getByRole("row").count()).toBeLessThan(all);
  await expect(table.getByText("Same")).toHaveCount(0);
  await page.getByRole("switch", { name: "Differences only" }).click();

  // The group filter asks the server for one group.
  await page.getByLabel("Settings group").selectOption("Rates");
  await expect(table.getByText("Experience rate").first()).toBeVisible();
  await page.getByLabel("Settings group").selectOption("");

  // One server in view: nothing to compare, the values are listed.
  await page.getByLabel("Palworld Away").uncheck();
  await expect(page.getByText("Only one server to show")).toBeVisible();
  await expect(table).toBeVisible();

  // No server in view: the designed state and the way back.
  await page.getByLabel("Palworld Home").uncheck();
  await expect(page.getByText("No server chosen")).toBeVisible();
  await page.getByRole("button", { name: "Show all servers" }).first().click();
  await expect(page.getByText(/\d+ of \d+ settings differ/)).toBeVisible();
});

test("reports: the preview, the Markdown copy, the Discord message and the print view", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto("/reports");
  await expect(page.getByText("No report built yet")).toBeVisible();
  await page.getByRole("button", { name: "Last 30 days" }).click();
  await page.getByRole("button", { name: "Build the report" }).click();
  const preview = page.getByLabel("Report preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Palworld Home (Palworld)")).toBeVisible();
  await expect(preview.getByText(/Experience rate: /).first()).toBeVisible();

  const copy = page.getByRole("button", { name: "Copy Markdown" }).first();
  await copy.click();
  await expect(
    page.getByRole("button", { name: "Copied" }).first(),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Markdown" }).click();
  await expect(page.getByLabel("Markdown text")).toContainText(
    "# Dialwarden change report",
  );
  await page.getByRole("tab", { name: "Discord" }).click();
  await expect(page.getByLabel("Discord preview")).toContainText(
    "Dialwarden change report",
  );

  // The print view is the server's own page: html, no script.
  const href = await page
    .getByRole("link", { name: /Open the print view/ })
    .getAttribute("href");
  expect(href).toContain("/api/v1/reports/changes/print");
  const printed = await page.request.get(href ?? "");
  expect(printed.status()).toBe(200);
  expect(printed.headers()["content-type"]).toContain("text/html");
  const html = await printed.text();
  expect(html).toContain("Dialwarden change report");
  expect(html).not.toContain("<script");
});

test("every P9 screen at 1440, 768 and 390 in light and dark, on Paid", async ({
  page,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, OWNER);

  await shoot(
    page,
    "presets-wizard",
    async (p) => {
      await expect(p.getByText("Bulk rates").first()).toBeVisible();
      await p.getByRole("button", { name: "Apply to many servers" }).click();
      const dialog = p.getByRole("dialog", {
        name: "Apply Bulk rates to many servers",
      });
      await dialog
        .getByRole("button", { name: "Next: review the diffs" })
        .click();
      await expect(
        dialog.getByText(
          /servers have a change set ready|server has a change set ready/,
        ),
      ).toBeVisible();
    },
    "/presets",
    false,
  );
  await shoot(
    page,
    "schedules",
    async (p) => {
      await expect(p.getByText("Weekend rates, renamed").first()).toBeVisible();
      await expect(p.getByRole("grid", { name: /Schedules in/ })).toBeVisible();
    },
    "/schedules",
  );
  await shoot(
    page,
    "schedules-form",
    async (p) => {
      await p.getByRole("button", { name: "New schedule" }).first().click();
      const form = p.getByRole("form", { name: "New schedule" });
      await form.getByLabel("Server").selectOption("palworld-home");
      await form.getByLabel("Add a setting").selectOption("ExpRate");
      await form.getByRole("button", { name: "Add", exact: true }).click();
      await expect(form.getByLabel("Experience rate")).toBeVisible();
    },
    "/schedules",
    false,
  );
  await shoot(
    page,
    "history-drift",
    async (p) => {
      await expect(p.getByText("Background drift check")).toBeVisible();
      await expect(
        p.getByText("Edited outside Dialwarden").first(),
      ).toBeVisible();
    },
    "/servers/palworld-home/history",
  );
  await shoot(
    page,
    "activity-drift",
    async (p) => {
      await p.getByRole("tab", { name: "Drift" }).click();
      await expect(
        p.getByText(/Files changed outside Dialwarden/).first(),
      ).toBeVisible();
    },
    "/activity",
  );
  await shoot(
    page,
    "notifications",
    async (p) => {
      await expect(p.getByText("Ops hook, renamed").first()).toBeVisible();
    },
    "/settings/notifications",
  );
  await shoot(
    page,
    "notifications-form",
    async (p) => {
      await p.getByRole("button", { name: "Add channel" }).first().click();
      const form = p.getByRole("form", { name: "New channel" });
      await form.getByRole("radio", { name: /E-mail/ }).check();
      await expect(form.getByLabel("Mail server host")).toBeVisible();
    },
    "/settings/notifications",
    false,
  );
  await shoot(
    page,
    "inbox",
    async (p) => {
      await expect(p.getByRole("heading", { name: "Fleet" })).toBeVisible();
      await p.getByRole("button", { name: /^Notifications/ }).click();
      await expect(
        p.getByRole("dialog", { name: "Notifications" }),
      ).toBeVisible();
    },
    "/",
    false,
  );
  await shoot(
    page,
    "matrix",
    async (p) => {
      await expect(
        p.getByRole("table", { name: "Palworld settings by server" }),
      ).toBeVisible();
    },
    "/matrix",
  );
  await shoot(
    page,
    "matrix-one",
    async (p) => {
      await expect(
        p.getByRole("table", { name: "Palworld settings by server" }),
      ).toBeVisible();
      await p.getByLabel("Palworld Away").uncheck();
      await expect(p.getByText("Only one server to show")).toBeVisible();
    },
    "/matrix",
    false,
  );
  await shoot(
    page,
    "matrix-none",
    async (p) => {
      await expect(
        p.getByRole("table", { name: "Palworld settings by server" }),
      ).toBeVisible();
      await p.getByLabel("Palworld Away").uncheck();
      await p.getByLabel("Palworld Home").uncheck();
      await expect(p.getByText("No server chosen")).toBeVisible();
    },
    "/matrix",
    false,
  );
  await shoot(
    page,
    "reports",
    async (p) => {
      await p.getByRole("button", { name: "Last 30 days" }).click();
      await p.getByRole("button", { name: "Build the report" }).click();
      await expect(p.getByLabel("Report preview")).toBeVisible();
    },
    "/reports",
  );
  await shoot(
    page,
    "reports-discord",
    async (p) => {
      await p.getByRole("button", { name: "Last 30 days" }).click();
      await p.getByRole("button", { name: "Build the report" }).click();
      await expect(p.getByLabel("Report preview")).toBeVisible();
      await p.getByRole("tab", { name: "Discord" }).click();
      await expect(p.getByLabel("Discord preview")).toBeVisible();
    },
    "/reports",
    false,
  );
});

test("the Free fallback of every P9 screen, then back to Paid and a clean instance", async ({
  page,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, OWNER);

  // The owner removes the licence key: Free at once.
  await page.goto("/settings/licence");
  await page.getByRole("button", { name: "Remove the key" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Remove the licence key",
  });
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Licence removed").first()).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Schedules" }).click();
  await expect(
    page.getByText("Scheduled changes is part of the Paid plan."),
  ).toBeVisible();
  await expect(page.getByText("Paused on the Free plan")).toBeVisible();
  await nav.getByRole("link", { name: "Matrix" }).click();
  await expect(
    page.getByText("The fleet settings matrix is part of the Paid plan."),
  ).toBeVisible();
  await nav.getByRole("link", { name: "Reports" }).click();
  await page.getByRole("button", { name: "Build the report" }).click();
  await expect(
    page.getByText("Reports is part of the Paid plan."),
  ).toBeVisible();
  await page.goto("/settings/notifications");
  await expect(
    page.getByText("Notification channels is part of the Paid plan."),
  ).toBeVisible();
  // The bell is gone on Free; the presets wizard carries the hint.
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /^Notifications/ }),
  ).toHaveCount(0);
  await page.goto("/presets");
  await page.getByRole("button", { name: "Apply to many servers" }).click();
  await expect(
    page.getByText(
      "Applying presets to many servers at once is part of the Paid plan.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next: review the diffs" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");

  await shoot(
    page,
    "schedules-free",
    async (p) => {
      await expect(p.getByText("Paused on the Free plan")).toBeVisible();
    },
    "/schedules",
  );
  await shoot(
    page,
    "matrix-free",
    async (p) => {
      await expect(
        p.getByText("The fleet settings matrix is part of the Paid plan."),
      ).toBeVisible();
    },
    "/matrix",
  );
  await shoot(
    page,
    "reports-free",
    async (p) => {
      await p.getByRole("button", { name: "Build the report" }).click();
      await expect(
        p.getByText("Reports is part of the Paid plan."),
      ).toBeVisible();
    },
    "/reports",
  );
  await shoot(
    page,
    "notifications-free",
    async (p) => {
      await expect(
        p.getByText("Notification channels is part of the Paid plan."),
      ).toBeVisible();
    },
    "/settings/notifications",
  );

  // The key goes back in: the schedule is active again, without a reload.
  await page.goto("/settings/licence");
  await page.getByLabel("Key").fill(PAID_LICENCE);
  await page.getByRole("button", { name: "Use this key" }).click();
  await expect(page.getByText("Paid plan is on").first()).toBeVisible();
  await nav.getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByText("Weekend rates, renamed").first()).toBeVisible();
  await expect(
    page.getByText("Scheduled", { exact: true }).first(),
  ).toBeVisible();

  // Leave the instance as the visual walk expects: no schedule, no channel,
  // no preset, the away server gone.
  const csrf = await csrfOf(page);
  const schedules = (await (
    await page.request.get("/api/v1/schedules")
  ).json()) as {
    items: { id: string }[];
  };
  for (const schedule of schedules.items) {
    await page.request.delete(`/api/v1/schedules/${schedule.id}`, {
      headers: { "x-csrf-token": csrf },
    });
  }
  const channels = (await (
    await page.request.get("/api/v1/notifications/channels")
  ).json()) as { items: { id: string }[] };
  for (const channel of channels.items) {
    await page.request.delete(`/api/v1/notifications/channels/${channel.id}`, {
      headers: { "x-csrf-token": csrf },
    });
  }
  const presets = (await (
    await page.request.get("/api/v1/presets")
  ).json()) as {
    items: { id: string }[];
  };
  for (const preset of presets.items) {
    await page.request.delete(`/api/v1/presets/${preset.id}`, {
      headers: { "x-csrf-token": csrf },
    });
  }
  const gone = await page.request.delete("/api/v1/servers/palworld-away", {
    headers: { "x-csrf-token": csrf },
  });
  expect(gone.ok()).toBeTruthy();
  await page.goto("/presets");
  await expect(page.getByText("No presets yet").first()).toBeVisible();
});
