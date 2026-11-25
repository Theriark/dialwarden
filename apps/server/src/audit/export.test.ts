// The CSV export of the audit log (dev-work-plan P8-A step 3;
// p8-threat-specs X-01 and X-02): formula cells are neutralised, every cell
// is quoted, and the export holds no secret, token or invitation value.
import { afterEach, describe, expect, it } from "vitest";
import type { TestApp } from "../../test/helpers.js";
import {
  call,
  INT_SETTING,
  invite,
  teamFixture,
  testEmail,
} from "../../test/team.js";
import { auditCsv, csvCell } from "./csv.js";

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

const PAYLOADS = [
  '=HYPERLINK("http://evil.example","x")',
  "+SUM(1+1)",
  "-2+3",
  "@SUM(1+1)",
  "\t=1",
  "\r=1",
];

/** A strict RFC 4180 reader: quoted cells only, doubled inner quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) !== '"') throw new Error(`unquoted cell at ${i}`);
    let cell = "";
    i += 1;
    for (;;) {
      const char = text.charAt(i);
      if (char === "") throw new Error("unterminated cell");
      if (char === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i += 2;
      } else if (char === '"') {
        i += 1;
        break;
      } else {
        cell += char;
        i += 1;
      }
    }
    row.push(cell);
    if (text.charAt(i) === ",") {
      i += 1;
    } else if (text.startsWith("\r\n", i)) {
      rows.push(row);
      row = [];
      i += 2;
    } else {
      throw new Error(`unexpected text at ${i}`);
    }
  }
  return rows;
}

describe("audit CSV export (X-01, X-02)", () => {
  it("X-01 neutralises formula cells and quotes every cell", async () => {
    for (const payload of PAYLOADS) {
      expect(csvCell(payload).startsWith(`"'`)).toBe(true);
    }
    const t = await teamFixture();
    current = t.current;
    for (const payload of PAYLOADS) {
      t.app.ctx.audit.record({
        actorId: payload,
        actorLabel: payload,
        action: payload,
        targetId: payload,
        data: { note: payload },
      });
    }
    const response = await call(
      t.app,
      t.owner,
      "GET",
      "/api/v1/audit/export.csv",
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["cache-control"]).toBe("no-store");
    const rows = parseCsv(response.body);
    const width = rows.at(0)?.length ?? 0;
    expect(width).toBe(10);
    for (const row of rows) {
      expect(row).toHaveLength(width);
      for (const cell of row) {
        expect(/^[=+\-@\t\r]/.test(cell)).toBe(false);
      }
    }
    for (const payload of PAYLOADS) {
      const found = rows.some((row) => row.includes(`'${payload}`));
      expect(found, JSON.stringify(payload)).toBe(true);
    }
  });

  it("X-02 keeps the IP setting, the filters and no secret values", async () => {
    const t = await teamFixture();
    current = t.current;
    const url = "/api/v1/settings/audit";
    const setting = await call(t.app, t.owner, "PUT", url, { ipMode: "none" });
    expect(setting.statusCode).toBe(200);
    const edits = [{ settingKey: INT_SETTING, value: 20 }];
    const changes = `/api/v1/servers/${t.servers.a}/change-sets`;
    const draft = await call(t.app, t.owner, "POST", changes, { edits });
    expect(draft.statusCode).toBe(201);
    const made = await invite(t.app, t.owner, {
      email: testEmail("export"),
      role: "viewer",
    });
    const token = made.json<{ token: string }>().token;
    await call(t.app, t.editor, "PATCH", "/api/v1/auth/profile", {
      name: "Secret Name",
    });
    const all = await call(t.app, t.owner, "GET", "/api/v1/audit/export.csv");
    const rows = parseCsv(all.body).slice(1);
    const newer = rows.slice(-2);
    for (const row of newer) {
      expect(row.at(8)).toBe("");
    }
    expect(all.body).not.toContain(token);
    expect(all.body).not.toContain(t.editor.password);
    expect(all.body).not.toContain("Secret Name");
    const onA = await call(
      t.app,
      t.owner,
      "GET",
      `/api/v1/audit/export.csv?serverId=${t.servers.a}`,
    );
    const filtered = parseCsv(onA.body).slice(1);
    expect(filtered.length).toBeGreaterThan(0);
    for (const row of filtered) {
      expect(row.at(7)).toBe(t.servers.a);
    }
  });

  it("writes the header and CRLF line ends", () => {
    const text = auditCsv([]);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(parseCsv(text)).toEqual([
      [
        "id",
        "at",
        "actor",
        "actor_id",
        "action",
        "target_type",
        "target_id",
        "server_id",
        "ip",
        "data",
      ],
    ]);
  });
});
