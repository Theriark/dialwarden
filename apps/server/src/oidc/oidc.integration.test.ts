// OIDC sign-in against a real OIDC provider in a testcontainer (dev-work-plan
// P8-A step 5): discovery, the authorization code flow with PKCE, the ID
// token signature and the group-to-role mapping, end to end. The container is
// started from the test code (no ci.yml change). The provider runs on the
// test host over http, which only the test-only BuildOptions.oidcNetwork seam
// allows.
import { existsSync } from "node:fs";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "../db/schema.js";
import {
  headersOf,
  sessionCookie,
  setupOwner,
  type TestApp,
} from "../../test/helpers.js";
import { paidApp } from "../../test/team.js";

const IMAGE = "ghcr.io/navikt/mock-oauth2-server:2.1.10";
const PORT = 8080;
const BASE_URL = "http://dw.test";

const dockerAvailable =
  existsSync("/var/run/docker.sock") ||
  (process.env["DOCKER_HOST"] ?? "") !== "" ||
  process.env["CI"] === "true";

/** No login form; every code carries the claims of this mapping. */
const PROVIDER_CONFIG = {
  interactiveLogin: false,
  tokenCallbacks: [
    {
      issuerId: "default",
      tokenExpiry: 120,
      requestMappings: [
        {
          requestParam: "grant_type",
          match: "authorization_code",
          claims: {
            sub: "container-user",
            email: "container-user@dialwarden.test",
            name: "Container User",
            groups: ["dw-viewers", "dw-admins"],
          },
        },
      ],
    },
  ],
};

let container: StartedTestContainer | undefined;
let current: TestApp | undefined;
let issuer = "";

describe.skipIf(!dockerAvailable)("OIDC against a provider container", () => {
  beforeAll(async () => {
    // Loaded here, so a run without Docker never loads testcontainers.
    const { GenericContainer, Wait } = await import("testcontainers");
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ JSON_CONFIG: JSON.stringify(PROVIDER_CONFIG) })
      .withExposedPorts(PORT)
      .withWaitStrategy(
        Wait.forHttp("/default/.well-known/openid-configuration", PORT),
      )
      .withStartupTimeout(180_000)
      .start();
    const host = container.getHost();
    const address = host === "localhost" ? "127.0.0.1" : host;
    issuer = `http://${address}:${String(container.getMappedPort(PORT))}/default`;
  }, 240_000);

  afterAll(async () => {
    await current?.close();
    await container?.stop();
  }, 60_000);

  it("signs a user in with the mapped role through the real flow", async () => {
    current = await paidApp({
      extraEnv: { BASE_URL },
      oidcNetwork: { allowLoopback: true, allowHttp: true },
    });
    const { app } = current;
    const owner = await setupOwner(app);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/oidc",
      headers: headersOf(owner),
      payload: {
        enabled: true,
        issuer,
        clientId: "dialwarden",
        clientSecret: "container-test-client",
        roleMapping: { "dw-admins": "admin", "dw-viewers": "viewer" },
        allowPrivateNetwork: false,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const started = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/start?returnTo=/users",
    });
    expect(started.statusCode, started.body).toBe(302);
    const transaction = started.cookies.find((c) => c.name === "dw_oidc");
    // The browser step: the provider answers the authorization request
    // with a redirect to the callback (no login form in this container).
    const authorize = await fetch(String(started.headers.location), {
      redirect: "manual",
    });
    expect(authorize.status).toBe(302);
    const back = new URL(authorize.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(
      `${BASE_URL}/api/v1/auth/oidc/callback`,
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback${back.search}`,
      headers: { cookie: `dw_oidc=${transaction?.value ?? ""}` },
    });
    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBe("/users");
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: sessionCookie(response) },
    });
    expect(session.json<{ user: { role: string } }>().user.role).toBe("admin");
    const row = app.ctx.store.db
      .select()
      .from(users)
      .all()
      .find((item) => item.oidcSubject === "container-user");
    expect(row?.oidcIssuer).toBe(issuer);
    expect(row?.email).toBe("container-user@dialwarden.test");
  });
});
