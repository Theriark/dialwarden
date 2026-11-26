// Change reports (dev-work-plan P9-A step 6, Paid feature reports): the
// Markdown, Discord and HTML print renderers against snapshots of a fixed
// report, and the API on a fake clock: selected change sets or a date range,
// grouped by server, only the servers the caller may read, chips as text,
// and secrets redacted in every format.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiOf, change } from "../../test/servers.js";
import {
  call,
  INT_SETTING,
  teamFixture,
  toFree,
  type TeamFixture,
} from "../../test/team.js";
import type { Chip } from "../changes/types.js";
import {
  chipText,
  DISCORD_LIMIT,
  reportDiscord,
  reportHtml,
  reportMarkdown,
  type Report,
} from "./service.js";

const chip = (over: Partial<Chip>): Chip => ({
  kind: "changed",
  fileId: "settings",
  settingKey: "ServerPlayerMaxNum",
  label: "Max players",
  from: 32,
  to: 20,
  restartRequired: true,
  ...over,
});

const REPORT: Report = {
  generatedAt: "2026-12-01T12:00:00.000Z",
  from: "2026-12-01T00:00:00.000Z",
  to: "2026-12-01T23:59:59.000Z",
  servers: [
    {
      id: "pal-main",
      name: "Pal <main> *one*",
      game: "Palworld",
      entries: [
        {
          changeSetId: "11111111-1111-4111-8111-111111111111",
          at: "2026-12-01T10:15:00.000Z",
          author: "Ana @everyone",
          cause: "schedule",
          status: "applied",
          chips: [
            chipText(chip({}), false),
            chipText(
              chip({
                settingKey: "AdminPassword",
                label: "Admin password",
                from: "old",
                to: "new",
              }),
              true,
            ),
          ],
        },
        {
          changeSetId: "22222222-2222-4222-8222-222222222222",
          at: "2026-12-01T09:00:00.000Z",
          author: "outside the app",
          cause: "external",
          status: "applied",
          chips: [
            chipText(
              chip({
                kind: "external",
                settingKey: null,
                label: "Settings file",
                from: null,
                to: "3 lines",
              }),
              false,
            ),
          ],
        },
      ],
    },
    {
      id: "valheim-1",
      name: "Valheim",
      game: "Valheim",
      entries: [
        {
          changeSetId: "33333333-3333-4333-8333-333333333333",
          at: "2026-12-01T08:00:00.000Z",
          author: "Owner",
          cause: "preset",
          status: "pending",
          chips: [
            chipText(
              chip({
                kind: "added",
                label: "Public",
                from: null,
                to: true,
                restartRequired: false,
              }),
              false,
            ),
            chipText(
              chip({
                label: "Message of the day",
                from: "hi",
                to: "@everyone hello",
                restartRequired: false,
              }),
              false,
            ),
          ],
        },
      ],
    },
  ],
  entryCount: 3,
  truncated: false,
};

const EMPTY: Report = {
  generatedAt: "2026-12-01T12:00:00.000Z",
  from: null,
  to: null,
  servers: [],
  entryCount: 0,
  truncated: false,
};

describe("report renderers", () => {
  it("writes chips as text and never a secret's values", () => {
    expect(chipText(chip({}), false)).toBe(
      "Max players: 32 to 20 (restart required)",
    );
    const secret = chipText(chip({ from: "old-pass", to: "new-pass" }), true);
    expect(secret).toBe(
      "Max players: changed (secret, hidden) (restart required)",
    );
    const masked = chipText(
      chip({ kind: "masked", restartRequired: false }),
      false,
    );
    expect(masked).toBe("Max players: changed (secret, hidden)");
    expect(
      chipText(chip({ kind: "removed", restartRequired: false }), false),
    ).toBe("Max players: removed (was 32)");
  });

  it("renders Markdown", () => {
    expect(reportMarkdown(REPORT)).toMatchSnapshot();
    expect(reportMarkdown(EMPTY)).toMatchSnapshot();
  });

  it("renders a Discord message body that pings nobody", () => {
    const body = reportDiscord(REPORT);
    // The zero-width space after each @, shown as a marker in the snapshot.
    const zwsp = String.fromCodePoint(0x200b);
    expect(body.content.replaceAll(zwsp, "<zwsp>")).toMatchSnapshot();
    expect(body.content).toContain(`@${zwsp}everyone hello`);
    expect(body.content).not.toMatch(/@everyone/);
    expect(reportDiscord(EMPTY)).toMatchSnapshot();
  });

  it("keeps a long Discord body under the limit and counts the rest", () => {
    const entry = REPORT.servers[0]?.entries[0];
    if (entry === undefined) throw new Error("fixture");
    const many: Report = {
      ...REPORT,
      servers: [
        {
          id: "big",
          name: "Big",
          game: "Palworld",
          entries: Array.from({ length: 120 }, () => entry),
        },
      ],
      entryCount: 120,
    };
    const { content } = reportDiscord(many);
    expect(content.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(content).toMatch(/\.\.\. and \d+ more change sets\.$/);
  });

  it("renders an HTML print view without script", () => {
    const page = reportHtml(REPORT);
    expect(page).toMatchSnapshot();
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain("Pal &lt;main&gt; *one*");
    expect(reportHtml(EMPTY)).toContain("<p>No changes.</p>");
  });
});

describe("the reports API", () => {
  const START = Date.parse("2026-12-01T10:00:00.000Z");
  let clock = START;
  let t: TeamFixture;

  beforeEach(async () => {
    clock = START;
    t = await teamFixture({ now: () => new Date(clock) });
  });

  afterEach(async () => {
    await t.current.close();
  });

  interface ReportBody extends Report {
    markdown: string;
    discord: { content: string };
  }

  async function report(query: string, who: typeof t.owner = t.owner) {
    const response = await call(
      t.app,
      who,
      "GET",
      `/api/v1/reports/changes?${query}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ReportBody>();
  }

  it("reports a date range per server with secrets redacted", async () => {
    const api = apiOf(t.app, t.owner);
    clock = START + 60_000;
    const first = await change(api, t.servers.a, { [INT_SETTING]: 20 });
    clock = START + 120_000;
    await change(api, t.servers.a, { AdminPassword: "report-secret-pass" });
    clock = START + 180_000;
    await change(api, t.servers.b, { [INT_SETTING]: 21 });
    clock = START + 3_600_000;

    const range = new URLSearchParams({
      from: new Date(START + 30_000).toISOString(),
      to: new Date(START + 600_000).toISOString(),
    }).toString();
    const body = await report(range);
    expect(body.servers.map((server) => server.id)).toEqual([
      t.servers.a,
      t.servers.b,
    ]);
    expect(body.entryCount).toBe(3);
    const onA = body.servers[0]?.entries ?? [];
    expect(onA.map((entry) => entry.changeSetId)[1]).toBe(first.id);
    expect(onA[1]?.chips).toEqual([
      "Player slots: 32 to 20 (restart required)",
    ]);
    expect(onA[0]?.chips.join(" ")).toContain("(secret, hidden)");
    for (const text of [
      JSON.stringify(body),
      body.markdown,
      body.discord.content,
    ]) {
      expect(text).not.toContain("report-secret-pass");
    }
    const page = await call(
      t.app,
      t.owner,
      "GET",
      `/api/v1/reports/changes/print?${range}`,
    );
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.body).not.toContain("report-secret-pass");
    expect(page.body).not.toMatch(/<script/i);

    // Selected change sets only.
    const picked = await report(`changeSets=${first.id}`);
    expect(picked.entryCount).toBe(1);
    expect(picked.servers[0]?.entries[0]?.changeSetId).toBe(first.id);
  });

  it("holds only the servers the caller may read", async () => {
    const api = apiOf(t.app, t.owner);
    await change(api, t.servers.a, { [INT_SETTING]: 22 });
    const onB = await change(api, t.servers.b, { [INT_SETTING]: 23 });
    const editor = await report("", t.editor);
    expect(editor.servers.map((server) => server.id)).toEqual([t.servers.a]);
    const asked = await report(`changeSets=${onB.id}`, t.editor);
    expect(asked.servers).toEqual([]);
    expect(asked.markdown).toContain("No changes.");
    const loner = await report("", t.loner);
    expect(loner.entryCount).toBe(0);
  });

  it("answers 402 on Free", async () => {
    await toFree(t.app, t.owner);
    const response = await call(
      t.app,
      t.owner,
      "GET",
      "/api/v1/reports/changes",
    );
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ feature: "reports" });
  });
});
