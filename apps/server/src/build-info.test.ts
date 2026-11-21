// Build information (security review THE-2134 M2, threat tests T3; THE-2151
// N1, threat tests T11; code review M14). The CRA-safe rule dates come from
// the image's build-info.json whenever it exists, never from the environment
// (whatever NODE_ENV says), and an image without them refuses to start.
/* eslint-disable security/detect-non-literal-fs-filename -- test folders under the system temporary folder */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { customerLicence, devLicence } from "@dialwarden/entitlement/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_BUILD_INFO_FILE,
  tempDir,
  testApp,
  type TestApp,
} from "../test/helpers.js";
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
const development = { NODE_ENV: "development" };
/** The variables an operator would set to move the rule dates. */
const moved = {
  DIALWARDEN_REVISION: "f".repeat(40),
  DIALWARDEN_BUILD_EPOCH: "0",
  DIALWARDEN_FEATURE_BASELINE_EPOCH: "0",
};
const fileDates = {
  revision: sha,
  buildDate: "2026-11-21T07:00:00Z",
  featureBaseline: "2026-11-21T07:00:00Z",
};

function entitlementOf(app: TestApp["app"]) {
  const { plan, state } = app.ctx.entitlement.getEntitlement();
  return { plan, state };
}

describe("loadBuildInfo", () => {
  it("reads only the build file in production", async () => {
    const file = await imageFile();
    expect(loadBuildInfo({ ...production, ...moved }, file)).toEqual(fileDates);
  });

  // T11.1 and T11.2: NODE_ENV does not decide; the file does.
  it("reads only the build file with NODE_ENV development or unset", async () => {
    const file = await imageFile();
    expect(loadBuildInfo({ ...development, ...moved }, file)).toEqual(
      fileDates,
    );
    expect(loadBuildInfo({ ...moved }, file)).toEqual(fileDates);
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
    expect(() => loadBuildInfo(development, broken)).toThrow(unreadable);
    expect(() => loadBuildInfo({}, noDates)).toThrow(/build dates/);
  });

  it("reads the build variables only when the file is absent", () => {
    const info = loadBuildInfo(
      { DIALWARDEN_BUILD_EPOCH: EPOCH, DIALWARDEN_FEATURE_BASELINE_EPOCH: "0" },
      NO_BUILD_INFO_FILE,
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

  // T11.3: NODE_ENV development no longer brings the variables back.
  it("a lapsed customer licence stays Free with NODE_ENV development", async () => {
    current = await testApp({
      buildInfoFile: await imageFile(),
      extraEnv: {
        ...development,
        DIALWARDEN_LICENCE: lapsed(),
        DIALWARDEN_FEATURE_BASELINE_EPOCH: "0",
      },
    });
    expect(entitlementOf(current.app)).toEqual({
      plan: "free",
      state: "term_ended_for_this_version",
    });
  });

  // T11.4
  it("an old internal-dev licence stays out of its window with NODE_ENV development", async () => {
    current = await testApp({
      buildInfoFile: await imageFile(),
      extraEnv: {
        ...development,
        DIALWARDEN_LICENCE: devLicence({ issuedAt: "2025-01-01T00:00:00Z" }),
        DIALWARDEN_BUILD_EPOCH: "1735689600",
      },
    });
    expect(entitlementOf(current.app)).toEqual({
      plan: "free",
      state: "dev_window_passed",
    });
  });

  // T11.5
  it("refuses to start with NODE_ENV development and a broken file", async () => {
    const broken = await buildInfoFile("{");
    const start = testApp({ buildInfoFile: broken, extraEnv: development });
    await expect(start).rejects.toThrow(/cannot read the build information/);
  });

  // T11.6
  it("without the build file the same variable still moves the baseline", async () => {
    // The control case: with no build file (CI, a run from source) the
    // variables count, which is what the cases above must not allow.
    current = await testApp({
      buildInfoFile: NO_BUILD_INFO_FILE,
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
