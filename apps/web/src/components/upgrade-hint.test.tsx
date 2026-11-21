// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UpgradeHint, upgradeSentence } from "./upgrade-hint";

afterEach(cleanup);

describe("UpgradeHint", () => {
  it("names a feature in plain words, without a price or a link", () => {
    render(
      <UpgradeHint
        body={{
          error: "payment_required",
          plan: "free",
          feature: "schedules",
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Scheduled changes is part of the Paid plan.",
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.body.textContent).not.toMatch(/USD|EUR|\$|€/);
  });

  it("shows the limit with the current and maximum values", () => {
    render(
      <UpgradeHint
        body={{
          error: "payment_required",
          plan: "free",
          limit: "presets",
          current: 3,
          max: 3,
        }}
      />,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("The Free plan includes 3 saved presets.");
    expect(text).toContain("3 of 3 in use");
  });

  it("falls back to the key for an unknown feature and limit", () => {
    const unknownFeature = upgradeSentence({
      error: "payment_required",
      plan: "free",
      feature: "later.thing",
    });
    expect(unknownFeature).toBe("Later.thing is part of the Paid plan.");
    const servers = upgradeSentence({
      error: "payment_required",
      plan: "free",
      limit: "servers",
      current: 3,
      max: 3,
    });
    expect(servers).toContain("3 editable servers");
    expect(servers).toContain("raises it");
  });
});
