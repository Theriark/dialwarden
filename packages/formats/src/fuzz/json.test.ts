// Fuzzing of the json adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { jsonKit } from "../../test/kits.js";

describe("fuzzing json", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(jsonKit).iterations).toBeGreaterThan(0);
  });
});
