// tools/seed (dev-work-plan P1-A step 9, P8-A step 10). The owner, and with
// --team the admin, editor and viewer, are created against a real app
// (in-process, through inject); the task client is a stand-in that records
// its arguments.
import { afterEach, describe, expect, it } from "vitest";
import {
  headersOf,
  setupOwner,
  setupTokenOf,
  tempDir,
  testApp,
} from "../../../apps/server/test/helpers.ts";
import {
  addServer,
  apiOf,
  palworldFolder,
} from "../../../apps/server/test/servers.ts";
import { paidApp } from "../../../apps/server/test/team.ts";
import {
  checkBaseUrl,
  generatePassword,
  main,
  PASSWORD_ALPHABET,
  SeedError,
  variableNames,
} from "./lib.mjs";

const DEV_URL = "https://dev-dialwarden.theriark.dev";
const STAGE_URL = "https://stg-dialwarden.theriark.dev";
const NAMES = ["DIALWARDEN_DEV_OWNER_EMAIL", "DIALWARDEN_DEV_OWNER_PASSWORD"];
/** A token of the right form that no app holds. */
const UNKNOWN_TOKEN = "0".repeat(64);
let current;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** fetch for the seed, answered by the app through inject; keeps requests. */
function fetchFor(app, requests = []) {
  return async (url, init = {}) => {
    const { pathname } = new URL(url);
    requests.push({ method: init.method ?? "GET", pathname, init });
    const res = await app.inject({
      method: init.method ?? "GET",
      url: pathname,
      headers: init.headers,
      payload: init.body,
    });
    const type = res.headers["content-type"] ?? "application/json";
    const headers = new Headers({ "content-type": String(type) });
    for (const cookie of [res.headers["set-cookie"] ?? []].flat()) {
      headers.append("set-cookie", String(cookie));
    }
    return new Response(res.body, { status: res.statusCode, headers });
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
  const requests = [];
  const deps = {
    fetch: fetchFor(app, requests),
    run,
    stdout: sink,
    stderr: sink,
    env: {},
  };
  return { calls, deps, requests, text: () => chunks.join("") };
}

const valueOf = (args, flag) => args.at(args.indexOf(flag) + 1);

describe("seed-accounts", () => {
  it("registers the owner, creates it, and prints only variable names", async () => {
    current = await testApp();
    const { calls, deps, requests, text } = harness(current.app);
    const token = setupTokenOf(current.app);
    const args = ["--base-url", DEV_URL, "--env", "dev"];
    const code = await main([...args, "--setup-token", token], deps);
    expect(code).toBe(0);
    // Threat test T4.6 (THE-2134): the setup call carries the setup token.
    const post = requests.find((request) => request.method === "POST");
    expect(post?.init.headers["x-dialwarden-setup-token"]).toBe(token);
    expect(text()).not.toContain(token);
    expect(calls).toHaveLength(1);
    const sent = calls[0];
    expect(valueOf(sent, "--action")).toBe("browser_account");
    expect(valueOf(sent, "--label")).toBe("owner");
    expect(valueOf(sent, "--env")).toBe("dev");
    expect(valueOf(sent, "--repo")).toBe("dialwarden");
    const password = valueOf(sent, "--password");
    expect(password).toHaveLength(24);
    expect(text()).toContain(NAMES[1]);
    expect(text()).not.toContain(password);

    // The owner signs in with the password the task client received.
    const login = await current.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: valueOf(sent, "--email"), password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe("owner");
  });

  it("stops before registering anything when the owner exists", async () => {
    current = await testApp();
    await setupOwner(current.app);
    const { calls, deps, text } = harness(current.app);
    deps.env = { DIALWARDEN_SETUP_TOKEN: UNKNOWN_TOKEN };
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

  // Threat tests T10 (THE-2134): a look-alike host or a port never receives
  // the new owner password.
  it("refuses look-alike hosts and ports", () => {
    const lookAlikes = [
      "https://dev-dialwarden.example.net",
      "https://dev-x.evil.example",
      "https://dev-dialwarden.theriark.dev.evil.example",
      `${DEV_URL}:8443`,
    ];
    for (const url of lookAlikes) {
      expect(() => checkBaseUrl(url, "dev"), url).toThrow(SeedError);
    }
    expect(() => checkBaseUrl(STAGE_URL, "dev")).toThrow(SeedError);
    expect(checkBaseUrl(DEV_URL, "dev")).toBe(DEV_URL);
  });

  it("stops before any request without a setup token", async () => {
    const { calls, deps, requests, text } = harness(null);
    const code = await main(["--base-url", STAGE_URL, "--env", "stage"], deps);
    expect(code).toBe(2);
    expect(text()).toContain("setup token is required");
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
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

  it("adds admin, editor and viewer as the owner and prints no password", async () => {
    current = await paidApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const api = apiOf(app, owner);
    const base = await tempDir("dialwarden-seed-");
    const servers = [];
    for (const name of ["demo-e", "demo-d", "demo-c", "demo-b", "demo-a"]) {
      servers.push(
        await addServer(api, name, await palworldFolder(base, name)),
      );
    }
    const { calls, deps, requests, text } = harness(app);
    deps.env = {
      DIALWARDEN_DEV_OWNER_EMAIL: owner.email,
      DIALWARDEN_DEV_OWNER_PASSWORD: owner.password,
    };
    const args = ["--base-url", DEV_URL, "--env", "dev", "--team"];
    const code = await main(args, deps);
    expect(code, text()).toBe(0);
    // L10: the owner session the tool opened ends with the run.
    const last = requests.at(-1);
    expect(last?.method).toBe("POST");
    expect(last?.pathname).toBe("/api/v1/auth/logout");
    const ended = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: last?.init.headers.cookie },
    });
    expect(ended.statusCode).toBe(401);
    const labels = calls.map((sent) => valueOf(sent, "--label"));
    expect(labels).toEqual(["admin", "editor", "viewer"]);
    expect(text()).not.toContain(owner.password);
    for (const sent of calls) {
      const password = valueOf(sent, "--password");
      expect(password).toHaveLength(24);
      expect(text()).not.toContain(password);
      expect(valueOf(sent, "--email")).toMatch(/@dialwarden\.test$/);
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: valueOf(sent, "--email"), password },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().user.role).toBe(valueOf(sent, "--label"));
    }
    const users = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      headers: headersOf(owner),
    });
    const grantsOf = (role) =>
      users.json().items.find((user) => user.role === role).grants;
    const four = [...servers].sort().slice(0, 4);
    expect(grantsOf("editor")).toEqual(
      four.map((server) => ({ server, level: "write" })),
    );
    expect(grantsOf("viewer")).toEqual(
      four.map((server) => ({ server, level: "read" })),
    );
    expect(grantsOf("admin")).toEqual([]);

    // phase-report-09 G3: the in-app channel is made once.
    expect(text()).toContain("in-app channel made");
    const inApp = () =>
      app.ctx.channels.list().filter((channel) => channel.kind === "in_app");
    expect(inApp()).toHaveLength(1);

    // A second run leaves the accounts alone and registers nothing.
    const again = harness(app);
    again.deps.env = deps.env;
    expect(await main(args, again.deps)).toBe(0);
    expect(again.calls).toHaveLength(0);
    expect(again.text()).toContain("exists already");
    expect(again.text()).toContain("in-app channel present");
    expect(inApp()).toHaveLength(1);
  });

  // phase-report-08 F6: the owner pair passed in, the password on stdin.
  it("takes the owner pair from --owner-email and standard input", async () => {
    current = await paidApp();
    const { app } = current;
    const owner = await setupOwner(app);
    const { calls, deps, text } = harness(app);
    deps.env = {};
    deps.readStdin = async () => owner.password;
    const args = [
      "--base-url",
      DEV_URL,
      "--env",
      "dev",
      "--team",
      "--owner-email",
      owner.email,
      "--owner-password-stdin",
    ];
    expect(await main(args, deps), text()).toBe(0);
    expect(calls.map((sent) => valueOf(sent, "--label"))).toEqual([
      "admin",
      "editor",
      "viewer",
    ]);
    expect(text()).not.toContain(owner.password);
    // The flags belong to --team, and the password needs the address.
    const plain = harness(null);
    const stray = ["--base-url", DEV_URL, "--env", "dev", "--owner-email", "x"];
    expect(await main(stray, plain.deps)).toBe(2);
    expect(plain.text()).toContain("need --team");
    const alone = harness(null);
    const noEmail = ["--base-url", DEV_URL, "--env", "dev", "--team"];
    noEmail.push("--owner-password-stdin");
    expect(await main(noEmail, alone.deps)).toBe(2);
    expect(alone.requests).toHaveLength(0);
  });

  it("needs the registered owner variables for --team", async () => {
    const { calls, deps, requests, text } = harness(null);
    const args = ["--base-url", DEV_URL, "--env", "dev", "--team"];
    expect(await main(args, deps)).toBe(2);
    expect(text()).toContain("DIALWARDEN_DEV_OWNER_EMAIL");
    expect(requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("keeps only variable names from the task client answer", () => {
    const answer = JSON.stringify({ ok: true, names: NAMES, note: "an_email" });
    expect(variableNames(answer)).toEqual(NAMES);
  });
});
