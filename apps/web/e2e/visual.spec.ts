// The visual walk of the P5 editor (THE-2493, references/ui-standard.md):
// every screen of the phase at 1440, 768 and 390 in light and dark, saved as
// CI artifacts for the phase report. It runs after the editor walk, so the
// server and the Paid licence exist. The shots are JPEG because the artifact
// download of the CI evidence path is bounded at 8 MiB per artifact.
/* eslint-disable security/detect-non-literal-fs-filename -- one shots folder the CI job owns */
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

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
    },
  },
  {
    name: "presets",
    path: "/presets",
    ready: async (page) => {
      await expect(
        page.getByText("Presets are not on this build yet"),
      ).toBeVisible();
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
];

test("every screen at 1440, 768 and 390 in light and dark", async ({
  page,
}) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.goto("/login");
  await page.getByLabel("E-mail address").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();

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
          path: `${SHOTS}/p5-${screen.name}-${width}-${theme}.jpg`,
          type: "jpeg",
          quality: 75,
          fullPage: true,
        });
      }
    }
  }
});
