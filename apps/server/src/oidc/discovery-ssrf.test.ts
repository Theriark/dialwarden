// The OIDC network policy (P8-S threat specs O-24 to O-26, R&D decision
// rnd-decision-p8a Q3): the identity provider URL typed by the owner never
// makes the server reach itself, the cloud metadata service or the local
// network. These tests run the real policy; only the resolver is a stub, and
// no test opens a connection to a refused address.
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  headersOf,
  setupOwner,
  type SignedIn,
  type TestApp,
} from "../../test/helpers.js";
import { FakeIdp } from "../../test/oidc-idp.js";
import { paidApp } from "../../test/team.js";
import {
  checkUrl,
  pinnedLookup,
  policyOf,
  type OidcNetworkOptions,
} from "./network.js";

/** The stub resolver: names of the tests only, never the real DNS. */
const NAMES = new Map([
  ["metadata.google.internal", ["169.254.169.254"]],
  ["idp.example", ["93.184.216.34"]],
  ["mixed.example", ["93.184.216.34", "10.0.0.5"]],
]);

const stubResolver = async (host: string): Promise<string[]> => {
  const found = NAMES.get(host);
  if (found === undefined) throw new Error(`unknown test name ${host}`);
  return found;
};

const REFUSED = [
  "http://169.254.169.254/latest",
  "https://169.254.169.254",
  "https://[fe80::1]",
  "https://[::ffff:169.254.169.254]",
  "https://metadata.google.internal",
  "https://127.0.0.1",
  "https://[::1]",
  "https://0.0.0.0",
  "https://2130706433",
  "https://0x7f.1",
  "https://127.1",
  "https://10.0.0.5",
  "https://192.168.1.10",
  "https://172.16.0.1",
  "https://100.64.0.1",
  "https://[fd00::1]",
  "http://idp.example",
  "https://mixed.example",
];

/** Allowed only with the owner's private-network setting (D10). */
const PRIVATE = [
  "https://10.0.0.5",
  "https://192.168.1.10",
  "https://172.16.0.1",
  "https://100.64.0.1",
  "https://[fd00::1]",
];

let current: TestApp | undefined;
let idp: FakeIdp | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await current?.close();
  await idp?.stop();
  current = undefined;
  idp = undefined;
});

async function appWith(
  network: OidcNetworkOptions,
): Promise<{ app: FastifyInstance; owner: SignedIn }> {
  current = await paidApp({
    extraEnv: { BASE_URL: "http://dw.test" },
    oidcNetwork: network,
  });
  const owner = await setupOwner(current.app);
  return { app: current.app, owner };
}

function put(
  app: FastifyInstance,
  owner: SignedIn,
  issuer: string,
  allowPrivateNetwork = false,
) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/settings/oidc",
    headers: headersOf(owner),
    payload: {
      enabled: true,
      issuer,
      clientId: "dialwarden",
      roleMapping: { "dw-admins": "admin" },
      allowPrivateNetwork,
    },
  });
}

describe("OIDC network policy (O-24)", () => {
  it("refuses every internal, numeric loopback and plain http issuer", async () => {
    const { app, owner } = await appWith({ resolve: stubResolver });
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    for (const issuer of REFUSED) {
      const response = await put(app, owner, issuer);
      expect(response.statusCode, issuer).toBe(422);
      expect(response.json(), issuer).toMatchObject({
        error: "oidc_url_refused",
      });
    }
    expect(connect).not.toHaveBeenCalled();
    expect(app.ctx.oidc.view().configured).toBe(false);
  });

  it("lets private addresses pass only with the owner's setting", async () => {
    const strict = policyOf(false, { resolve: stubResolver });
    const open = policyOf(true, { resolve: stubResolver });
    for (const url of PRIVATE) {
      await expect(checkUrl(url, strict), url).rejects.toThrow();
      await expect(checkUrl(url, open), url).resolves.toBeDefined();
    }
    for (const url of REFUSED.filter((item) => !PRIVATE.includes(item))) {
      if (url === "https://mixed.example") continue;
      await expect(checkUrl(url, open), url).rejects.toThrow();
    }
  });

  it("parses numeric host forms before the check", async () => {
    const policy = policyOf(false, { resolve: stubResolver });
    for (const url of ["https://2130706433", "https://0x7f.1"]) {
      await expect(checkUrl(url, policy)).rejects.toThrow(
        "address not allowed",
      );
    }
    const allowed = await checkUrl("https://93.184.216.34/x", policy);
    expect(allowed.addresses).toEqual(["93.184.216.34"]);
  });
});

describe("DNS rebinding (O-25)", () => {
  it("resolves once and connects only to the checked address", async () => {
    const answers = [["93.184.216.34"], ["169.254.169.254"]];
    let calls = 0;
    const policy = policyOf(false, {
      resolve: async () => {
        const answer = answers[Math.min(calls, 1)] ?? [];
        calls += 1;
        return answer;
      },
    });
    const { addresses } = await checkUrl("https://rebind.example", policy);
    expect(addresses).toEqual(["93.184.216.34"]);
    const lookup = pinnedLookup(addresses);
    const seen: string[] = [];
    lookup("rebind.example", {}, (error, address) => {
      expect(error).toBeNull();
      seen.push(String(address));
    });
    lookup("rebind.example", { all: true }, (error, address) => {
      expect(error).toBeNull();
      seen.push(JSON.stringify(address));
    });
    expect(seen).toEqual([
      "93.184.216.34",
      JSON.stringify([{ address: "93.184.216.34", family: 4 }]),
    ]);
    expect(calls).toBe(1);
  });
});

describe("endpoints named by discovery, and redirects (O-26)", () => {
  const loopback = { allowLoopback: true, allowHttp: true };

  it("refuses link-local jwks and token endpoints at configuration", async () => {
    idp = await new FakeIdp().start();
    const { app, owner } = await appWith(loopback);
    for (const field of ["jwks_uri", "token_endpoint"]) {
      idp.discoveryOverride = { [field]: "http://169.254.169.254/x" };
      const response = await put(app, owner, idp.issuer);
      expect(response.statusCode, field).toBe(422);
      expect(response.json()).toMatchObject({ error: "oidc_url_refused" });
    }
  });

  it("never follows a redirect of the discovery URL", async () => {
    idp = await new FakeIdp().start();
    const { app, owner } = await appWith(loopback);
    idp.discoveryRedirect = "http://169.254.169.254/latest";
    const response = await put(app, owner, idp.issuer);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: "oidc_url_refused" });
  });

  it("applies the policy again at sign-in", async () => {
    idp = await new FakeIdp().start();
    const { app, owner } = await appWith(loopback);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/oidc",
      headers: headersOf(owner),
      payload: {
        enabled: true,
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        roleMapping: { "dw-editors": "editor" },
        allowPrivateNetwork: false,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // The stored endpoint is changed behind the check (a later discovery).
    const stored = app.ctx.settings.get("oidc.settings") as {
      metadata: Record<string, unknown>;
    };
    app.ctx.settings.set("oidc.settings", {
      ...stored,
      metadata: {
        ...stored.metadata,
        token_endpoint: "http://169.254.169.254/token",
      },
    });
    const started = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/start",
    });
    const location = new URL(String(started.headers.location));
    const cookie = started.cookies.find((item) => item.name === "dw_oidc");
    const code = idp.code(location);
    const state = location.searchParams.get("state") ?? "";
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=${code}&state=${state}`,
      headers: { cookie: `dw_oidc=${cookie?.value ?? ""}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "oidc_token_invalid" });
    expect(idp.tokenRequests).toBe(0);
  });
});
