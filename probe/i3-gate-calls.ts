import { expect, it } from "vitest";

it("answers can and limit from the current entitlement", () => {
  let paid = false;
  const gate = new EntitlementGate(() => entitlement(paid), () => []);
  expect(gate.can("schedules")).toBe(false);
  paid = true;
  const other = new EntitlementGate(() => entitlement(false), () => chosen);
  expect(other.can("schedules")).toBe(true);
});
