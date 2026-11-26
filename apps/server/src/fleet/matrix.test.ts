// The comparison matrix (dev-work-plan P9-A step 5, Paid feature
// fleet.matrix): the settings of one game by its servers, the rows whose
// values differ flagged, filtered by settings group and by servers. Only the
// servers the caller may read are columns; secrets stay masked and a secret
// row never says whether two servers share a value. Tested with many
// servers, one server and none.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addServer,
  apiOf,
  change,
  palworldFolder,
} from "../../test/servers.js";
import {
  call,
  INT_SETTING,
  teamFixture,
  toFree,
  type TeamFixture,
} from "../../test/team.js";

interface MatrixBody {
  packId: string;
  groups: string[];
  group: string | null;
  servers: {
    id: string;
    name: string;
    editable: boolean;
    error: string | null;
  }[];
  rows: {
    key: string;
    group: string | null;
    secret: boolean;
    values: Record<string, unknown>;
    differs: boolean;
  }[];
  differing: number;
}

let t: TeamFixture;

beforeEach(async () => {
  t = await teamFixture();
});

afterEach(async () => {
  await t.current.close();
});

async function matrix(
  query: string,
  who: typeof t.owner = t.owner,
): Promise<MatrixBody> {
  const response = await call(
    t.app,
    who,
    "GET",
    `/api/v1/fleet/matrix?${query}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<MatrixBody>();
}

const rowOf = (body: MatrixBody, key: string) =>
  body.rows.find((row) => row.key === key);

describe("the comparison matrix", () => {
  it("compares many servers of one game and flags what differs", async () => {
    const api = apiOf(t.app, t.owner);
    const more: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const root = await palworldFolder(t.base, `more-${String(index)}`);
      more.push(await addServer(api, `more-${String(index)}`, root));
    }
    await change(api, t.servers.b, { [INT_SETTING]: 20 });
    await change(api, t.servers.a, { AdminPassword: "first-secret-value" });

    const body = await matrix("game=palworld");
    expect(body.packId).toBe("palworld");
    expect(body.servers.map((server) => server.id)).toEqual([
      t.servers.a,
      t.servers.b,
      ...more,
    ]);
    expect(body.servers.every((server) => server.error === null)).toBe(true);
    const players = rowOf(body, INT_SETTING);
    expect(players?.differs).toBe(true);
    expect(players?.values[t.servers.a]).toBe(32);
    expect(players?.values[t.servers.b]).toBe(20);
    expect(rowOf(body, "ServerName")?.differs).toBe(false);
    // A secret is masked and never flagged, even when the values differ.
    const secret = rowOf(body, "AdminPassword");
    expect(secret).toMatchObject({ secret: true, differs: false });
    expect(JSON.stringify(body)).not.toContain("first-secret-value");
    expect(body.differing).toBe(body.rows.filter((row) => row.differs).length);
    expect(body.differing).toBeGreaterThanOrEqual(1);
  });

  it("filters by settings group and by servers", async () => {
    const body = await matrix("game=palworld&group=Network");
    expect(body.group).toBe("Network");
    expect(body.groups).toContain("Network");
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((row) => row.group === "Network")).toBe(true);

    // One server: nothing can differ.
    const one = await matrix(`game=palworld&servers=${t.servers.a}`);
    expect(one.servers.map((server) => server.id)).toEqual([t.servers.a]);
    expect(one.differing).toBe(0);

    const unknown = await call(
      t.app,
      t.owner,
      "GET",
      "/api/v1/fleet/matrix?game=palworld&group=Nowhere",
    );
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: "unknown_group" });
  });

  it("answers a game without servers with no columns", async () => {
    const body = await matrix("game=rust");
    expect(body.servers).toEqual([]);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((row) => Object.keys(row.values).length === 0)).toBe(
      true,
    );
    expect(body.differing).toBe(0);
  });

  it("shows only the servers the caller may read", async () => {
    const editor = await matrix("game=palworld", t.editor);
    expect(editor.servers.map((server) => server.id)).toEqual([t.servers.a]);
    const viewer = await matrix("game=palworld", t.viewer);
    expect(viewer.servers.map((server) => server.id)).toEqual([t.servers.a]);
    // Asking for an ungranted server by name changes nothing.
    const asked = await matrix(
      `game=palworld&servers=${t.servers.b}`,
      t.editor,
    );
    expect(asked.servers).toEqual([]);
    const loner = await matrix("game=palworld", t.loner);
    expect(loner.servers).toEqual([]);
  });

  it("answers 402 on Free", async () => {
    await toFree(t.app, t.owner);
    const response = await call(
      t.app,
      t.owner,
      "GET",
      "/api/v1/fleet/matrix?game=palworld",
    );
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ feature: "fleet.matrix" });
  });
});
