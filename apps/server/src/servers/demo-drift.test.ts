// The demo drift job (P10 correction, Risks 20; DEMO ONLY): with DEMO_SEED
// it changes one comment line of the demo Rust server's server.cfg and
// records it as an outside edit with the note demo simulation; the owner can
// run it once at once. Without DEMO_SEED it is off: the run-now route
// answers 404 and nothing is touched.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupOwner, tempDir, type TestApp } from "../../test/helpers.js";
import { activityOf, apiOf, fileText, history } from "../../test/servers.js";
import { paidApp } from "../../test/team.js";
import {
  DEMO_DRIFT_MARKER,
  DEMO_DRIFT_NOTE,
  DEMO_DRIFT_SERVER,
  withDemoLine,
} from "./demo-drift.js";

const CFG = "server/rustserver/cfg/server.cfg";
const RUN = "/api/v1/system/demo-drift/run";

let current: TestApp | undefined;
let demoDir: string | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
  if (demoDir !== undefined)
    await rm(demoDir, { recursive: true, force: true });
  demoDir = undefined;
});

describe("withDemoLine", () => {
  it("puts the line after the leading comments, then replaces it", () => {
    const text = "# one\n# two\nserver.pve false\n";
    const first = withDemoLine(text, `${DEMO_DRIFT_MARKER} a`);
    expect(first).toBe(
      `# one\n# two\n${DEMO_DRIFT_MARKER} a\nserver.pve false\n`,
    );
    const second = withDemoLine(first, `${DEMO_DRIFT_MARKER} b`);
    expect(second).toBe(
      `# one\n# two\n${DEMO_DRIFT_MARKER} b\nserver.pve false\n`,
    );
  });
});

describe("the demo drift job", () => {
  it("is off without DEMO_SEED", async () => {
    current = await paidApp();
    const owner = await setupOwner(current.app);
    expect(current.app.ctx.demoDrift.enabled).toBe(false);
    const response = await apiOf(current.app, owner).post(RUN);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "demo_seed_off" });
  });

  it("changes one comment line and records a simulated outside edit", async () => {
    const dir = await tempDir("dialwarden-demo-drift-");
    demoDir = dir;
    current = await paidApp({
      extraEnv: { DEMO_SEED: "true", DEMO_SERVERS_DIR: dir },
    });
    const { app } = current;
    const owner = await setupOwner(app);
    const api = apiOf(app, owner);
    const root = join(dir, "rust");
    const before = await fileText(root, CFG);

    const response = await api.post(RUN);
    expect(response.statusCode).toBe(200);
    const result = response.json<{
      serverId: string;
      changeSetId: string | null;
      line: string;
    }>();
    expect(result.serverId).toBe(DEMO_DRIFT_SERVER);
    expect(result.line.startsWith(DEMO_DRIFT_MARKER)).toBe(true);

    // Only the marker line is new; every other line is as it was.
    const after = await fileText(root, CFG);
    const added = after.split("\n").filter((line) => !before.includes(line));
    expect(added).toEqual([result.line]);
    expect(after.replace(`${result.line}\n`, "")).toBe(before);

    const entry = (await history(api, DEMO_DRIFT_SERVER)).entries.find(
      (item) => item.changeSetId === result.changeSetId,
    );
    expect(entry).toMatchObject({
      cause: "external",
      author: `outside the app (${DEMO_DRIFT_NOTE})`,
    });
    const events = (await activityOf(api, DEMO_DRIFT_SERVER)).filter(
      (row) => row.type === "drift.detected",
    );
    expect(events.at(-1)?.data).toMatchObject({
      changeSetId: result.changeSetId,
      via: "demo",
      note: DEMO_DRIFT_NOTE,
    });

    // A second run replaces the same line: still one marker line.
    const again = await api.post(RUN);
    expect(again.statusCode).toBe(200);
    const text = await fileText(root, CFG);
    const markers = text
      .split("\n")
      .filter((line) => line.startsWith(DEMO_DRIFT_MARKER));
    expect(markers).toHaveLength(1);
  });
});
