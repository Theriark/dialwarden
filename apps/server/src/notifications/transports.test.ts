// The webhook and Discord senders (P9-B) against a receiver in the test
// process with recorded answers (simulated; see test/http-sink.ts), with a
// fake clock and sleep: the body and headers, the HMAC signature as a
// receiver checks it, the retry of transient failures only, the Discord
// pace and its 429, and the network policy at send time (no redirect, no
// private or loopback address unless allowed).
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkUrl,
  policyOf,
  UrlRefusedError,
  type NetworkPolicy,
} from "../oidc/network.js";
import { DISCORD_LIMIT } from "../reports/service.js";
import {
  DISCORD_ANSWERS,
  startHttpSink,
  type HttpSink,
} from "../../test/http-sink.js";
import type { NotificationMessage } from "./message.js";
import { verifySignature } from "./signature.js";
import {
  DeliveryError,
  DiscordPace,
  discordBody,
  MAX_ATTEMPTS,
  sendDiscord,
  sendSmtp,
  sendWebhook,
  type SendContext,
  type WebhookBody,
} from "./transports.js";

let sink: HttpSink;
let clock: number;
let slept: number[];
let paid: boolean;

const LOOPBACK: NetworkPolicy = policyOf(false, {
  allowLoopback: true,
  allowHttp: true,
});

function context(policy: NetworkPolicy = LOOPBACK): SendContext {
  return {
    policy,
    now: () => new Date(clock),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    signal: new AbortController().signal,
    maySend: () => paid,
  };
}

const MESSAGE: NotificationMessage = {
  title: "Change applied on Alpha @everyone (Palworld)",
  byline: "By Owner, 2026-11-26 03:50 UTC",
  lines: ["Max players: 32 to 20", "Admin password: changed (secret, hidden)"],
  server: { id: "alpha", name: "Alpha @everyone", game: "Palworld" },
  actor: "Owner",
};

function body(): WebhookBody {
  return {
    version: 1,
    kind: "event",
    channel: { id: "c-1", name: "ops" },
    event: {
      id: 7,
      type: "change.applied",
      serverId: "alpha",
      at: "2026-11-26T03:50:00.000Z",
      actor: "u-1",
      data: { changeSetId: "cs-1", cause: "app" },
    },
    title: MESSAGE.title,
    text: "Change applied",
    lines: MESSAGE.lines,
    server: MESSAGE.server,
    actor: MESSAGE.actor,
  };
}

async function failure(promise: Promise<unknown>): Promise<DeliveryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeliveryError) return error;
    throw error;
  }
  throw new Error("expected a DeliveryError");
}

beforeEach(async () => {
  sink = await startHttpSink();
  clock = Date.parse("2026-11-26T03:50:00Z");
  slept = [];
  paid = true;
});

afterEach(async () => {
  await sink.close();
});

describe("generic webhook", () => {
  it("posts the JSON body with a signature the receiver can verify", async () => {
    const secret = randomBytes(24).toString("base64url");
    await sendWebhook(
      { url: `${sink.base}/hooks/abc`, signingSecret: secret },
      body(),
      "change.applied",
      context(),
    );
    expect(sink.received).toHaveLength(1);
    const got = sink.received[0];
    expect(got?.method).toBe("POST");
    expect(got?.path).toBe("/hooks/abc");
    expect(got?.headers["content-type"]).toBe("application/json");
    expect(got?.headers["x-dialwarden-event"]).toBe("change.applied");
    expect(got?.headers["x-dialwarden-delivery"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(got?.headers["user-agent"]).toMatch(/^Dialwarden\//);
    expect(JSON.parse(got?.body ?? "")).toEqual(body());
    const header = String(got?.headers["x-dialwarden-signature"]);
    const now = Math.floor(clock / 1000);
    expect(verifySignature(secret, got?.body ?? "", header, now)).toBe(true);
    expect(
      verifySignature(
        randomBytes(24).toString("hex"),
        got?.body ?? "",
        header,
        now,
      ),
    ).toBe(false);
  });

  it("sends no signature header without a secret", async () => {
    await sendWebhook(
      { url: `${sink.base}/h`, signingSecret: null },
      body(),
      "change.applied",
      context(),
    );
    expect(sink.received[0]?.headers["x-dialwarden-signature"]).toBeUndefined();
  });

  it("retries a 5xx with the same delivery id, then succeeds", async () => {
    sink.script({ status: 503 }, { status: 500 });
    await sendWebhook(
      { url: `${sink.base}/h`, signingSecret: null },
      body(),
      "change.applied",
      context(),
    );
    expect(sink.received).toHaveLength(3);
    const ids = sink.received.map((r) => r.headers["x-dialwarden-delivery"]);
    expect(new Set(ids).size).toBe(1);
    expect(slept).toEqual([1_000, 5_000]);
  });

  it("gives up after the last try", async () => {
    sink.script({ status: 502 }, { status: 502 }, { status: 502 });
    const error = await failure(
      sendWebhook(
        { url: `${sink.base}/h`, signingSecret: null },
        body(),
        "change.applied",
        context(),
      ),
    );
    expect(error.code).toBe("http_502");
    expect(sink.received).toHaveLength(MAX_ATTEMPTS);
  });

  it("never retries a 4xx (a configuration problem)", async () => {
    sink.script({ status: 404 });
    const error = await failure(
      sendWebhook(
        { url: `${sink.base}/h`, signingSecret: null },
        body(),
        "change.applied",
        context(),
      ),
    );
    expect(error.code).toBe("http_404");
    expect(sink.received).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("waits for a 429 Retry-After when longer than the pause", async () => {
    sink.script({ status: 429, headers: { "retry-after": "7" } });
    await sendWebhook(
      { url: `${sink.base}/h`, signingSecret: null },
      body(),
      "change.applied",
      context(),
    );
    expect(slept).toEqual([7_000]);
    expect(sink.received).toHaveLength(2);
  });

  it("stops retrying once the plan is Free", async () => {
    sink.script({ status: 503 });
    const ctx = context();
    const sleeping: SendContext = {
      ...ctx,
      sleep: async (ms, signal) => {
        await ctx.sleep(ms, signal);
        paid = false;
      },
    };
    const error = await failure(
      sendWebhook(
        { url: `${sink.base}/h`, signingSecret: null },
        body(),
        "change.applied",
        sleeping,
      ),
    );
    expect(error.code).toBe("plan_free");
    expect(sink.received).toHaveLength(1);
  });

  it("refuses a redirect to another host, and never follows it", async () => {
    const other = await startHttpSink();
    try {
      sink.script({ status: 302, headers: { location: `${other.base}/x` } });
      const error = await failure(
        sendWebhook(
          { url: `${sink.base}/h`, signingSecret: null },
          body(),
          "change.applied",
          context(),
        ),
      );
      expect(error.code).toBe("url_refused");
      expect(other.received).toEqual([]);
      expect(sink.received).toHaveLength(1);
    } finally {
      await other.close();
    }
  });
});

describe("network policy at send time (SSRF)", () => {
  const send = (url: string, policy: NetworkPolicy) =>
    failure(
      sendWebhook(
        { url, signingSecret: null },
        body(),
        "change.applied",
        context(policy),
      ),
    );

  it("refuses loopback, link-local and private addresses by default", async () => {
    const strict = policyOf(false, { allowHttp: true });
    const urls = [
      `${sink.base}/h`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/h",
      "http://192.168.1.20/h",
      "http://[::1]/h",
      "http://[fe80::1]/h",
      "http://0.0.0.0/h",
    ];
    for (const url of urls) {
      const error = await send(url, strict);
      expect(error.code, url).toBe("url_refused");
    }
    expect(sink.received).toEqual([]);
  });

  it("refuses a host name that resolves to a private address", async () => {
    const policy = policyOf(false, {
      allowHttp: true,
      resolve: async () => ["93.184.215.14", "10.1.2.3"],
    });
    const error = await send("http://hooks.example.test/h", policy);
    expect(error.code).toBe("url_refused");
  });

  it("lets a private host through only when the channel allows it", async () => {
    const resolve = async () => ["10.1.2.3"];
    const allowed = policyOf(true, { allowHttp: true, resolve });
    const checked = await checkUrl("http://hooks.lan.test/h", allowed);
    expect(checked.addresses).toEqual(["10.1.2.3"]);
    const strict = policyOf(false, { allowHttp: true, resolve });
    await expect(checkUrl("http://hooks.lan.test/h", strict)).rejects.toThrow(
      UrlRefusedError,
    );
  });

  it("never lets loopback or metadata through, even with a private host allowed", async () => {
    const policy = policyOf(true, { allowHttp: true });
    for (const url of [
      "http://127.0.0.1:9/h",
      "http://169.254.169.254/h",
      "http://[::ffff:127.0.0.1]/h",
    ]) {
      expect((await send(url, policy)).code, url).toBe("url_refused");
    }
  });

  // P10-A G2.1: the SMTP host is checked at send time like a URL host.
  it("G2.1 refuses an SMTP host that resolves to metadata or a private address", async () => {
    const target = {
      host: "mail.example.test",
      port: 587,
      security: "starttls" as const,
      username: null,
      password: null,
      from: "dialwarden@dialwarden.test",
      to: ["ops@dialwarden.test"],
    };
    const resolving = (address: string, allowPrivate: boolean) =>
      policyOf(allowPrivate, { resolve: async () => [address] });
    const cases: [string, boolean][] = [
      ["169.254.169.254", true],
      ["169.254.169.254", false],
      ["10.0.0.5", false],
    ];
    for (const [address, allowPrivate] of cases) {
      const policy = resolving(address, allowPrivate);
      const error = await failure(sendSmtp(target, MESSAGE, context(policy)));
      expect(error.code, address).toBe("host_refused");
    }
    // Nothing was retried, so no connection was even tried.
    expect(slept).toEqual([]);
  });

  // P10-A G2.2: an answer past the cap is refused once, never retried.
  it("G2.2 refuses an answer over 512 KiB without a retry", async () => {
    sink.script({ status: 200, body: "x".repeat(600 * 1024) });
    const error = await failure(
      sendWebhook(
        { url: `${sink.base}/h`, signingSecret: null },
        body(),
        "change.applied",
        context(),
      ),
    );
    expect(error.code).toBe("url_refused");
    expect(sink.received).toHaveLength(1);
  });

  // P10-A G2.3: the name is resolved once; the connection goes to the
  // address that was checked, whatever the name resolves to later.
  it("G2.3 connects only to the checked address of a rebinding name", async () => {
    const answers = [["127.0.0.1"], ["169.254.169.254"]];
    let calls = 0;
    const policy = policyOf(false, {
      allowLoopback: true,
      allowHttp: true,
      resolve: async () => {
        const found = answers[Math.min(calls, answers.length - 1)] ?? [];
        calls += 1;
        return found;
      },
    });
    await sendWebhook(
      { url: `http://rebind.example.test:${sink.port}/h`, signingSecret: null },
      body(),
      "change.applied",
      context(policy),
    );
    expect(calls).toBe(1);
    expect(sink.received).toHaveLength(1);
  });

  it("refuses http and credentials in the URL", async () => {
    const strict = policyOf(false, {});
    expect((await send("http://hooks.example.test/h", strict)).code).toBe(
      "url_refused",
    );
    expect(
      (await send("https://user:pw@hooks.example.test/h", strict)).code,
    ).toBe("url_refused");
  });
});

describe("Discord webhook", () => {
  it("posts the message with the chips as text and no mentions", async () => {
    await sendDiscord(
      `${sink.base}/api/webhooks/1/token`,
      MESSAGE,
      new DiscordPace(),
      context(),
    );
    const sent = JSON.parse(sink.received[0]?.body ?? "{}") as {
      content: string;
      allowed_mentions: { parse: unknown[] };
    };
    expect(sent.allowed_mentions).toEqual({ parse: [] });
    const zwsp = String.fromCodePoint(0x200b);
    expect(sent.content).toBe(
      [
        `**Change applied on Alpha @${zwsp}everyone (Palworld)**`,
        "By Owner, 2026-11-26 03:50 UTC",
        "- Max players: 32 to 20",
        "- Admin password: changed (secret, hidden)",
      ].join("\n"),
    );
  });

  it("keeps the message within 2000 characters", () => {
    const long: NotificationMessage = {
      ...MESSAGE,
      lines: Array.from(
        { length: 200 },
        (_, i) => `Setting ${String(i)}: a to b`,
      ),
    };
    const content = discordBody(long).content;
    expect(content.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(content).toMatch(/\.\.\. and \d+ more lines$/);
  });

  it("paces messages at 5 per 2 seconds", async () => {
    const pace = new DiscordPace();
    for (let i = 0; i < 7; i += 1) {
      await sendDiscord(`${sink.base}/w`, MESSAGE, pace, context());
    }
    expect(sink.received).toHaveLength(7);
    // The sixth waits for the window of the first to pass.
    expect(slept).toEqual([2_000]);
  });

  it("waits when Discord says the bucket is empty", async () => {
    const pace = new DiscordPace();
    sink.script(DISCORD_ANSWERS.okLastOfBucket);
    await sendDiscord(`${sink.base}/w`, MESSAGE, pace, context());
    await sendDiscord(`${sink.base}/w`, MESSAGE, pace, context());
    expect(slept).toEqual([1_500]);
  });

  it("retries a 429 after its retry_after", async () => {
    sink.script(DISCORD_ANSWERS.rateLimited);
    await sendDiscord(`${sink.base}/w`, MESSAGE, new DiscordPace(), context());
    expect(sink.received).toHaveLength(2);
    // retry_after 2.5 s from the body: the pause, then the pace's block.
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2_500);
  });

  it("stops at an unknown webhook (404) without a retry", async () => {
    sink.script(DISCORD_ANSWERS.unknownWebhook);
    const error = await failure(
      sendDiscord(`${sink.base}/w`, MESSAGE, new DiscordPace(), context()),
    );
    expect(error.code).toBe("http_404");
    expect(sink.received).toHaveLength(1);
  });
});
