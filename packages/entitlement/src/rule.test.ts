import { describe, expect, it } from "vitest";
import {
  customerLicence,
  customerPayload,
  devLicence,
  devPayload,
  signPayload,
  testKeyRing,
  testKeys,
} from "../test/testing.js";
import { revocationHash } from "./revocation.js";
import {
  evaluateLicence,
  resolveEntitlement,
  type BuildDates,
  type LicenceEvaluation,
  type RuleContext,
} from "./rule.js";

const DAY = 86_400_000;

// v27.0.0 was built on 2026-12-01; licences in these tests cover updates until
// 2027-06-30 unless a test says otherwise.
const V27_0_0 = new Date("2026-12-01T12:00:00Z");
const image = (buildDate: Date, featureBaseline: Date): BuildDates => ({
  buildDate,
  featureBaseline,
});
const context = (build: BuildDates, revoked: string[] = []): RuleContext => ({
  keys: testKeyRing,
  build,
  revoked,
});
const release = context(image(V27_0_0, V27_0_0));

function tamperPayload(licence: string): string {
  const [prefix, payload, signature] = licence.split(".");
  const json = JSON.parse(
    Buffer.from(payload ?? "", "base64url").toString("utf8"),
  ) as { maxServers: number };
  json.maxServers = 10000;
  const changed = Buffer.from(JSON.stringify(json)).toString("base64url");
  return `${prefix}.${changed}.${signature}`;
}

function tamperSignature(licence: string): string {
  const [prefix, payload, signature] = licence.split(".");
  const bytes = Buffer.from(signature ?? "", "base64url");
  bytes.writeUInt8((bytes.readUInt8(10) ^ 0x01) & 0xff, 10);
  return `${prefix}.${payload}.${bytes.toString("base64url")}`;
}

describe("customer licences", () => {
  it("a valid licence is active", () => {
    const result = evaluateLicence(customerLicence(), release);
    expect(result.state).toBe("active");
    expect(result.payload?.customer.name).toBe("Test Customer");
    expect(result.lidHash8).toMatch(/^[0-9a-f]{8}$/);
  });

  it("a tampered payload is an invalid signature", () => {
    const result = evaluateLicence(tamperPayload(customerLicence()), release);
    expect(result.state).toBe("invalid_signature");
  });

  it("a tampered signature is an invalid signature", () => {
    const result = evaluateLicence(tamperSignature(customerLicence()), release);
    expect(result.state).toBe("invalid_signature");
  });

  it("a development-key signature on a customer payload is invalid", () => {
    const licence = signPayload(
      customerPayload(),
      testKeys.development.privateKey,
    );
    expect(evaluateLicence(licence, release).state).toBe("invalid_signature");
  });

  it("a signature by an unknown key is invalid", () => {
    const licence = signPayload(
      customerPayload(),
      testKeys.stranger.privateKey,
    );
    expect(evaluateLicence(licence, release).state).toBe("invalid_signature");
  });

  it("a revoked licence (salted hash of lid) is revoked", () => {
    const payload = customerPayload();
    const licence = signPayload(payload, testKeys.production.privateKey);
    const revoked = context(image(V27_0_0, V27_0_0), [
      revocationHash(payload.lid),
    ]);
    expect(evaluateLicence(licence, revoked).state).toBe("revoked");
    // The raw id in the list revokes nothing: only salted hashes count.
    const raw = context(image(V27_0_0, V27_0_0), [payload.lid]);
    expect(evaluateLicence(licence, raw).state).toBe("active");
  });

  it("featureBaseline on the last day of updatesUntil is still covered", () => {
    const licence = customerLicence({ updatesUntil: "2026-12-01" });
    const lastSecond = new Date("2026-12-01T23:59:59Z");
    const result = evaluateLicence(
      licence,
      context(image(lastSecond, lastSecond)),
    );
    expect(result.state).toBe("active");
  });

  it("featureBaseline after updatesUntil ends the term for this version", () => {
    const licence = customerLicence({ updatesUntil: "2026-11-30" });
    const result = evaluateLicence(licence, release);
    expect(result.state).toBe("term_ended_for_this_version");
  });

  it("a 27.0.x patch image keeps Paid for a lapsed licence", () => {
    // updatesUntil covers v27.0.0 but ended long before the patch was built.
    const licence = customerLicence({ updatesUntil: "2026-12-31" });
    const patch = new Date("2027-09-15T08:00:00Z");
    const result = evaluateLicence(licence, context(image(patch, V27_0_0)));
    expect(result.state).toBe("active");
  });

  it("a 27.1 image drops the same lapsed licence to Free", () => {
    const licence = customerLicence({ updatesUntil: "2026-12-31" });
    const v27_1 = new Date("2027-09-15T08:00:00Z");
    const result = evaluateLicence(licence, context(image(v27_1, v27_1)));
    expect(result.state).toBe("term_ended_for_this_version");
  });

  it("the clock does not change the rule", () => {
    const licence = customerLicence({ updatesUntil: "2026-12-31" });
    const result = evaluateLicence(licence, release);
    const entitlement = resolveEntitlement({
      ui: result,
      env: null,
      envIgnored: false,
      buildDate: null,
      featureBaseline: null,
      now: new Date("2031-01-01T00:00:00Z"),
    });
    expect(entitlement.plan).toBe("paid");
  });
});

describe("internal-dev licences", () => {
  const issued = new Date("2026-11-01T10:00:00Z");
  const at = (days: number) => new Date(issued.getTime() + days * DAY);
  const licence = devLicence({ issuedAt: "2026-11-01T10:00:00Z" });

  it("is active on an image built 119 days after issuedAt", () => {
    const build = at(119);
    const result = evaluateLicence(licence, context(image(build, build)));
    expect(result.state).toBe("active");
  });

  it("is active on an image built 119 days before issuedAt", () => {
    const build = at(-119);
    const result = evaluateLicence(licence, context(image(build, build)));
    expect(result.state).toBe("active");
  });

  it("is refused on an image built 121 days after issuedAt", () => {
    const build = at(121);
    const result = evaluateLicence(licence, context(image(build, build)));
    expect(result.state).toBe("dev_window_passed");
  });

  it("is refused on an image built 121 days before issuedAt", () => {
    const build = at(-121);
    const result = evaluateLicence(licence, context(image(build, build)));
    expect(result.state).toBe("dev_window_passed");
  });

  it("ignores updatesUntil", () => {
    const ended = devLicence({
      issuedAt: "2026-11-01T10:00:00Z",
      updatesUntil: "2026-11-02",
    });
    const build = at(100);
    const result = evaluateLicence(ended, context(image(build, build)));
    expect(result.state).toBe("active");
  });

  it("verifies with the next development key too", () => {
    const next = signPayload(
      devPayload({ issuedAt: "2026-11-01T10:00:00Z" }),
      testKeys.developmentNext.privateKey,
    );
    const build = at(1);
    const result = evaluateLicence(next, context(image(build, build)));
    expect(result.state).toBe("active");
  });

  it("a production-key signature on an internal-dev payload is invalid", () => {
    const wrong = signPayload(
      devPayload({ issuedAt: "2026-11-01T10:00:00Z" }),
      testKeys.production.privateKey,
    );
    const build = at(1);
    const result = evaluateLicence(wrong, context(image(build, build)));
    expect(result.state).toBe("invalid_signature");
  });
});

describe("malformed tokens", () => {
  it.each([
    ["empty", ""],
    ["no parts", "DW1"],
    ["wrong prefix", customerLicence().replace(/^DW1/, "DW2")],
    ["four parts", `${customerLicence()}.x`],
    ["padding", `${customerLicence()}=`],
    ["too long", `DW1.${"A".repeat(5000)}.x`],
  ])("%s is malformed", (_name, value) => {
    const result = evaluateLicence(value, release);
    expect(result.state).toBe("malformed");
    expect(result.payload).toBeNull();
  });

  it("a payload that fails the schema is malformed", () => {
    const bad = signPayload(
      { ...customerPayload(), maxServers: 0 },
      testKeys.production.privateKey,
    );
    const result = evaluateLicence(bad, release);
    expect(result.state).toBe("malformed");
    expect(result.reason).toBe("payload.maxServers");
  });

  it("a customer name over 64 characters is malformed", () => {
    const bad = signPayload(
      customerPayload({ customer: { id: "c", name: "n".repeat(65) } }),
      testKeys.production.privateKey,
    );
    expect(evaluateLicence(bad, release).state).toBe("malformed");
  });
});

describe("environment versus UI licence", () => {
  const active = (): LicenceEvaluation =>
    evaluateLicence(customerLicence(), release);
  const ended = (): LicenceEvaluation =>
    evaluateLicence(customerLicence({ updatesUntil: "2026-01-01" }), release);
  const invalid = (): LicenceEvaluation =>
    evaluateLicence(tamperSignature(customerLicence()), release);
  const resolve = (
    ui: LicenceEvaluation | null,
    env: LicenceEvaluation | null,
    envIgnored: boolean,
  ) =>
    resolveEntitlement({
      ui,
      env,
      envIgnored,
      buildDate: "2026-12-01T12:00:00Z",
      featureBaseline: "2026-12-01T12:00:00Z",
      now: new Date("2026-12-02T00:00:00Z"),
    });

  it("no licence at all is Free with source none", () => {
    const result = resolve(null, null, false);
    expect(result).toMatchObject({ plan: "free", state: "none" });
    expect(result.source).toBe("none");
    expect(result.licence).toBeNull();
    expect(result.envLicence).toEqual({
      present: false,
      state: "none",
      ignored: false,
    });
  });

  it("an environment licence alone decides", () => {
    const result = resolve(null, active(), false);
    expect(result).toMatchObject({ plan: "paid", source: "environment" });
  });

  it("a UI licence wins over the environment licence", () => {
    const ui = active();
    const result = resolve(ui, active(), false);
    expect(result.source).toBe("ui");
    expect(result.licence?.lidHash8).toBe(ui.lidHash8);
  });

  it("a UI licence decides in whatever state, even over an active env one", () => {
    const result = resolve(ended(), active(), false);
    expect(result).toMatchObject({
      plan: "free",
      source: "ui",
      state: "term_ended_for_this_version",
    });
    expect(result.envLicence.state).toBe("active");
  });

  it("removing the UI licence falls back to the environment licence", () => {
    expect(resolve(ended(), active(), false).plan).toBe("free");
    expect(resolve(null, active(), false).plan).toBe("paid");
  });

  it("the owner's Free switch ignores the environment licence", () => {
    const result = resolve(null, active(), true);
    expect(result).toMatchObject({ plan: "free", source: "none" });
    expect(result.envLicence).toEqual({
      present: true,
      state: "active",
      ignored: true,
    });
  });

  it("the Free switch does not touch a UI licence", () => {
    const result = resolve(active(), active(), true);
    expect(result).toMatchObject({ plan: "paid", source: "ui" });
  });

  it("an invalid environment licence gives Free and shows the reason", () => {
    const result = resolve(null, invalid(), false);
    expect(result).toMatchObject({
      plan: "free",
      source: "environment",
      state: "invalid_signature",
    });
    expect(result.envLicence.state).toBe("invalid_signature");
  });

  it("Paid limits use maxServers; Free limits are fixed", () => {
    const paid = resolve(null, active(), false);
    expect(paid.limits).toEqual({
      servers: 25,
      users: null,
      historyVisible: null,
      presets: null,
    });
    expect(paid.features["schedules"]).toBe(true);
    expect(paid.features["assistant"]).toBe(false);
    const free = resolve(null, null, false);
    expect(free.limits).toEqual({
      servers: 3,
      users: 1,
      historyVisible: 5,
      presets: 3,
    });
    expect(Object.values(free.features).some(Boolean)).toBe(false);
  });

  it("a licence without maxServers allows 50 servers", () => {
    const evaluation = evaluateLicence(
      signPayload(
        { ...customerPayload(), maxServers: undefined },
        testKeys.production.privateKey,
      ),
      release,
    );
    expect(resolve(evaluation, null, false).limits.servers).toBe(50);
  });

  it("warns 30 days before updatesUntil and never shows the full token", () => {
    const licence = customerLicence({ updatesUntil: "2026-12-20" });
    const evaluation = evaluateLicence(licence, release);
    const result = resolve(evaluation, null, false);
    expect(result.licence?.warn30).toBe(true);
    expect(result.licence?.last6).toBe(licence.slice(-6));
    expect(JSON.stringify(result)).not.toContain(licence.slice(0, 40));
  });
});
