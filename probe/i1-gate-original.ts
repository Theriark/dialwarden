import { describe, expect, it } from "vitest";

describe("EntitlementGate", () => {
  const entitlement = (paid: boolean): Entitlement =>
    resolveEntitlement({
      ui: null,
      env: paid
        ? {
            state: "active",
            payload: null,
            lidHash8: "abcdef01",
            last6: "xyz123",
            reason: null,
          }
        : null,
      envIgnored: false,
      buildDate: null,
      featureBaseline: null,
      now: new Date(),
    });

  it("answers can and limit from the current entitlement", () => {
    let paid = false;
    const gate = new EntitlementGate(() => entitlement(paid), () => []);
    expect(gate.can("schedules")).toBe(false);
    expect(gate.limit("servers")).toBe(3);
    paid = true;
    expect(gate.can("schedules")).toBe(true);
    expect(gate.limit("users")).toBeNull();
    expect(gate.getEntitlement().plan).toBe("paid");
  });

  it("on Free only the chosen three servers are editable", () => {
    const chosen = ["a", "b", "c", "d"];
    const gate = new EntitlementGate(() => entitlement(false), () => chosen);
    expect(gate.isServerEditable("a")).toBe(true);
    expect(gate.isServerEditable("c")).toBe(true);
    expect(gate.isServerEditable("d")).toBe(false);
    expect(gate.isServerEditable("z")).toBe(false);
  });

  it("on Paid every server is editable", () => {
    const gate = new EntitlementGate(() => entitlement(true), () => []);
    expect(gate.isServerEditable("z")).toBe(true);
  });
});
