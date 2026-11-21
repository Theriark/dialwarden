import { describe, expect, it } from "vitest";
import { parseSeedEnvironment } from "./index.js";

describe("seed tool skeleton", () => {
  it("accepts development and stage only", () => {
    expect(parseSeedEnvironment("development")).toBe("development");
    expect(parseSeedEnvironment("stage")).toBe("stage");
    expect(() => parseSeedEnvironment("production")).toThrow(/unknown/);
  });
});
