// Fuzzing of the shellvar-systemd adapter: FORMATS_FUZZ_SECONDS (30 in CI) of random
// and mutated files, each checked against the adapter contract.

import { describe, expect, it } from "vitest";
import { fuzz, fuzzTimeout } from "../../test/harness.js";
import { systemdKit } from "../../test/kits.js";

describe("fuzzing shellvar-systemd", () => {
  it("random files", { timeout: fuzzTimeout() }, () => {
    expect(fuzz(systemdKit).iterations).toBeGreaterThan(0);
  });
});
