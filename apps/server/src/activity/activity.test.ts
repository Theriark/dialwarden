// GET /api/v1/activity (contract C6): newest first, the exact event fields,
// paging with before=, and the type filter.
import { afterEach, describe, expect, it } from "vitest";
import {
  headersOf,
  setupOwner,
  testApp,
  type TestApp,
} from "../../test/helpers.js";

interface Page {
  items: { id: number; type: string; data: Record<string, unknown> }[];
  nextBefore: number | null;
}

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe("activity API (C6)", () => {
  it("pages newest first with the contract fields", async () => {
    current = await testApp();
    const { app } = current;
    const owner = await setupOwner(app);
    app.ctx.activity.record("backup.done", { data: { id: "20261121-0330" } });
    app.ctx.activity.record("licence.changed", {
      actor: owner.email,
      data: { action: "set" },
    });
    const get = (url: string) =>
      app.inject({ method: "GET", url, headers: headersOf(owner) });

    const first = await get("/api/v1/activity?limit=2");
    expect(first.statusCode).toBe(200);
    const page = first.json<Page>();
    expect(page.items.map((e) => e.type)).toEqual([
      "licence.changed",
      "backup.done",
    ]);
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual([
      "actor",
      "at",
      "data",
      "id",
      "serverId",
      "type",
    ]);
    expect(page.items[0]).toMatchObject({
      actor: owner.email,
      serverId: null,
      data: { action: "set" },
    });
    expect(page.nextBefore).not.toBeNull();

    const older = await get(
      `/api/v1/activity?limit=2&before=${String(page.nextBefore)}`,
    );
    const rest = older.json<Page>();
    expect(rest.items.map((e) => e.type)).toEqual(["user.changed"]);
    expect(rest.nextBefore).toBeNull();

    const filtered = await get("/api/v1/activity?type=backup.done");
    const backups = filtered.json<Page>();
    expect(backups.items).toHaveLength(1);
    expect(backups.items[0]?.data).toEqual({ id: "20261121-0330" });

    const unknownType = await get("/api/v1/activity?type=nothing.here");
    expect(unknownType.statusCode).toBe(400);
  });

  it("needs a session", async () => {
    current = await testApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/api/v1/activity",
    });
    expect(res.statusCode).toBe(401);
  });
});
