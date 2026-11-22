// Fuzzing of the jsonc adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { jsoncKit } from "../../test/kits.js";

describe("fuzzing jsonc", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(jsoncKit).iterations).toBeGreaterThan(0);
  });
});
