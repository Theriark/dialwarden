// Build information in production (security review THE-2134 M2, threat tests
// T3; code review M14). The CRA-safe rule dates come from the image's
// build-info.json, never from the environment, and an image without them
// refuses to start.
/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { customerLicence, devLicence } from "@dialwarden/entitlement/testing";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, testApp, type TestApp } from "../test/helpers.js";
import { loadBuildInfo } from "./build-info.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
/** 2026-11-21T07:00:00Z, the date every test image is built on. */
const EPOCH = "1795244400";
const folders: string[] = [];
let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

async function buildInfoFile(content: unknown): Promise<string> {
  const folder = await tempDir("dialwarden-build-info-");
  folders.push(folder);
  const file = join(folder, "build-info.json");
  const text = typeof content === "string" ? content : JSON.stringify(content);
  await writeFile(file, text);
  return file;
}

const imageFile = () =>
  buildInfoFile({
    revision: sha,
    buildEpoch: EPOCH,
    featureBaselineEpoch: EPOCH,
  });

const production = { NODE_ENV: "production" };

function entitlementOf(app: TestApp["app"]) {
  const { plan, state } = app.ctx.entitlement.getEntitlement();
  return { plan, state };
}

describe("loadBuildInfo", () => {
  it("reads only the build file in production", async () => {
    const file = await imageFile();
    const info = loadBuildInfo(
      {
        ...production,
        DIALWARDEN_REVISION: "f".repeat(40),
        DIALWARDEN_BUILD_EPOCH: "0",
        DIALWARDEN_FEATURE_BASELINE_EPOCH: "0",
      },
      file,
    );
    expect(info).toEqual({
      revision: sha,
      buildDate: "2026-11-21T07:00:00Z",
      featureBaseline: "2026-11-21T07:00:00Z",
    });
  });

  it("refuses to start in production without valid build dates", async () => {
    const folder = await tempDir("dialwarden-build-info-");
    folders.push(folder);
    const missing = join(folder, "none.json");
    const unreadable = /cannot read the build information/;
    expect(() => loadBuildInfo(production, missing)).toThrow(unreadable);
    const noDates = await buildInfoFile({
      revision: sha,
      buildEpoch: "",
      featureBaselineEpoch: "",
    });
    expect(() => loadBuildInfo(production, noDates)).toThrow(/build dates/);
    const broken = await buildInfoFile("{");
    expect(() => loadBuildInfo(production, broken)).toThrow(unreadable);
  });

  it("reads the build variables outside production", () => {
    const info = loadBuildInfo(
      { DIALWARDEN_BUILD_EPOCH: EPOCH, DIALWARDEN_FEATURE_BASELINE_EPOCH: "0" },
      "/nonexistent/build-info.json",
    );
    expect(info.buildDate).toBe("2026-11-21T07:00:00Z");
    expect(info.featureBaseline).toBe("1970-01-01T00:00:00Z");
  });
});

describe("an environment variable cannot move the rule dates", () => {
  const lapsed = () =>
    customerLicence({
      issuedAt: "2025-11-01T10:00:00Z",
      updatesUntil: "2026-01-31",
    });

  it("a lapsed customer licence stays Free with the baseline set to 0", async () => {
    current = await testApp({
      buildInfoFile: await imageFile(),
      extraEnv: {
        ...production,
        DIALWARDEN_LICENCE: lapsed(),
        DIALWARDEN_FEATURE_BASELINE_EPOCH: "0",
      },
    });
    expect(entitlementOf(current.app)).toEqual({
      plan: "free",
      state: "term_ended_for_this_version",
    });
  });

  it("an old internal-dev licence stays out of its window with an old build date", async () => {
    current = await testApp({
      buildInfoFile: await imageFile(),
      extraEnv: {
        ...production,
        DIALWARDEN_LICENCE: devLicence({ issuedAt: "2025-01-01T00:00:00Z" }),
        DIALWARDEN_BUILD_EPOCH: "1735689600",
      },
    });
    expect(entitlementOf(current.app)).toEqual({
      plan: "free",
      state: "dev_window_passed",
    });
  });

  it("outside production the same variable still moves the baseline", async () => {
    // The control case: without NODE_ENV production the variables count, which
    // is what the two cases above must not allow.
    current = await testApp({
      extraEnv: {
        DIALWARDEN_LICENCE: lapsed(),
        DIALWARDEN_FEATURE_BASELINE_EPOCH: "0",
      },
    });
    expect(entitlementOf(current.app)).toEqual({
      plan: "paid",
      state: "active",
    });
  });
});
