// Fuzzing of the shellvar adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { shellVarKit } from "../../test/kits.js";

describe("fuzzing shellvar", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(shellVarKit).iterations).toBeGreaterThan(0);
  });
});
