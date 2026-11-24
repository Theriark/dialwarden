// Threat test T2 (security review THE-2598, F1): the start snippets hand the
// app-managed dialwarden-args.txt to eval, so a raw patch that puts a command
// substitution in it must fail validation and leave the file untouched. Run
// on a Palworld server folder made from the pack's synthetic fixtures (its
// launch file is the same app-managed args file as Valheim's).
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setupOwner,
  tempDir,
  testApp,
  type TestApp,
} from "../../test/helpers.js";
import {
  addServer,
  apiOf,
  apply,
  fileText,
  palworldFolder,
  type ChangeSetBody,
} from "../../test/servers.js";

let current: TestApp | undefined;
let base: string;

beforeEach(async () => {
  base = await tempDir("dialwarden-args-shell-");
});

afterEach(async () => {
  await current?.close();
  current = undefined;
  await rm(base, { recursive: true, force: true });
});

const ARGS_FILE = "dialwarden-args.txt";

describe("the app-managed args file under eval", () => {
  it("refuses a raw patch that holds a command substitution", async () => {
    current = await testApp();
    const api = apiOf(current.app, await setupOwner(current.app));
    const root = await palworldFolder(base);
    const slug = await addServer(api, "Lighthouse", root);
    const before = await fileText(root, ARGS_FILE);
    const text = `${before.trimEnd()} -zz "$(touch /tmp/dw-pwn)"\n`;
    const made = (
      await api.post(`/api/v1/servers/${slug}/change-sets`, {
        patches: [{ fileId: "launch", text }],
      })
    ).json<ChangeSetBody>();
    expect(made.lint).toContainEqual(
      expect.objectContaining({
        fileId: "launch",
        code: "shell-character",
        severity: "error",
      }),
    );
    const failed = await apply(api, made.id);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "validation" },
    });
    expect(await fileText(root, ARGS_FILE)).toBe(before);
  });
});
