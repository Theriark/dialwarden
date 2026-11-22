// Fuzzing of the lua adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { luaKit } from "../../test/kits.js";

describe("fuzzing lua", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(luaKit).iterations).toBeGreaterThan(0);
  });
});
