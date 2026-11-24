// The e2e walk of P6 (dev-work-plan P6-C) over the server built from source:
// the hook configuration and the simulated status, the apply choice in the
// save dialog, the stopped-only change that parks as pending until the stop
// hook writes it, the save-and-restart stop-start cycle, the Activity page
// and the launch page with its snippets. The docker hook is the SimProxy
// this spec runs itself: every stop, start and restart below is simulated,
// no container exists, and the game never runs.
import { expect, test, type Page } from "@playwright/test";
import { CONTAINER_LABEL, SimProxy } from "./sim-proxy";

const OWNER = {
  email: "owner@example.net",
  password: "correct horse battery staple",
};

const sim = new SimProxy();

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await sim.start();
});

test.afterAll(() => {
  sim.close();
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail address").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

/** One typed setting through the review dialog, however it is applied. */
async function editExperienceRate(page: Page, value: string): Promise<void> {
  await page.goto("/servers/palworld-home/settings");
  await page.getByLabel("Search settings").fill("Experience rate");
  await page.getByLabel("Experience rate").fill(value);
  await page.getByRole("button", { name: "Review and save" }).click();
  await expect(
    page.getByRole("dialog", { name: "Save these changes?" }),
  ).toBeVisible();
}

test("a stopped-only save parks as pending until the stop hook writes it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);

  // The Hooks tab: no hook yet, so the status answers unknown.
  await page.goto("/servers/palworld-home/hooks");
  await expect(
    page.getByRole("heading", { name: "Palworld Home hooks" }),
  ).toBeVisible();
  await expect(page.getByText("Unknown").first()).toBeVisible();

  // The owner points the hook at the simulated docker proxy.
  await page.getByText("Docker socket proxy").click();
  await page.getByLabel("Proxy address").fill(`http://127.0.0.1:${sim.port}`);
  await page.getByLabel("Container label").fill(CONTAINER_LABEL);
  await page.getByRole("button", { name: "Save hook" }).click();
  await expect(page.getByText("Hook saved")).toBeVisible();

  // The probe answers through the hook: the simulated container runs.
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Running").first()).toBeVisible();

  // A stopped-only change on the running server parks as pending (contract
  // C5): the dialog says so, and the save leaves it waiting.
  await editExperienceRate(page, "3");
  const dialog = page.getByRole("dialog", { name: "Save these changes?" });
  await expect(dialog.getByText("Read at start only")).toBeVisible();
  await expect(dialog.getByText(/the change waits as pending/)).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("These files are written when the server is stopped next."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "1 pending change" }),
  ).toBeVisible();

  // The pending list offers the stop; the simulated hook writes the change.
  await page.goto("/servers/palworld-home/history");
  await expect(page.getByText("Waiting for the server to stop")).toBeVisible();
  await expect(page.getByText("Experience rate: 1 → 3")).toBeVisible();
  await page.getByRole("button", { name: "Stop the server now" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Stop the server now?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Stop the server" }).click();
  await expect(page.getByText("1 pending change was written.")).toBeVisible();
  await expect(page.getByText("Waiting for the server to stop")).toHaveCount(0);
  expect(sim.verbs).toContain("stop");
  await expect(page.getByText("Stopped").first()).toBeVisible();
});

test("save and restart stops, writes and starts the game again, simulated", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);

  // The start hook brings the simulated container back up.
  await page.goto("/servers/palworld-home/hooks");
  await expect(page.getByText("Stopped").first()).toBeVisible();
  await page.getByRole("button", { name: "Run start" }).click();
  const startConfirm = page.getByRole("alertdialog", {
    name: "Run the start hook?",
  });
  await expect(startConfirm).toBeVisible();
  await startConfirm.getByRole("button", { name: "Run start" }).click();
  await expect(page.getByText("Start ran")).toBeVisible();
  await expect(page.getByText("Running").first()).toBeVisible();

  // The keyboard picks Save and restart in the dialog's radio group.
  await editExperienceRate(page, "2");
  const dialog = page.getByRole("dialog", { name: "Save these changes?" });
  await expect(dialog.getByText("Read at start only")).toBeVisible();
  const saveOnly = dialog.getByRole("radio", { name: /Save only/ });
  await saveOnly.focus();
  await page.keyboard.press("ArrowDown");
  const saveAndRestart = dialog.getByRole("radio", {
    name: /Save and restart/,
  });
  await expect(saveAndRestart).toBeChecked();
  await expect(
    dialog.getByText(
      "Stops the server, writes the files, then starts it again.",
    ),
  ).toBeVisible();
  const apply = dialog.getByRole("button", { name: "Save and restart" });
  await apply.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("The files hold the new values and the restart hook ran."),
  ).toBeVisible();

  // The simulated proxy saw the full stop, write and start cycle.
  expect(sim.verbs.slice(-2)).toEqual(["stop", "start"]);
  await expect(page.getByText("Running").first()).toBeVisible();
});

test("the Activity page renders the fleet in words and pages onwards", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);

  // Enough applies to page: with the simulated container down the server
  // writes every change at once (an unknown or stopped server never parks).
  sim.running = false;
  const session = (await (
    await page.request.get("/api/v1/auth/session")
  ).json()) as { csrfToken: string };
  for (let index = 0; index < 14; index += 1) {
    const value = index % 2 === 0 ? 4 : 2;
    const created = await page.request.post(
      "/api/v1/servers/palworld-home/change-sets",
      {
        headers: { "x-csrf-token": session.csrfToken },
        data: { edits: [{ settingKey: "ExpRate", value }] },
      },
    );
    expect(created.ok()).toBeTruthy();
    const changeSet = (await created.json()) as { id: string };
    const applied = await page.request.post(
      `/api/v1/change-sets/${changeSet.id}/apply`,
      {
        headers: { "x-csrf-token": session.csrfToken },
        data: { runHooks: "none" },
      },
    );
    expect(applied.ok()).toBeTruthy();
  }

  // The feed says what happened in plain words.
  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("First import").first()).toBeVisible();
  await expect(page.getByText("Change applied").first()).toBeVisible();
  await expect(
    page.getByText("Change saved as pending (written at the next stop)"),
  ).toBeVisible();
  await expect(
    page.getByText("The stop hook ran (dockerProxy)").first(),
  ).toBeVisible();

  // The feed pages onwards with the server's cursor.
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(
    page.getByText(/events shown · everything loaded/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // The tabs narrow the feed; the arrows move them on the keyboard.
  await page.getByRole("tab", { name: "Applies" }).click();
  await expect(page.getByText("The stop hook ran (dockerProxy)")).toHaveCount(
    0,
  );
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Failures" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByText(
      "No failed save, hook run or backup among the loaded events.",
    ),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Pending" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByText("Change saved as pending (written at the next stop)"),
  ).toBeVisible();
  await expect(
    page.getByText("1 event shown · everything loaded"),
  ).toBeVisible();
});

test("the launch page shows the source, the live line and the snippets", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto("/servers/palworld-home/launch");
  await expect(
    page.getByRole("heading", { name: "Palworld Home launch" }),
  ).toBeVisible();
  await expect(page.getByText("App-managed args file").first()).toBeVisible();
  await expect(page.getByLabel("Launch line")).toBeVisible();

  // The snippets: bash first, the arrows move them, copy answers.
  await page.getByRole("tab", { name: "Bash" }).click();
  await expect(page.getByLabel("Bash snippet")).toContainText(
    "dialwarden-args.txt",
  );
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "PowerShell" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("PowerShell snippet")).toContainText(
    "Get-Content dialwarden-args.txt -Raw",
  );
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  // One flag changes the line live and saves through the same dialog.
  await page.getByLabel("Player slots (-players)").fill("16");
  await expect(page.getByText("1 flag changed")).toBeVisible();
  await page.getByRole("button", { name: "Review and save" }).click();
  const dialog = page.getByRole("dialog", { name: "Save these changes?" });
  await expect(dialog.getByText("Read at start only")).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("The files hold the new values.")).toBeVisible();
  await expect(page.getByLabel("Launch line")).toContainText("-players=16");
});
