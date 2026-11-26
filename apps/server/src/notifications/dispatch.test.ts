// The notification dispatch seam (dev-work-plan P9-A step 8): a subscriber
// names the C6 activity types it wants and receives each new row of those
// types after the action that recorded it. A subscriber that fails is
// logged by name only and never stops the others; on Free nothing is handed
// to any subscriber. P9-B builds its channels on this interface.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupOwner } from "../../test/helpers.js";
import { paidApp, toFree, toPaid } from "../../test/team.js";
import type { TestApp } from "../../test/helpers.js";
import type { ActivityEvent } from "../activity/service.js";
import type { NotificationSubscriber } from "./dispatch.js";

let current: TestApp;

beforeEach(async () => {
  current = await paidApp();
});

afterEach(async () => {
  await current.close();
});

function collector(
  types: NotificationSubscriber["types"],
  name = "test",
): NotificationSubscriber & { seen: ActivityEvent[] } {
  const seen: ActivityEvent[] = [];
  return {
    name,
    types,
    seen,
    deliver: async (event) => {
      seen.push(event);
    },
  };
}

describe("notification dispatch", () => {
  it("hands each subscriber the C6 rows of its types", async () => {
    const { app } = current;
    const drift = collector(["drift.detected", "schedule.run"]);
    const backups = collector(["backup.done"]);
    app.ctx.notifications.register(drift);
    app.ctx.notifications.register(backups);
    expect(app.ctx.notifications.subscribers).toHaveLength(2);

    const recorded = app.ctx.activity.record("schedule.run", {
      serverId: "demo-a",
      data: { scheduleId: "s-1", result: "applied" },
    });
    app.ctx.activity.record("change.applied", { serverId: "demo-a" });
    await app.ctx.notifications.idle();

    expect(drift.seen).toEqual([recorded]);
    expect(drift.seen[0]).toMatchObject({
      id: expect.any(Number),
      type: "schedule.run",
      serverId: "demo-a",
      at: expect.any(String),
      actor: "system",
      data: { scheduleId: "s-1", result: "applied" },
    });
    expect(backups.seen).toEqual([]);
  });

  it("delivers after record() returns and survives a failing channel", async () => {
    const { app } = current;
    const order: string[] = [];
    app.ctx.notifications.register({
      name: "broken",
      types: ["drift.detected"],
      deliver: async () => {
        order.push("broken");
        throw new Error("https://hooks.example/secret-webhook-token");
      },
    });
    const good = collector(["drift.detected"], "good");
    app.ctx.notifications.register(good);
    app.ctx.activity.record("drift.detected", { serverId: "demo-a" });
    order.push("recorded");
    await app.ctx.notifications.idle();
    expect(order).toEqual(["recorded", "broken"]);
    expect(good.seen).toHaveLength(1);
  });

  it("removes a subscriber again", async () => {
    const { app } = current;
    const sub = collector(["backup.done"]);
    const remove = app.ctx.notifications.register(sub);
    remove();
    app.ctx.activity.record("backup.done");
    await app.ctx.notifications.idle();
    expect(sub.seen).toEqual([]);
  });

  it("hands nothing to any subscriber on Free, and none later", async () => {
    const { app } = current;
    const owner = await setupOwner(app);
    const sub = collector(["licence.changed", "backup.done"]);
    app.ctx.notifications.register(sub);
    await toFree(app, owner);
    await app.ctx.notifications.idle();
    sub.seen.length = 0;
    app.ctx.activity.record("backup.done");
    await app.ctx.notifications.idle();
    expect(sub.seen).toEqual([]);
    await toPaid(app, owner);
    await app.ctx.notifications.idle();
    const types = sub.seen.map((event) => event.type);
    expect(types).not.toContain("backup.done");
    app.ctx.activity.record("backup.done");
    await app.ctx.notifications.idle();
    expect(sub.seen.map((event) => event.type)).toContain("backup.done");
  });
});
