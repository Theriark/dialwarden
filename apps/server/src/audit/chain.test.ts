// The hash-chained audit log (dev-work-plan P8-A step 3; p8-threat-specs
// C-01 to C-12). The tamper steps write to the database directly, as an
// attacker with write access to /data would.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { auditActors, auditEvents } from "../db/schema.js";
import type { TestApp } from "../../test/helpers.js";
import { call, teamFixture, type TeamFixture } from "../../test/team.js";
import { GENESIS } from "./service.js";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function fixture(): Promise<TeamFixture> {
  const made = await teamFixture();
  current = made.current;
  return made;
}

type AuditRow = typeof auditEvents.$inferSelect;

function rowsOf(t: TeamFixture): AuditRow[] {
  return t.app.ctx.store.db.select().from(auditEvents).all();
}

/** The hashed columns of a row as text: every column but the address. */
function hashedText(row: AuditRow): string {
  const copy: Partial<AuditRow> = { ...row };
  delete copy.ip;
  return JSON.stringify(copy);
}

/** More audit rows, made by real requests of the owner. */
async function actions(t: TeamFixture, count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const name = `Owner ${String(n)}`;
    await call(t.app, t.owner, "PATCH", "/api/v1/auth/profile", { name });
  }
}

function sql(t: TeamFixture, text: string, ...values: unknown[]): void {
  t.app.ctx.store.sqlite.prepare(text).run(...values);
}

async function verify(t: TeamFixture) {
  const response = await call(t.app, t.owner, "GET", "/api/v1/audit/verify");
  expect(response.statusCode).toBe(200);
  return response.json<Record<string, unknown>>();
}

const CHANGES = [
  `UPDATE audit_events SET data = '{"role":"owner"}' WHERE id = 7`,
  "UPDATE audit_events SET actor_id = 'someone-else' WHERE id = 7",
  "UPDATE audit_events SET action = 'nothing' WHERE id = 7",
  "UPDATE audit_events SET at = '2000-01-01T00:00:00.000Z' WHERE id = 7",
];

const SWAP =
  "UPDATE audit_events SET at = ?, actor_id = ?, action = ?, data = ?, " +
  "prev_hash = ?, hash = ? WHERE id = ?";

describe("audit chain (C-01 to C-12)", () => {
  it("C-01 verifies a chain of real actions", async () => {
    const t = await fixture();
    await actions(t, 20);
    const answer = await verify(t);
    expect(answer).toMatchObject({ valid: true });
    expect(answer.count).toBeGreaterThanOrEqual(20);
  });

  it("C-02 finds a changed row, whichever hashed column changed", async () => {
    for (const change of CHANGES) {
      const t = await fixture();
      await actions(t, 3);
      sql(t, change);
      expect(await verify(t)).toMatchObject({
        valid: false,
        firstBrokenId: 7,
      });
      await t.current.close();
      current = undefined;
    }
  });

  it("C-03 finds a deleted row", async () => {
    const t = await fixture();
    await actions(t, 3);
    sql(t, "DELETE FROM audit_events WHERE id = 7");
    expect(await verify(t)).toMatchObject({ valid: false, firstBrokenId: 8 });
  });

  it("C-04 finds two rows swapped", async () => {
    const t = await fixture();
    await actions(t, 3);
    const seven = rowsOf(t).find((row) => row.id === 7);
    const eight = rowsOf(t).find((row) => row.id === 8);
    if (seven === undefined || eight === undefined) throw new Error("rows");
    const swap = (target: number, from: typeof seven) => {
      const values = [from.at, from.actorId, from.action, from.data];
      sql(t, SWAP, ...values, from.prevHash, from.hash, target);
    };
    swap(7, eight);
    swap(8, seven);
    expect(await verify(t)).toMatchObject({ valid: false, firstBrokenId: 7 });
  });

  it("C-05 finds a chain recomputed with plain SHA-256", async () => {
    const t = await fixture();
    await actions(t, 3);
    sql(t, "UPDATE audit_events SET action = 'forged' WHERE id = 7");
    let prev = rowsOf(t).find((row) => row.id === 6)?.hash ?? GENESIS;
    for (const row of rowsOf(t).filter((item) => item.id >= 7)) {
      const fields = [
        row.id,
        row.at,
        row.actorId,
        row.action,
        row.targetType,
        row.targetId,
        row.serverId,
        row.data,
        prev,
      ];
      const text = JSON.stringify(fields);
      const hash = createHash("sha256").update(text).digest("hex");
      const update = "UPDATE audit_events SET prev_hash = ?, hash = ?";
      sql(t, `${update} WHERE id = ?`, prev, hash, row.id);
      prev = hash;
    }
    expect(await verify(t)).toMatchObject({ valid: false, firstBrokenId: 7 });
  });

  it("C-06 finds the newest rows deleted", async () => {
    const t = await fixture();
    await actions(t, 3);
    const last = Math.max(...rowsOf(t).map((row) => row.id));
    sql(t, "DELETE FROM audit_events WHERE id > ?", last - 3);
    expect(await verify(t)).toMatchObject({
      valid: false,
      reason: "head_mismatch",
    });
  });

  it("C-06 still finds the newest rows deleted after the next record", async () => {
    const t = await fixture();
    await actions(t, 3);
    const last = Math.max(...rowsOf(t).map((row) => row.id));
    sql(t, "DELETE FROM audit_events WHERE id > ?", last - 3);
    await actions(t, 1);
    const ids = rowsOf(t).map((row) => row.id);
    expect(Math.max(...ids)).toBeGreaterThan(last);
    expect(await verify(t)).toMatchObject({ valid: false, reason: "gap" });
  });

  it("C-06 still finds every row deleted after the next record", async () => {
    const t = await fixture();
    await actions(t, 3);
    sql(t, "DELETE FROM audit_events");
    await actions(t, 1);
    expect(await verify(t)).toMatchObject({ valid: false, reason: "gap" });
  });

  it("C-06 keeps a removed head anchor visible after the next record", async () => {
    const t = await fixture();
    await actions(t, 3);
    sql(t, "DELETE FROM settings WHERE key = 'audit.head'");
    await actions(t, 2);
    expect(await verify(t)).toMatchObject({
      valid: false,
      reason: "head_mismatch",
    });
  });

  it("C-07 keeps the chain through an anonymisation and a deletion", async () => {
    for (const erase of ["anonymise", "delete"] as const) {
      const t = await fixture();
      for (let n = 0; n < 5; n += 1) {
        const name = `Editor ${String(n)}`;
        await call(t.app, t.editor, "PATCH", "/api/v1/auth/profile", { name });
      }
      const hashed = () => rowsOf(t).map(hashedText);
      const before = hashed();
      const url = `/api/v1/users/${t.editor.userId}`;
      const done =
        erase === "anonymise"
          ? await call(t.app, t.owner, "POST", `${url}/anonymise`)
          : await call(t.app, t.owner, "DELETE", url);
      expect(done.statusCode).toBeLessThan(300);
      expect(hashed().slice(0, before.length)).toEqual(before);
      expect(await verify(t)).toMatchObject({ valid: true });
      const query = `/api/v1/audit?actorId=${t.editor.userId}`;
      const list = await call(t.app, t.owner, "GET", query);
      const items = list.json<{ items: { actor: { label: string } }[] }>();
      expect(items.items.length).toBeGreaterThanOrEqual(5);
      for (const item of items.items) {
        expect(item.actor.label).toMatch(/^Erased user [0-9a-f]{4}$/);
      }
      await t.current.close();
      current = undefined;
    }
  });

  it("C-08 keeps names and e-mail addresses out of the hashed columns", async () => {
    const t = await fixture();
    await actions(t, 3);
    const people = [t.owner, t.admin, t.editor, t.viewer, t.loner];
    const hashed = rowsOf(t).map(hashedText).join("\n");
    for (const person of people) {
      expect(hashed).not.toContain(person.email);
    }
    expect(hashed).not.toContain("Owner 0");
    const actors = t.app.ctx.store.db.select().from(auditActors).all();
    expect(actors.map((actor) => actor.label)).toContain(t.owner.email);
  });

  it("C-09 has no route that changes or removes audit rows", async () => {
    const t = await fixture();
    const writes = t.app.ctx.routes.filter(
      (route) =>
        route.url.startsWith("/api/v1/audit") &&
        ["PUT", "PATCH", "DELETE", "POST"].includes(route.method),
    );
    expect(writes).toEqual([]);
    const removed = await call(t.app, t.owner, "DELETE", "/api/v1/audit/7");
    expect(removed.statusCode).toBe(404);
  });

  it("C-10 stays verifiable after retention, from the checkpoint", async () => {
    let now = new Date("2026-12-01T10:00:00Z");
    const t = await teamFixture({ now: () => now });
    current = t.current;
    const old = rowsOf(t).length;
    now = new Date(now.getTime() + 60_000);
    await actions(t, 20);
    const removed = t.app.ctx.audit.pruneBefore(now.toISOString());
    expect(removed).toBe(old);
    expect(await verify(t)).toMatchObject({ valid: true });
    const oldest = rowsOf(t).at(0)?.id ?? 0;
    expect(oldest).toBe(old + 1);
    sql(t, "UPDATE audit_events SET action = 'x' WHERE id = ?", oldest);
    expect(await verify(t)).toMatchObject({
      valid: false,
      firstBrokenId: oldest,
    });
  });

  it("C-11 keeps the chain whole under parallel actions", async () => {
    const t = await fixture();
    await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        call(t.app, t.owner, "PATCH", "/api/v1/auth/profile", {
          name: `Parallel ${String(n)}`,
        }),
      ),
    );
    expect(await verify(t)).toMatchObject({ valid: true });
    const previous = rowsOf(t).map((row) => row.prevHash);
    expect(new Set(previous).size).toBe(previous.length);
  });

  it("C-12 lets only the owner and admins read the log", async () => {
    const t = await fixture();
    const urls = [
      "/api/v1/audit",
      "/api/v1/audit/verify",
      "/api/v1/audit/export.csv",
    ];
    for (const url of urls) {
      for (const user of [t.editor, t.viewer]) {
        expect((await call(t.app, user, "GET", url)).statusCode).toBe(403);
      }
      for (const user of [t.admin, t.owner]) {
        expect((await call(t.app, user, "GET", url)).statusCode).toBe(200);
      }
    }
  });
});
