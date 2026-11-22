// Fuzzing of the cfg adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { cfgKit } from "../../test/kits.js";

describe("fuzzing cfg", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(cfgKit).iterations).toBeGreaterThan(0);
  });
});
