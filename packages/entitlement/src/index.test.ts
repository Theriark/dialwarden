import { describe, expect, it } from "vitest";
import { epochToIso, readBuildInfo } from "./index.js";

const sha = "0123456789abcdef0123456789abcdef01234567";

describe("readBuildInfo", () => {
  it("reads the image build variables", () => {
    const info = readBuildInfo({
      DIALWARDEN_REVISION: sha,
      DIALWARDEN_BUILD_EPOCH: "1795244400",
      DIALWARDEN_FEATURE_BASELINE_EPOCH: "1795244400",
    });
    expect(info).toEqual({
      revision: sha,
      buildDate: "2026-11-21T07:00:00Z",
      featureBaseline: "2026-11-21T07:00:00Z",
    });
  });

  it("reports unknown and null outside an image build", () => {
    const info = readBuildInfo({});
    expect(info).toEqual({
      revision: "unknown",
      buildDate: null,
      featureBaseline: null,
    });
  });

  it("refuses values that are not a SHA or an epoch", () => {
    const info = readBuildInfo({ DIALWARDEN_REVISION: "main" });
    expect(info.revision).toBe("unknown");
    expect(epochToIso("")).toBeNull();
    expect(epochToIso("-1")).toBeNull();
    expect(epochToIso("2026-11-21")).toBeNull();
  });
});
