// The e2e walk of the P5 editor (dev-work-plan P5) against the server built
// from source: first-run setup, sign-in, add a server over the Local
// connector, edit a setting, review the diff, save, roll back, the raw
// editor, the Free plan selection and the presets state — all on the Free
// plan. Then the licence of the paid plan is entered through the licence page
// the way a customer does, and the Paid differences show. Serial by design:
// each step builds on the last.
/* eslint-disable security/detect-non-literal-fs-filename -- the throwaway data dir of the CI job */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const DATA_DIR = process.env.E2E_DATA_DIR ?? "";
const SERVER_DIR = process.env.E2E_SERVER_DIR ?? "";
const PAID_LICENCE = process.env.E2E_PAID_LICENCE ?? "";

test.describe.configure({ mode: "serial" });

const OWNER = {
  name: "Owner Quinn",
  email: "owner@example.net",
  password: "correct horse battery staple",
};

async function firstRunSetup(page: Page): Promise<void> {
  const token = readFileSync(join(DATA_DIR, "setup-token"), "utf8").trim();
  await page.goto("/setup");
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("E-mail address").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Password again").fill(OWNER.password);
  await page.getByLabel("Setup token").fill(token);
  await page.getByRole("button", { name: "Create the owner account" }).click();
  await expect(page).toHaveURL("/");
}

/** The text of the raw editor's rendered lines, top to bottom. */
async function renderedLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".view-line"))
      .map((line) => ({
        top: Number.parseFloat(line.style.top),
        text: (line.textContent ?? "").replace(/\xa0/g, " "),
      }))
      .sort((a, b) => a.top - b.top)
      .map((line) => line.text),
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail address").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

test("the Free plan: setup, add a server, edit, save, roll back", async ({
  page,
}) => {
  await firstRunSetup(page);

  // The fleet wall is empty and offers the first server.
  await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();
  await expect(page.getByText("No servers yet").first()).toBeVisible();
  await expect(
    page
      .getByText("Add your first game server to edit its settings safely")
      .first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "Add server" }).first().click();
  await expect(page).toHaveURL("/servers/new");

  // With the SFTP connector the wizard never scrolls sideways at 390: the
  // fingerprint wraps and Copy key sits on its own row (live check F4).
  await page.getByText("SFTP", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("This instance's public key")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByText("Local folder", { exact: true }).click();

  // The wizard: name, Local connector pointing at the fixture folder.
  await page.getByLabel("Server name").fill("Palworld Home");
  await page.getByLabel("Server folder").fill(SERVER_DIR);
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Connected to").first()).toBeVisible();
  await page.getByRole("button", { name: "Detect the game" }).click();
  await expect(page.getByText("Palworld").first()).toBeVisible();
  await page.getByRole("button", { name: "Add server" }).click();
  await expect(page).toHaveURL("/servers/palworld-home/settings");

  // The typed editor shows the pack and the Rates group of the settings.
  await expect(
    page.getByRole("heading", { name: "Palworld Home settings" }),
  ).toBeVisible();
  await expect(page.getByText("pack matches the server").first()).toBeVisible();
  await expect(page.getByText("Rates", { exact: true }).first()).toBeVisible();

  // Search narrows to the Experience rate setting, keyboard-first.
  await page.getByLabel("Search settings").click();
  await page.getByLabel("Search settings").fill("Experience rate");
  await expect(page.getByLabel("Experience rate")).toHaveCount(1);
  await page.getByLabel("Experience rate").fill("2");
  await expect(page.getByText("1 setting changed").first()).toBeVisible();

  // Review shows the semantic chip and the restart warning, then applies.
  await page.getByRole("button", { name: "Review and save" }).click();
  await expect(page.getByText("Save these changes?").first()).toBeVisible();
  await expect(page.getByText("Experience rate: 1 → 2").first()).toBeVisible();
  await expect(
    page.getByText("1 setting needs a server restart to take effect.").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Changes saved").first()).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Save these changes?" }),
  ).toHaveCount(0);

  // The history timeline holds the import and the change; one click restores.
  await page
    .getByRole("link", { name: "History", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL("/servers/palworld-home/history");
  await expect(page.getByText("First import").first()).toBeVisible();
  await expect(page.getByText("Changed in Dialwarden").first()).toBeVisible();
  await expect(page.getByText("Experience rate: 1 → 2").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Restore this version" })
    .first()
    .click();
  await expect(page.getByText("Version restored").first()).toBeVisible();
  await expect(
    page.getByText("Rollback", { exact: true }).first(),
  ).toBeVisible();

  // The restore really rolled the file back: the before snapshot is the
  // one restored, so the editor shows the old value again (finding H1).
  await page.goto("/servers/palworld-home/settings");
  await page.getByLabel("Search settings").fill("Experience rate");
  await expect(page.getByLabel("Experience rate")).toHaveCount(1);
  await expect(page.getByLabel("Experience rate")).toHaveValue("1");

  // The raw editor loads Monaco over the settings file, owner only.
  await page.goto("/servers/palworld-home/raw");
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.getByLabel("File")).toBeVisible();

  // Fast typing keeps the caret where it is (live check F13): a burst at
  // about 12 ms per key lands at the end of the first line, where the
  // caret sits, and never at the end of the file. The first line is a
  // comment, so the file stays valid and the save turns on.
  const burst = "fastburst0123456789";
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.type(burst, { delay: 12 });
  await expect
    .poll(async () => (await renderedLines(page))[0] ?? "")
    .toMatch(/^; Synthetic Palworld settings file .*fastburst0123456789$/);
  const lines = await renderedLines(page);
  expect(lines.filter((line) => line.includes(burst))).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Review and save" }),
  ).toBeEnabled();
  await expect(page.locator(".squiggly-error")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".monaco-editor")).toBeVisible();

  // A malformed line marks the gutter at once (live check F3) and blocks
  // the save with the typed editor's words (F1), so no failed change set
  // is ever created.
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("this line has no key value pair");
  await expect(page.locator(".squiggly-error").first()).toBeVisible();
  // The glyph margin carries the error icon on that line too (F3a).
  await expect(page.locator(".dw-lint-glyph-error").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review and save" }),
  ).toBeDisabled();
  await expect(page.getByText("fix the errors first")).toBeVisible();
  await page.reload();
  await expect(page.locator(".monaco-editor")).toBeVisible();

  // The Free plan selection shows the one server as editable.
  await page.goto("/settings/plan");
  await expect(
    page.getByRole("heading", { name: "Choose your three servers" }),
  ).toBeVisible();
  await expect(page.getByText("Palworld Home").first()).toBeVisible();
  await expect(page.getByText("1 of 3 in use").first()).toBeVisible();

  // The presets screen answers with its real empty state now that the API
  // ships (THE-2542).
  await page.goto("/presets");
  await expect(page.getByText("No presets yet").first()).toBeVisible();
});

test("the Paid plan: the licence page switches the entitlement", async ({
  page,
}) => {
  await signIn(page);

  // Enter the licence the way a customer does.
  await page.goto("/settings/licence");
  await page.getByLabel("Key").fill(PAID_LICENCE);
  await page.getByRole("button", { name: "Use this key" }).click();
  await expect(page.getByText("E2E Customer").first()).toBeVisible();
  await expect(
    page.getByText("Active", { exact: false }).first(),
  ).toBeVisible();

  // The plan page now confirms every server is editable.
  await page.goto("/settings/plan");
  await expect(
    page.getByRole("heading", { name: "Every server is editable" }),
  ).toBeVisible();

  // The history timeline shows everything; the Free line is gone.
  await page.goto("/servers/palworld-home/history");
  await expect(page.getByText("First import").first()).toBeVisible();
  await expect(page.getByText("kept and visible on the Paid plan")).toHaveCount(
    0,
  );
});
