import { describe, expect, it } from "vitest";
import { parseSeedEnvironment } from "./index.js";

describe("seed environments", () => {
  it("accepts dev and stage only", () => {
    expect(parseSeedEnvironment("dev")).toBe("dev");
    expect(parseSeedEnvironment("stage")).toBe("stage");
    expect(() => parseSeedEnvironment("production")).toThrow(/unknown/);
  });
});
