// Fuzzing of the ini adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { iniKit } from "../../test/kits.js";

describe("fuzzing ini", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(iniKit).iterations).toBeGreaterThan(0);
  });
});
