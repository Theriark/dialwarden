import { describe, expect, it } from "vitest";
import { pageTitle } from "./title";

describe("pageTitle", () => {
  it("names the product, with an optional section first", () => {
    expect(pageTitle()).toBe("Dialwarden");
    expect(pageTitle("Servers")).toBe("Servers · Dialwarden");
  });
});
