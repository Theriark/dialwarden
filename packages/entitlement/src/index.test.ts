import { describe, expect, it } from "vitest";
import {
  EntitlementGate,
  epochToIso,
  readBuildInfo,
  resolveEntitlement,
  ruleDates,
  type Entitlement,
  type LicenceEvaluation,
} from "./index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";

describe("readBuildInfo", () => {
  it("reads the image build variables", () => {
    const info = readBuildInfo({
      DIALWARDEN_REVISION: sha,
      DIALWARDEN_BUILD_EPOCH: "1795244400",
      DIALWARDEN_FEATURE_BASELINE_EPOCH: "1795244400",
    });
    expect(info).toEqual({
      revision: sha,
      buildDate: "2026-11-21T07:00:00Z",
      featureBaseline: "2026-11-21T07:00:00Z",
    });
  });

  it("reports unknown and null outside an image build", () => {
    const info = readBuildInfo({});
    expect(info).toEqual({
      revision: "unknown",
      buildDate: null,
      featureBaseline: null,
    });
  });

  it("refuses values that are not a SHA or an epoch", () => {
    const info = readBuildInfo({ DIALWARDEN_REVISION: "main" });
    expect(info.revision).toBe("unknown");
    expect(epochToIso("")).toBeNull();
    expect(epochToIso("-1")).toBeNull();
    expect(epochToIso("2026-11-21")).toBeNull();
  });
});

describe("ruleDates", () => {
  it("uses the image dates", () => {
    const dates = ruleDates(
      {
        revision: sha,
        buildDate: "2027-03-01T00:00:00Z",
        featureBaseline: "2026-12-01T00:00:00Z",
      },
      new Date("2030-01-01T00:00:00Z"),
    );
    expect(dates.buildDate.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(dates.featureBaseline.toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  it("falls back to the start time outside an image build", () => {
    const start = new Date("2026-11-21T08:00:00Z");
    const dates = ruleDates(readBuildInfo({}), start);
    expect(dates.buildDate).toEqual(start);
    expect(dates.featureBaseline).toEqual(start);
  });
});

describe("EntitlementGate", () => {
  const activeEnv: LicenceEvaluation = {
    state: "active",
    payload: null,
    lidHash8: "abcdef01",
    last6: "xyz123",
    reason: null,
  };
  const entitlement = (paid: boolean): Entitlement =>
    resolveEntitlement({
      ui: null,
      env: paid ? activeEnv : null,
      envIgnored: false,
      buildDate: null,
      featureBaseline: null,
      now: new Date(),
    });
  const noServers = (): string[] => [];

  it("answers can and limit from the current entitlement", () => {
    let paid = false;
    const current = () => entitlement(paid);
    const gate = new EntitlementGate(current, noServers);
    expect(gate.can("schedules")).toBe(false);
    expect(gate.limit("servers")).toBe(3);
    paid = true;
    expect(gate.can("schedules")).toBe(true);
    expect(gate.limit("users")).toBeNull();
    expect(gate.getEntitlement().plan).toBe("paid");
  });

  it("on Free only the chosen three servers are editable", () => {
    const chosen = ["a", "b", "c", "d"];
    const free = () => entitlement(false);
    const editable = () => chosen;
    const gate = new EntitlementGate(free, editable);
    expect(gate.isServerEditable("a")).toBe(true);
    expect(gate.isServerEditable("c")).toBe(true);
    expect(gate.isServerEditable("d")).toBe(false);
    expect(gate.isServerEditable("z")).toBe(false);
  });

  it("on Paid every server is editable", () => {
    const paid = () => entitlement(true);
    const gate = new EntitlementGate(paid, noServers);
    expect(gate.isServerEditable("z")).toBe(true);
  });
});
