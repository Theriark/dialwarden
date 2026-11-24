// The visual walk (references/ui-standard.md): every screen of the current
// phase at 1440, 768 and 390 in light and dark, saved as CI artifacts for the
// phase report. It runs last, after the editor and P6 walks, so the server,
// the licence, the hook and a pending change exist. The docker hook is the
// SimProxy of the P6 walk pattern: the status it reports is simulated. The
// shots are JPEG because the artifact download of the CI evidence path is
// bounded at 8 MiB per artifact.
/* eslint-disable security/detect-non-literal-fs-filename -- one shots folder the CI job owns */
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { CONTAINER_LABEL, SimProxy } from "./sim-proxy";

const OWNER = {
  email: "owner@example.net",
  password: "correct horse battery staple",
};

const SHOTS = "e2e-shots";
const WIDTHS = [1440, 768, 390] as const;
const THEMES = ["light", "dark"] as const;

interface Screen {
  readonly name: string;
  readonly path: string;
  /** Viewport-only shot; the default captures the whole page. */
  readonly full?: boolean | undefined;
  readonly ready: (page: Page) => Promise<void>;
}

const SCREENS: readonly Screen[] = [
  {
    name: "fleet",
    path: "/",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();
    },
  },
  {
    name: "wizard",
    path: "/servers/new",
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Add server" }),
      ).toBeVisible();
    },
  },
  {
    name: "settings",
    path: "/servers/palworld-home/settings",
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Palworld Home settings" }),
      ).toBeVisible();
    },
  },
  {
    name: "raw",
    path: "/servers/palworld-home/raw",
    ready: async (page) => {
      await expect(page.getByText("Palworld Home raw files")).toBeVisible();
    },
  },
  {
    name: "history",
    path: "/servers/palworld-home/history",
    ready: async (page) => {
      await expect(page.getByText("First import")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Waiting for the server to stop" }),
      ).toBeVisible();
    },
  },
  {
    name: "hooks",
    path: "/servers/palworld-home/hooks",
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Palworld Home hooks" }),
      ).toBeVisible();
      await expect(page.getByText("Running").first()).toBeVisible();
    },
  },
  {
    name: "launch",
    path: "/servers/palworld-home/launch",
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Palworld Home launch" }),
      ).toBeVisible();
      await expect(page.getByLabel("Bash snippet")).toBeVisible();
    },
  },
  {
    name: "activity",
    path: "/activity",
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Activity" }),
      ).toBeVisible();
      await expect(page.getByText("Change applied").first()).toBeVisible();
    },
  },
  {
    name: "presets",
    path: "/presets",
    ready: async (page) => {
      await expect(page.getByText("No presets yet")).toBeVisible();
    },
  },
  {
    name: "presets-create",
    path: "/presets",
    full: false,
    ready: async (page) => {
      await expect(page.getByText("No presets yet")).toBeVisible();
      await page.getByRole("button", { name: "Create preset" }).click();
      // The confirm dialog is a Radix alert dialog, so its role is
      // alertdialog, unlike the save dialog's plain dialog.
      await expect(
        page.getByRole("alertdialog", { name: "Create a preset" }),
      ).toBeVisible();
      await expect(page.getByLabel("From server")).toHaveValue("");
    },
  },
  {
    name: "plan",
    path: "/settings/plan",
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Every server is editable" }),
      ).toBeVisible();
    },
  },
  {
    name: "licence",
    path: "/settings/licence",
    ready: async (page) => {
      await expect(page.getByText("E2E Customer")).toBeVisible();
    },
  },
  {
    name: "raw-blocked",
    path: "/servers/palworld-home/raw",
    full: false,
    ready: async (page) => {
      await expect(page.getByText("Palworld Home raw files")).toBeVisible();
      await page.locator(".monaco-editor").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("this line has no key value pair");
      await expect(page.locator(".squiggly-error").first()).toBeVisible();
      await expect(page.getByText("fix the errors first")).toBeVisible();
    },
  },
  {
    name: "save-dialog",
    path: "/servers/palworld-home/settings",
    full: false,
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Palworld Home settings" }),
      ).toBeVisible();
      await page.getByLabel("Search settings").fill("Experience rate");
      // On the phone widths the settings groups sit behind their
      // accordions, so the Rates group is opened before the field is
      // filled; the wider widths render the groups open already.
      if ((page.viewportSize()?.width ?? 0) < 640) {
        await page.getByText("Rates", { exact: true }).first().click();
      }
      // Whatever the walks before this one left in the field, the next
      // value up (wrapped inside the pack's range) is always a change.
      const field = page.getByLabel("Experience rate");
      const current = Number(await field.inputValue());
      await field.fill(String((current % 20) + 1));
      await page.getByRole("button", { name: "Review and save" }).click();
      await expect(
        page.getByRole("dialog", { name: "Save these changes?" }),
      ).toBeVisible();
      await expect(
        page.getByRole("radio", { name: /Save and restart/ }),
      ).toBeVisible();
    },
  },
  {
    name: "wizard-sftp",
    path: "/servers/new",
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { name: "Add server" }),
      ).toBeVisible();
      await page.getByText("SFTP", { exact: true }).click();
      await expect(page.getByText("This instance's public key")).toBeVisible();
    },
  },
];

test("every screen at 1440, 768 and 390 in light and dark", async ({
  page,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  const sim = new SimProxy();
  await sim.start();
  await page.goto("/login");
  await page.getByLabel("E-mail address").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();

  // The hook of the P6 walk points at a port of its own worker, so this
  // walk re-points it at this one's simulated proxy through the same API
  // the Hooks page uses, and puts the container back up.
  const session = (await (
    await page.request.get("/api/v1/auth/session")
  ).json()) as { csrfToken: string };
  const saved = await page.request.put("/api/v1/servers/palworld-home/hooks", {
    headers: { "x-csrf-token": session.csrfToken },
    data: {
      hook: {
        kind: "dockerProxy",
        url: `http://127.0.0.1:${sim.port}`,
        containerLabel: CONTAINER_LABEL,
      },
    },
  });
  expect(saved.ok()).toBeTruthy();
  sim.running = true;

  // One pending change for the pending list of the history screen: the
  // simulated container runs, so the stopped-only change parks.
  await page.goto("/servers/palworld-home/settings");
  await page.getByLabel("Search settings").fill("Experience rate");
  if ((page.viewportSize()?.width ?? 0) < 640) {
    await page.getByText("Rates", { exact: true }).first().click();
  }
  const field = page.getByLabel("Experience rate");
  const current = Number(await field.inputValue());
  await field.fill(String((current % 20) + 1));
  await page.getByRole("button", { name: "Review and save" }).click();
  const dialog = page.getByRole("dialog", { name: "Save these changes?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "1 pending change" }),
  ).toBeVisible();

  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of WIDTHS) {
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : 900,
      });
      for (const screen of SCREENS) {
        await page.goto(screen.path);
        await screen.ready(page);
        await page.screenshot({
          path: `${SHOTS}/p6-${screen.name}-${width}-${theme}.jpg`,
          type: "jpeg",
          quality: 75,
          fullPage: screen.full !== false,
        });
      }
    }
  }
  sim.close();
});
