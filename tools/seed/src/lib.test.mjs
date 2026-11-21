// tools/seed (dev-work-plan P1-A step 9). The owner is created against a real
// app (in-process, through inject); the task client is a stand-in that
// records its arguments.
import { afterEach, describe, expect, it } from "vitest";
import { setupOwner, testApp } from "../../../apps/server/test/helpers.ts";
import {
  checkBaseUrl,
  generatePassword,
  main,
  PASSWORD_ALPHABET,
  variableNames,
} from "./lib.mjs";

const DEV_URL = "https://app-dev-dialwarden.theriark.dev";
const STAGE_URL = "https://app-stg-dialwarden.theriark.dev";
const NAMES = ["DIALWARDEN_DEV_OWNER_EMAIL", "DIALWARDEN_DEV_OWNER_PASSWORD"];
let current;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** fetch for the seed, answered by the app through inject. */
function fetchFor(app) {
  return async (url, init = {}) => {
    const { pathname } = new URL(url);
    const res = await app.inject({
      method: init.method ?? "GET",
      url: pathname,
      headers: init.headers,
      payload: init.body,
    });
    const type = res.headers["content-type"] ?? "application/json";
    return new Response(res.body, {
      status: res.statusCode,
      headers: { "content-type": String(type) },
    });
  };
}

/** The task client stand-in and the seed's dependencies around one app. */
function harness(app) {
  const calls = [];
  const chunks = [];
  const sink = {
    write: (chunk) => {
      chunks.push(String(chunk));
      return true;
    },
  };
  const run = async (args) => {
    calls.push(args);
    return JSON.stringify({ stored: NAMES });
  };
  const deps = { fetch: fetchFor(app), run, stdout: sink, stderr: sink };
  return { calls, deps, text: () => chunks.join("") };
}

const valueOf = (args, flag) => args.at(args.indexOf(flag) + 1);

describe("seed-accounts", () => {
  it("registers the owner, creates it, and prints only variable names", async () => {
    current = await testApp();
    const { calls, deps, text } = harness(current.app);
    const code = await main(["--base-url", DEV_URL, "--env", "dev"], deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(valueOf(args, "--action")).toBe("browser_account");
    expect(valueOf(args, "--label")).toBe("owner");
    expect(valueOf(args, "--env")).toBe("dev");
    expect(valueOf(args, "--repo")).toBe("dialwarden-app");
    const password = valueOf(args, "--password");
    expect(password).toHaveLength(24);
    expect(text()).toContain(NAMES[1]);
    expect(text()).not.toContain(password);

    // The owner signs in with the password the task client received.
    const login = await current.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: valueOf(args, "--email"), password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe("owner");
  });

  it("stops before registering anything when the owner exists", async () => {
    current = await testApp();
    await setupOwner(current.app);
    const { calls, deps, text } = harness(current.app);
    const code = await main(["--base-url", DEV_URL, "--env", "dev"], deps);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(text()).toContain("owner exists");
  });

  it("accepts only the Development or Stage host over https", () => {
    expect(checkBaseUrl(`${DEV_URL}/`, "dev")).toBe(DEV_URL);
    expect(checkBaseUrl(STAGE_URL, "stage")).toBe(STAGE_URL);
    const insecure = DEV_URL.replace("https:", "http:");
    expect(() => checkBaseUrl(insecure, "dev")).toThrow();
    expect(() => checkBaseUrl(STAGE_URL, "dev")).toThrow();
    const production = "https://dialwarden.theriark.com";
    expect(() => checkBaseUrl(production, "stage")).toThrow();
    expect(() => checkBaseUrl("not a url", "dev")).toThrow();
  });

  it("refuses any environment but dev and stage", async () => {
    const { deps, text } = harness(null);
    const args = ["--base-url", DEV_URL, "--env", "production"];
    expect(await main(args, deps)).toBe(2);
    expect(text()).toContain("--env must be dev or stage");
  });

  it("generates 24-character passwords from the allowed characters", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(24);
      for (const char of password) {
        expect(PASSWORD_ALPHABET).toContain(char);
      }
      seen.add(password);
    }
    expect(seen.size).toBe(200);
  });

  it("keeps only variable names from the task client answer", () => {
    const answer = JSON.stringify({ ok: true, names: NAMES, note: "an_email" });
    expect(variableNames(answer)).toEqual(NAMES);
  });
});
