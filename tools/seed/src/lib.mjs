// Seed accounts (dev-work-plan P1-A step 9, references/test-accounts.md).
// 1. GET /api/v1/setup must say that first-run setup is still open.
// 2. The account is registered with the task client action browser_account
//    (label owner), so the pair is stored before the owner exists.
// 3. POST /api/v1/setup creates the owner.
// The password (24 characters from letters, digits and - _ . +) is generated
// in this process and handed only to the task client, as one argument of an
// argument list (no shell). It is never written to a file or a log; the tool
// prints only the variable names the task client answers with.
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";

export const PASSWORD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.+";
export const PASSWORD_LENGTH = 24;
export const SEED_ENVIRONMENTS = ["dev", "stage"];
export const TASK_CLIENT = "/opt/pi-crews/shared/theriark_crew_task_client.py";
export const DEFAULT_EMAIL = "owner@dialwarden.test";
export const DEFAULT_REPO = "dialwarden-app";

const USAGE =
  "usage: node tools/seed/seed-accounts.mjs --base-url https://app-dev-dialwarden.theriark.dev --env dev|stage [--email ADDRESS] [--repo NAME]";
const VARIABLE_NAME = /\b[A-Z][A-Z0-9_]*_(?:EMAIL|PASSWORD)\b/g;

export class SeedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeedError";
  }
}

export function generatePassword(length = PASSWORD_LENGTH) {
  let password = "";
  for (let i = 0; i < length; i += 1) {
    password += PASSWORD_ALPHABET.charAt(randomInt(PASSWORD_ALPHABET.length));
  }
  return password;
}

/** The only hosts the seed tool talks to. */
export const SEED_HOSTS = {
  dev: "app-dev-dialwarden.theriark.dev",
  stage: "app-stg-dialwarden.theriark.dev",
};

/** Development or Stage only: https, the exact host and no port. */
export function checkBaseUrl(value, env) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SeedError("--base-url must be a URL");
  }
  const host = env === "dev" ? SEED_HOSTS.dev : SEED_HOSTS.stage;
  const ok =
    url.protocol === "https:" &&
    url.hostname === host &&
    url.port === "" &&
    url.username === "" &&
    url.password === "";
  if (!ok) {
    throw new SeedError(`--base-url for --env ${env} must be https://${host}`);
  }
  return url.origin;
}

export function parseSeedArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string" },
      env: { type: "string" },
      email: { type: "string" },
      repo: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!SEED_ENVIRONMENTS.includes(values.env)) {
    throw new SeedError("--env must be dev or stage");
  }
  if (values["base-url"] === undefined) {
    throw new SeedError("--base-url is required");
  }
  return {
    env: values.env,
    baseUrl: checkBaseUrl(values["base-url"], values.env),
    email: values.email ?? DEFAULT_EMAIL,
    repo: values.repo ?? DEFAULT_REPO,
  };
}

/** The variable names in the task client's answer; nothing else is printed. */
export function variableNames(text) {
  return [...new Set(text.match(VARIABLE_NAME) ?? [])];
}

async function requestJson(fetchImpl, url, init, timeoutMs) {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** Step 1: first-run setup must still be open on the instance. */
export async function setupOpen(baseUrl, fetchImpl, timeoutMs = 15_000) {
  const url = `${baseUrl}/api/v1/setup`;
  const state = await requestJson(fetchImpl, url, { method: "GET" }, timeoutMs);
  if (state.status !== 200) {
    throw new SeedError(`GET /api/v1/setup answered ${state.status}`);
  }
  return state.body?.required === true;
}

/** Step 3: creates the owner through POST /api/v1/setup. */
export async function createOwner(options) {
  const { baseUrl, email, password, fetchImpl } = options;
  const created = await requestJson(
    fetchImpl,
    `${baseUrl}/api/v1/setup`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: "Owner (seed)" }),
    },
    options.timeoutMs ?? 15_000,
  );
  if (created.status !== 201) {
    const error = created.body?.error;
    const code = typeof error === "string" ? error : "unknown";
    throw new SeedError(
      `POST /api/v1/setup answered ${created.status} (${code})`,
    );
  }
}

/** Runs the task client with an argument list; resolves with its output. */
export function runTaskClient(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line security/detect-child-process -- a fixed program and an argument list, no shell
    execFile(
      "python3",
      [TASK_CLIENT, ...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new SeedError("browser_account failed"));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** Step 2: stores the pair with browser_account; returns the variable names. */
export async function registerAccount(options) {
  const { env, repo, label, email, password, run } = options;
  const output = await run([
    "--action",
    "browser_account",
    "--repo",
    repo,
    "--env",
    env,
    "--label",
    label,
    "--email",
    email,
    "--password",
    password,
  ]);
  return variableNames(output);
}

/**
 * Seeds the owner. deps (tests): fetch, run (the task client), stdout, stderr.
 * Exit codes: 0 done, 1 the seed failed, 2 a usage error.
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetchImpl = deps.fetch ?? fetch;
  let options;
  try {
    options = parseSeedArgs(argv);
  } catch (error) {
    stderr.write(`seed: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  const { baseUrl, env, email, repo } = options;
  try {
    if (!(await setupOpen(baseUrl, fetchImpl))) {
      throw new SeedError(
        "the owner exists already: the seed runs only before first-run setup",
      );
    }
    const password = generatePassword();
    const names = await registerAccount({
      env,
      repo,
      label: "owner",
      email,
      password,
      run: deps.run ?? runTaskClient,
    });
    await createOwner({ baseUrl, email, password, fetchImpl });
    const listed = names.length > 0 ? names.join(" ") : "(no names returned)";
    stdout.write(`seed: owner created on ${baseUrl}; registered ${listed}\n`);
    return 0;
  } catch (error) {
    stderr.write(`seed: ${String(error.message).slice(0, 300)}\n`);
    return 1;
  }
}
