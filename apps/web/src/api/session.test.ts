import { describe, expect, it } from "vitest";
import { safeRedirect } from "./session";

describe("safeRedirect", () => {
  it("keeps same-origin paths and refuses everything else", () => {
    expect(safeRedirect("/settings/licence?x=1")).toBe("/settings/licence?x=1");
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect("https://example.test/")).toBe("/");
    expect(safeRedirect("//example.test/")).toBe("/");
    expect(safeRedirect("/\\example.test")).toBe("/");
    expect(safeRedirect("settings")).toBe("/");
  });
});
