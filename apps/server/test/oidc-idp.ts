// A fake OIDC identity provider for the P8-S OIDC tests (O-01 to O-31):
// node http on 127.0.0.1 with keys made per test, so a test can forge any
// token (alg none, HS256 key confusion, a header-supplied key, an unknown
// key, wrong claims). Tokens are signed with node:crypto, so no JOSE library
// is needed. Outside src/, so never built into the image; every key and
// value here is generated when the test runs.
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Signing =
  | "rs256"
  | "none"
  | "hs256-public-key"
  | "hs256-client-secret"
  | "header-key"
  | "unknown-key";

export interface IssueOptions {
  /** Claims over the defaults; a claim set to undefined is left out. */
  claims?: Record<string, unknown>;
  signing?: Signing;
}

interface Answer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface Pending {
  nonce: string;
  challenge: string;
  options: IssueOptions;
}

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function keyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function publicJwk(key: KeyObject, kid: string): Record<string, unknown> {
  return { ...key.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

export class FakeIdp {
  readonly clientId = "dialwarden";
  readonly clientSecret = randomBytes(24).toString("base64url");
  issuer = "";
  /** Token requests seen (O-04, O-07). */
  tokenRequests = 0;
  /** Requests to the attacker key server (O-14: must stay 0). */
  attackerRequests = 0;
  /** Discovery fields that replace the real ones (O-08, O-26). */
  discoveryOverride: Record<string, unknown> = {};
  /** Answer discovery with a redirect to this URL (O-26). */
  discoveryRedirect: string | null = null;
  /** Check the PKCE verifier at the token endpoint (O-07). */
  checkVerifier = true;
  readonly #key = keyPair();
  readonly #attackerKey = keyPair();
  /** The public key as PEM text: the HMAC key of the key-confusion forgery. */
  readonly #publicPem = this.#key.publicKey.export({
    format: "pem",
    type: "spki",
  });
  readonly #pending = new Map<string, Pending>();
  readonly #server = createServer((request, response) => {
    void this.#handle(request).then(
      ({ status, body, headers }) => {
        response.writeHead(status, {
          "content-type": "application/json",
          ...headers,
        });
        response.end(body);
      },
      () => {
        response.writeHead(500).end();
      },
    );
  });
  readonly #attacker = createServer((_request, response) => {
    this.attackerRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ keys: [publicJwk(this.#attackerKey.publicKey, "x")] }),
    );
  });
  #attackerUrl = "";

  async start(): Promise<this> {
    this.issuer = `http://127.0.0.1:${String(await listen(this.#server))}`;
    const port = await listen(this.#attacker);
    this.#attackerUrl = `http://127.0.0.1:${String(port)}`;
    return this;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#attacker.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => this.#server.close(resolve)),
      new Promise((resolve) => this.#attacker.close(resolve)),
    ]);
  }

  /** A code for the sign-in the authorization URL started. */
  code(authorization: URL, options: IssueOptions = {}): string {
    const code = randomBytes(16).toString("base64url");
    this.#pending.set(code, {
      nonce: authorization.searchParams.get("nonce") ?? "",
      challenge: authorization.searchParams.get("code_challenge") ?? "",
      options,
    });
    return code;
  }

  #discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      ...this.discoveryOverride,
    };
  }

  /** The ID token of a pending sign-in, signed as the test asks. */
  idToken(pending: Pending): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      sub: "sso-user-1",
      aud: this.clientId,
      exp: now + 300,
      iat: now,
      nonce: pending.nonce,
      email: "sso-user@dialwarden.test",
      email_verified: true,
      name: "SSO User",
      groups: ["dw-editors"],
      ...pending.options.claims,
    };
    for (const [name, value] of Object.entries(claims)) {
      if (value === undefined) Reflect.deleteProperty(claims, name);
    }
    const signing = pending.options.signing ?? "rs256";
    const rsa = (key: KeyObject, header: Record<string, unknown>) => {
      const input = `${b64(header)}.${b64(claims)}`;
      const signature = sign("sha256", Buffer.from(input), key);
      return `${input}.${signature.toString("base64url")}`;
    };
    const hmac = (secret: string | Buffer) => {
      const header = b64({ alg: "HS256", typ: "JWT", kid: "k1" });
      const input = `${header}.${b64(claims)}`;
      const mac = createHmac("sha256", secret).update(input).digest();
      return `${input}.${mac.toString("base64url")}`;
    };
    switch (signing) {
      case "none":
        return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
      case "hs256-public-key":
        return hmac(this.#publicPem);
      case "hs256-client-secret":
        return hmac(this.clientSecret);
      case "header-key":
        return rsa(this.#attackerKey.privateKey, {
          alg: "RS256",
          typ: "JWT",
          kid: "x",
          jku: `${this.#attackerUrl}/jwks`,
          jwk: publicJwk(this.#attackerKey.publicKey, "x"),
        });
      case "unknown-key":
        return rsa(this.#attackerKey.privateKey, { alg: "RS256", kid: "x" });
      case "rs256":
        return rsa(this.#key.privateKey, { alg: "RS256", kid: "k1" });
    }
  }

  async #handle(request: IncomingMessage): Promise<Answer> {
    const path = new URL(request.url ?? "/", this.issuer).pathname;
    if (path === "/.well-known/openid-configuration") {
      if (this.discoveryRedirect !== null) {
        return {
          status: 302,
          body: "",
          headers: { location: this.discoveryRedirect },
        };
      }
      return { status: 200, body: JSON.stringify(this.#discovery()) };
    }
    if (path === "/jwks") {
      const keys = [publicJwk(this.#key.publicKey, "k1")];
      return { status: 200, body: JSON.stringify({ keys }) };
    }
    if (path === "/token" && request.method === "POST") {
      this.tokenRequests += 1;
      const form = new URLSearchParams(await bodyOf(request));
      const refused = { status: 400, body: '{"error":"invalid_grant"}' };
      if (form.get("client_id") !== this.clientId) return refused;
      if (form.get("client_secret") !== this.clientSecret) return refused;
      const code = form.get("code") ?? "";
      const pending = this.#pending.get(code);
      this.#pending.delete(code);
      if (pending === undefined) return refused;
      const verifier = form.get("code_verifier") ?? "";
      const hashed = createHash("sha256").update(verifier).digest("base64url");
      if (this.checkVerifier && hashed !== pending.challenge) return refused;
      return {
        status: 200,
        body: JSON.stringify({
          access_token: randomBytes(16).toString("base64url"),
          token_type: "Bearer",
          expires_in: 300,
          id_token: this.idToken(pending),
        }),
      };
    }
    return { status: 404, body: '{"error":"not_found"}' };
  }
}
