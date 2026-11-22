// Fuzzing of the launch adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { launchKit } from "../../test/kits.js";

describe("fuzzing launch", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(launchKit).iterations).toBeGreaterThan(0);
  });
});
