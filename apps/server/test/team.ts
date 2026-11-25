// Test helpers for the team layer (P8-A) and the P8-S threat tests: a Paid
// test app, the Free switch, users made through the real invitation path,
// and the common fixture of p8-threat-specs (O owner, A admin, E editor with
// a write grant on demo-a, V viewer with a read grant on demo-a, E2 editor
// without grants; servers demo-a and demo-b). Outside src/, so never built
// into the image. Every credential here is generated when the test runs.
import { customerLicence } from "@dialwarden/entitlement/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  headersOf,
  randomPassword,
  sessionCookie,
  setupOwner,
  tempDir,
  testApp,
  type SignedIn,
  type TestApp,
} from "./helpers.js";
import { addServer, apiOf, palworldFolder } from "./servers.js";

export type BuildInput = Parameters<typeof testApp>[0];

/** A test app on Paid: the environment licence of a test customer. */
export async function paidApp(options: BuildInput = {}): Promise<TestApp> {
  const extraEnv = {
    DIALWARDEN_LICENCE: customerLicence(),
    ...options.extraEnv,
  };
  return testApp({ ...options, extraEnv });
}

async function freeSwitch(
  app: FastifyInstance,
  owner: SignedIn,
  ignored: boolean,
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: "/api/v1/licence/environment",
    headers: headersOf(owner),
    payload: { ignored },
  });
  if (response.statusCode !== 200) {
    throw new Error(`free switch: ${response.statusCode} ${response.body}`);
  }
}

/** The owner's switch "Use the Free plan on this instance" on. */
export const toFree = (app: FastifyInstance, owner: SignedIn) =>
  freeSwitch(app, owner, true);

/** The owner's switch off again: Paid from the environment licence. */
export const toPaid = (app: FastifyInstance, owner: SignedIn) =>
  freeSwitch(app, owner, false);

export interface Grant {
  server: string;
  level: "read" | "write";
}

export interface Member extends SignedIn {
  email: string;
  password: string;
  name: string;
}

let counter = 0;

/** A made-up address on the reserved test domain. */
export function testEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}-${Date.now().toString(36)}@dialwarden.test`;
}

/** POST /api/v1/invitations; the whole response. */
export function invite(
  app: FastifyInstance,
  inviter: SignedIn,
  body: { email: string; role: string; grants?: Grant[] },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/v1/invitations",
    headers: headersOf(inviter),
    payload: body,
  });
}

/** POST /api/v1/invitations/accept without a session; the response. */
export function accept(
  app: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/v1/invitations/accept",
    headers,
    payload: body,
  });
}

/** A signed-in user made through the invitation API. */
export async function inviteAndAccept(
  app: FastifyInstance,
  inviter: SignedIn,
  role: string,
  grants: Grant[] = [],
  name = role,
): Promise<Member> {
  const email = testEmail(role);
  const made = await invite(app, inviter, { email, role, grants });
  if (made.statusCode !== 201) {
    throw new Error(`invite: ${made.statusCode} ${made.body}`);
  }
  const token = made.json<{ token: string }>().token;
  const password = randomPassword();
  const done = await accept(app, { token, name, password });
  if (done.statusCode !== 201) {
    throw new Error(`accept: ${done.statusCode} ${done.body}`);
  }
  const body = done.json<{ csrfToken: string; user: { id: string } }>();
  return {
    cookie: sessionCookie(done),
    csrf: body.csrfToken,
    userId: body.user.id,
    email,
    password,
    name,
  };
}

/** Signs a user in again; a new session. */
export async function signIn(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<SignedIn> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<{ csrfToken: string; user: { id: string } }>();
  return {
    cookie: sessionCookie(response),
    csrf: body.csrfToken,
    userId: body.user.id,
  };
}

/** A signed-in request of a user (or anonymous with null). */
export function call(
  app: FastifyInstance,
  user: SignedIn | null,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> {
  const headers = user === null ? {} : headersOf(user);
  if (payload === undefined) return app.inject({ method, url, headers });
  return app.inject({ method, url, headers, payload });
}

export interface TeamFixture {
  current: TestApp;
  app: FastifyInstance;
  base: string;
  owner: SignedIn & { email: string; password: string };
  admin: Member;
  editor: Member;
  viewer: Member;
  /** An editor without any grant. */
  loner: Member;
  /** demo-a: E writes, V reads. demo-b: neither has a grant. */
  servers: { a: string; b: string; rootA: string; rootB: string };
}

/** The common fixture of p8-threat-specs, on a Paid app. */
export async function teamFixture(
  options: BuildInput = {},
): Promise<TeamFixture> {
  const current = await paidApp(options);
  const { app } = current;
  const base = await tempDir("dialwarden-team-");
  const owner = await setupOwner(app);
  const api = apiOf(app, owner);
  const rootA = await palworldFolder(base, "a");
  const rootB = await palworldFolder(base, "b");
  const a = await addServer(api, "demo-a", rootA);
  const b = await addServer(api, "demo-b", rootB);
  const admin = await inviteAndAccept(app, owner, "admin");
  const editor = await inviteAndAccept(app, owner, "editor", [
    { server: a, level: "write" },
  ]);
  const viewer = await inviteAndAccept(app, owner, "viewer", [
    { server: a, level: "read" },
  ]);
  const loner = await inviteAndAccept(app, owner, "editor", [], "loner");
  return {
    current,
    app,
    base,
    owner,
    admin,
    editor,
    viewer,
    loner,
    servers: { a, b, rootA, rootB },
  };
}

/** The first integer setting of the Palworld pack, for change sets. */
export const INT_SETTING = "ServerPlayerMaxNum";
