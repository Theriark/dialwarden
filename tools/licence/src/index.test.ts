import { describe, expect, it } from "vitest";
import { TOKEN_PREFIX, hasTokenPrefix } from "./index.js";

describe("licence tool skeleton", () => {
  it("recognises the DW1 token prefix", () => {
    expect(TOKEN_PREFIX).toBe("DW1");
    expect(hasTokenPrefix("DW1.payload.signature")).toBe(true);
    expect(hasTokenPrefix("DW2.payload.signature")).toBe(false);
  });
});
