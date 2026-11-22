// Fuzzing of the ueini adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { ueIniKit } from "../../test/kits.js";

describe("fuzzing ueini", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(ueIniKit).iterations).toBeGreaterThan(0);
  });
});
