// Seed accounts (dev-work-plan P1-A step 9, references/test-accounts.md, R&D
// decision THE-2141). On Development the owner is created at start from
// DEV_SEED_OWNER_EMAIL and DEV_SEED_OWNER_PASSWORD (deploy/dokploy.json), so
// this tool creates the owner only on Stage (operator item 11) and in tests:
// 1. GET /api/v1/setup must say that first-run setup is still open.
// 2. The account is registered with the task client action browser_account
//    (label owner), so the pair is stored before the owner exists.
// 3. POST /api/v1/setup creates the owner, with the one-time setup token
//    (--setup-token or DIALWARDEN_SETUP_TOKEN, read by the operator from
//    DATA_DIR/setup-token or the start log) in X-Dialwarden-Setup-Token.
// The password (24 characters from letters, digits and - _ . +) is generated
// in this process and handed only to the task client, as one argument of an
// argument list (no shell). Neither it nor the setup token is ever written to
// a file or a log; the tool prints only the variable names the task client
// answers with.
//
// With --team (dev-work-plan P8-A step 10) the tool adds the admin, editor and
// viewer test accounts through the invitation API instead, signed in as the
// owner from the registered DIALWARDEN_DEV_OWNER_EMAIL and
// DIALWARDEN_DEV_OWNER_PASSWORD (DIALWARDEN_STAGE_OWNER_* with --env stage,
// which the operator runs after Gate 2; the crew never does). The editor gets
// write grants and the viewer read grants on the first four demo servers.
// Each password is generated here, registered with browser_account (labels
// admin, editor and viewer) and used once to accept the invitation; the
// invitation value and the session never leave this process either.
//
// P10 (phase-report-08 F6): the owner pair can also be passed in, so the
// tool runs where those variables are not set: --owner-email ADDRESS and
// --owner-password-stdin, which reads the password from the first line of
// standard input (never an argument, so it stays out of the process list).
// The operator runs it, for example with the password manager piping the
// pair; the crew never holds the owner password and adds team accounts in
// the browser instead. --team also makes the in-app notification channel
// when the instance has none (phase-report-09 G3), so the bell is not
// empty. Invitations and channels are Paid: on Free --team stops at the
// first invitation (402, exit 1) and the channel step answers skipped.
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";

export const PASSWORD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.+";
export const PASSWORD_LENGTH = 24;
export const SEED_ENVIRONMENTS = ["dev", "stage"];
export const TASK_CLIENT = "/opt/pi-crews/shared/theriark_crew_task_client.py";
export const DEFAULT_EMAIL = "owner@dialwarden.test";
export const DEFAULT_REPO = "dialwarden";

const USAGE =
  "usage: node tools/seed/seed-accounts.mjs --base-url https://stg-dialwarden.theriark.dev --env stage|dev --setup-token TOKEN [--email ADDRESS] [--repo NAME] (or DIALWARDEN_SETUP_TOKEN in the environment), or --team instead of the setup token to add admin, editor, viewer and the in-app channel [--owner-email ADDRESS --owner-password-stdin]";
const SETUP_TOKEN = /^[0-9a-f]{64}$/;
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
  dev: "dev-dialwarden.theriark.dev",
  stage: "stg-dialwarden.theriark.dev",
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

export function parseSeedArgs(argv, env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string" },
      env: { type: "string" },
      email: { type: "string" },
      repo: { type: "string" },
      "setup-token": { type: "string" },
      team: { type: "boolean" },
      "owner-email": { type: "string" },
      "owner-password-stdin": { type: "boolean" },
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
  const baseUrl = checkBaseUrl(values["base-url"], values.env);
  const repo = values.repo ?? DEFAULT_REPO;
  const ownerEmail = values["owner-email"];
  const ownerPasswordStdin = values["owner-password-stdin"] === true;
  if (values.team !== true && (ownerEmail || ownerPasswordStdin)) {
    throw new SeedError("--owner-email and --owner-password-stdin need --team");
  }
  if (ownerPasswordStdin && !ownerEmail) {
    throw new SeedError("--owner-password-stdin needs --owner-email");
  }
  if (values.team === true) {
    return {
      env: values.env,
      baseUrl,
      repo,
      team: true,
      ownerEmail: ownerEmail ?? null,
      ownerPasswordStdin,
    };
  }
  const given = values["setup-token"] ?? env.DIALWARDEN_SETUP_TOKEN ?? "";
  const setupToken = given.trim();
  if (!SETUP_TOKEN.test(setupToken)) {
    throw new SeedError(
      "the setup token is required: --setup-token or DIALWARDEN_SETUP_TOKEN (64 hex characters from DATA_DIR/setup-token)",
    );
  }
  return {
    env: values.env,
    baseUrl,
    email: values.email ?? DEFAULT_EMAIL,
    repo,
    setupToken,
    team: false,
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
  const { baseUrl, email, password, setupToken, fetchImpl } = options;
  const created = await requestJson(
    fetchImpl,
    `${baseUrl}/api/v1/setup`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dialwarden-setup-token": setupToken,
      },
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
 * Seeds the owner. deps (tests): fetch, run (the task client), stdout, stderr,
 * env (where DIALWARDEN_SETUP_TOKEN is read; default process.env).
 * Exit codes: 0 done, 1 the seed failed, 2 a usage error.
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetchImpl = deps.fetch ?? fetch;
  let options;
  try {
    options = parseSeedArgs(argv, deps.env ?? process.env);
  } catch (error) {
    stderr.write(`seed: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.team) {
    return seedTeam(options, { ...deps, stdout, stderr, fetch: fetchImpl });
  }
  const { baseUrl, env, email, repo, setupToken } = options;
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
    await createOwner({ baseUrl, email, password, setupToken, fetchImpl });
    const listed = names.length > 0 ? names.join(" ") : "(no names returned)";
    stdout.write(`seed: owner created on ${baseUrl}; registered ${listed}\n`);
    return 0;
  } catch (error) {
    stderr.write(`seed: ${String(error.message).slice(0, 300)}\n`);
    return 1;
  }
}

// The team accounts of P8 (--team) -------------------------------------------

/** The made-up addresses on the reserved test domain, one per role. */
export const TEAM_ACCOUNTS = [
  { label: "admin", email: "admin@dialwarden.test", grant: null },
  { label: "editor", email: "editor@dialwarden.test", grant: "write" },
  { label: "viewer", email: "viewer@dialwarden.test", grant: "read" },
];

/** How many demo servers the editor and the viewer get grants on. */
export const TEAM_GRANT_SERVERS = 4;

/** The variables the owner was registered under (references/test-accounts). */
export function ownerVariables(env) {
  const prefix =
    env === "dev" ? "DIALWARDEN_DEV_OWNER" : "DIALWARDEN_STAGE_OWNER";
  return { email: `${prefix}_EMAIL`, password: `${prefix}_PASSWORD` };
}

/** The session cookie pair (name=value) of a sign-in answer. */
export function sessionPair(response) {
  const all =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  for (const line of all) {
    const pair = line.split(";")[0] ?? "";
    const name = pair.split("=")[0] ?? "";
    if (name === "dw_session" || name === "__Host-dw_session") return pair;
  }
  throw new SeedError("the sign-in answer carried no session cookie");
}

/** Signs the owner in; the cookie pair and the CSRF value of the session. */
export async function ownerSession(baseUrl, credentials, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || body?.status !== "ok") {
    const code = typeof body?.error === "string" ? body.error : body?.status;
    throw new SeedError(
      `the owner sign-in answered ${response.status} (${code ?? "unknown"})`,
    );
  }
  return { cookie: sessionPair(response), csrf: body.csrfToken };
}

/** The first line of standard input, at most 1 KiB (the owner password). */
export async function readStdinLine(stream = process.stdin, limit = 1024) {
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    if (text.length > limit) {
      throw new SeedError("standard input holds more than one short line");
    }
  }
  return (text.split(/\r?\n/)[0] ?? "").trim();
}

/** The C6 activity types the in-app channel receives (all of them). */
export const ACTIVITY_TYPES = [
  "change.applied",
  "change.pending",
  "change.conflict",
  "hook.run",
  "drift.detected",
  "schedule.run",
  "schedule.reverted",
  "backup.done",
  "backup.failed",
  "licence.changed",
  "user.changed",
];

/**
 * Makes the in-app notification channel when the instance has none
 * (phase-report-09 G3). Channels are Paid: on Free the step is skipped.
 * Answers what happened: made, present or skipped.
 */
export async function ensureInAppChannel(call) {
  const path = "/api/v1/notifications/channels";
  const listed = await call("GET", path);
  if (listed.status === 402) return "skipped (Free plan)";
  if (listed.status !== 200) {
    throw new SeedError(`GET ${path} answered ${listed.status}`);
  }
  const items = Array.isArray(listed.body?.items) ? listed.body.items : [];
  if (items.some((item) => item?.kind === "in_app")) return "present";
  const made = await call("POST", path, {
    name: "In-app",
    enabled: true,
    types: ACTIVITY_TYPES,
    settings: { kind: "in_app" },
  });
  if (made.status !== 201) {
    const code = made.body?.error ?? "unknown";
    throw new SeedError(`POST ${path} answered ${made.status} (${code})`);
  }
  return "made";
}

/** The first demo servers by id: the grants of the editor and the viewer. */
export function demoServers(items, count = TEAM_GRANT_SERVERS) {
  return items
    .map((item) => item.id)
    .filter((id) => typeof id === "string" && id.startsWith("demo-"))
    .sort()
    .slice(0, count);
}

/**
 * Adds admin, editor and viewer (--team). An account that exists already is
 * left alone (its password cannot be known again). Exit codes as main.
 */
export async function seedTeam(options, deps) {
  const { baseUrl, env, repo } = options;
  const { stdout, stderr } = deps;
  const fetchImpl = deps.fetch;
  const run = deps.run ?? runTaskClient;
  const variables = ownerVariables(env);
  const source = new Map(Object.entries(deps.env ?? process.env));
  let email = source.get(variables.email) ?? "";
  let password = source.get(variables.password) ?? "";
  if (options.ownerEmail) {
    email = options.ownerEmail;
    password = "";
  }
  if (options.ownerPasswordStdin) {
    try {
      password = await (deps.readStdin ?? readStdinLine)();
    } catch (error) {
      stderr.write(`seed: ${String(error.message).slice(0, 200)}\n`);
      return 2;
    }
  }
  if (email === "" || password === "") {
    stderr.write(
      `seed: the owner pair is required: --owner-email with --owner-password-stdin, or ${variables.email} and ${variables.password}\n`,
    );
    return 2;
  }
  let session = null;
  try {
    session = await ownerSession(baseUrl, { email, password }, fetchImpl);
    const call = (method, path, payload) =>
      requestJson(
        fetchImpl,
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            "content-type": "application/json",
            cookie: session.cookie,
            "x-csrf-token": session.csrf,
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        },
        15_000,
      );
    const listed = await call("GET", "/api/v1/servers");
    if (listed.status !== 200) {
      throw new SeedError(`GET /api/v1/servers answered ${listed.status}`);
    }
    const servers = demoServers(listed.body?.items ?? []);
    const done = [];
    const names = [];
    for (const account of TEAM_ACCOUNTS) {
      const grants =
        account.grant === null
          ? []
          : servers.map((server) => ({ server, level: account.grant }));
      const invited = await call("POST", "/api/v1/invitations", {
        email: account.email,
        role: account.label,
        grants,
      });
      if (invited.status === 409 && invited.body?.error === "user_exists") {
        stdout.write(`seed: ${account.label} exists already; left alone\n`);
        continue;
      }
      if (invited.status !== 201) {
        const code = invited.body?.error ?? "unknown";
        throw new SeedError(
          `inviting ${account.label} answered ${invited.status} (${code})`,
        );
      }
      const secret = generatePassword();
      const stored = await registerAccount({
        env,
        repo,
        label: account.label,
        email: account.email,
        password: secret,
        run,
      });
      names.push(...stored);
      const accepted = await requestJson(
        fetchImpl,
        `${baseUrl}/api/v1/invitations/accept`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: invited.body?.token,
            name: `${account.label} (seed)`,
            password: secret,
          }),
        },
        15_000,
      );
      if (accepted.status !== 201) {
        const code = accepted.body?.error ?? "unknown";
        throw new SeedError(
          `accepting ${account.label} answered ${accepted.status} (${code})`,
        );
      }
      done.push(account.label);
    }
    const channel = await ensureInAppChannel(call);
    const made = done.length > 0 ? done.join(", ") : "nobody new";
    const shown = names.length > 0 ? names.join(" ") : "(no names returned)";
    stdout.write(
      `seed: ${made} on ${baseUrl} (grants on ${servers.join(", ")}); in-app channel ${channel}; registered ${shown}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`seed: ${String(error.message).slice(0, 300)}\n`);
    return 1;
  } finally {
    // The owner session the tool opened ends with the run.
    if (session !== null) {
      await requestJson(
        fetchImpl,
        `${baseUrl}/api/v1/auth/logout`,
        {
          method: "POST",
          headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
        },
        15_000,
      ).catch(() => undefined);
    }
  }
}
