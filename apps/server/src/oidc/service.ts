// OIDC sign-in (dev-work-plan P8-A step 5, Paid feature oidc) with
// openid-client: discovery when the owner saves the settings, the
// authorization code flow with PKCE (S256), state and nonce, and the
// group-to-role mapping. Design points of p8-threat-specs: D10 (network
// policy, see network.ts), D11 (the identity is issuer plus subject), D12 (a
// SameSite Lax transaction cookie for the cross-site callback) and D13 (the
// mapping gives at most admin; only the owner configures OIDC and always keeps
// the local login).
//
// Every server-side request (discovery, token, keys) runs under the network
// policy, and the ID token signature is checked against the provider keys
// (non-repudiation checks), so a forged token never signs anyone in.
import { createHash, timingSafeEqual } from "node:crypto";
import type { EntitlementGate } from "@dialwarden/entitlement";
import * as client from "openid-client";
import type { Aead } from "../crypto/aead.js";
import type { Settings } from "../db/settings.js";
import { ApiError, featureRequired } from "../http/errors.js";
import {
  ASSIGNABLE_ROLES,
  rankOf,
  type AssignableRole,
} from "../team/roles.js";
import type { OidcAccounts, OidcIdentity } from "./accounts.js";
import {
  checkUrl,
  policyFetch,
  policyOf,
  UrlRefusedError,
  type NetworkPolicy,
  type OidcNetworkOptions,
} from "./network.js";

export const OIDC_SETTING = "oidc.settings";
export const CLIENT_SECRET_CONTEXT = "oidc.client_secret";
export const CALLBACK_PATH = "/api/v1/auth/oidc/callback";
/** A sign-in started more than 10 minutes ago is refused (O-05). */
export const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const MAX_TRANSACTIONS = 1000;
/** Open sign-ins one client address may hold (L5). */
export const MAX_PER_ADDRESS = 10;
/** Iat may lie at most this far in the future (O-11). */
const MAX_FUTURE_IAT_S = 60;

/** The ID token algorithms Dialwarden accepts; never HS* or none (O-13). */
export const ID_TOKEN_ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"];

export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  authorization_response_iss_parameter_supported?: boolean;
}

export interface StoredOidc {
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** Encrypted with APP_SECRET_KEY; null for a public client. */
  clientSecretEnc: string | null;
  scope: string;
  groupsClaim: string;
  roleMapping: Record<string, string>;
  allowPrivateNetwork: boolean;
  algorithm: string;
  metadata: ProviderMetadata;
}

export interface OidcInput {
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** Omitted: keep the stored one (same issuer and client only). */
  clientSecret?: string | undefined;
  scope?: string | undefined;
  groupsClaim?: string | undefined;
  roleMapping: Record<string, string>;
  allowPrivateNetwork: boolean;
}

export interface OidcView {
  configured: boolean;
  enabled: boolean;
  issuer: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  scope: string;
  groupsClaim: string;
  roleMapping: Record<string, string>;
  allowPrivateNetwork: boolean;
  redirectUri: string | null;
}

/** The account a sign-in ends with (the route starts its session). */
export type SignedInUser = ReturnType<OidcAccounts["signIn"]>;

interface Transaction {
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
  /** The client address that started it (the per-address cap). */
  address: string;
}

/** A slash, then a plain path character that is not a slash, then more. */
const RETURN_TO = /^\/[A-Za-z0-9._~-][A-Za-z0-9._~/?=&-]*$/;
const DEFAULT_SCOPE = "openid email profile";
const DEFAULT_GROUPS_CLAIM = "groups";

const stateInvalid = () => new ApiError(401, "oidc_state_invalid");
const tokenInvalid = () => new ApiError(401, "oidc_token_invalid");
const noRole = () => new ApiError(403, "oidc_no_role");
const urlRefused = (reason: string) =>
  new ApiError(422, "oidc_url_refused", { reason });

const hashOf = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The page to return to after the sign-in: a path on this site only. One
 * leading slash, then plain path characters; anything else (another host, a
 * scheme, a backslash, an encoded character, a line break) becomes / (O-22).
 */
export function safeReturnTo(value: string | undefined): string {
  if (value === undefined || value.length > 200) return "/";
  return RETURN_TO.test(value) ? value : "/";
}

/**
 * The highest role the groups map to, at most admin; a mapping to owner (or
 * anything else) is ignored (O-18).
 */
export function roleFor(
  groups: readonly string[],
  mapping: Record<string, string>,
): AssignableRole | null {
  const table = new Map(Object.entries(mapping));
  let best: AssignableRole | null = null;
  for (const group of groups) {
    const role = table.get(group);
    const assignable = ASSIGNABLE_ROLES.find((item) => item === role);
    if (assignable === undefined) continue;
    if (best === null || rankOf(assignable) > rankOf(best)) best = assignable;
  }
  return best;
}

function parseMetadata(value: unknown): ProviderMetadata | null {
  if (!isRecord(value)) return null;
  const issuer = textOf(value["issuer"]);
  const authorization = textOf(value["authorization_endpoint"]);
  const token = textOf(value["token_endpoint"]);
  const jwks = textOf(value["jwks_uri"]);
  if (issuer === null || authorization === null) return null;
  if (token === null || jwks === null) return null;
  const metadata: ProviderMetadata = {
    issuer,
    authorization_endpoint: authorization,
    token_endpoint: token,
    jwks_uri: jwks,
  };
  if (value["authorization_response_iss_parameter_supported"] === true) {
    metadata.authorization_response_iss_parameter_supported = true;
  }
  return metadata;
}

/** The pinned ID token algorithm: the first one both sides support. */
function algorithmOf(document: Record<string, unknown>): string | null {
  const offered = document["id_token_signing_alg_values_supported"];
  if (!Array.isArray(offered)) return "RS256";
  const list = offered.filter((item): item is string => {
    return typeof item === "string";
  });
  return ID_TOKEN_ALGORITHMS.find((alg) => list.includes(alg)) ?? null;
}

export interface OidcServiceOptions {
  settings: Settings;
  aead: Aead;
  entitlement: EntitlementGate;
  accounts: OidcAccounts;
  baseUrl: string | null;
  network?: OidcNetworkOptions | undefined;
  now?: () => Date;
}

export class OidcService {
  readonly #settings: Settings;
  readonly #aead: Aead;
  readonly #entitlement: EntitlementGate;
  readonly #accounts: OidcAccounts;
  readonly #baseUrl: string | null;
  readonly #network: OidcNetworkOptions;
  readonly #now: () => Date;
  readonly #transactions = new Map<string, Transaction>();

  constructor(options: OidcServiceOptions) {
    this.#settings = options.settings;
    this.#aead = options.aead;
    this.#entitlement = options.entitlement;
    this.#accounts = options.accounts;
    this.#baseUrl =
      options.baseUrl === null ? null : options.baseUrl.replace(/\/+$/, "");
    this.#network = options.network ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  #stored(): StoredOidc | null {
    const value = this.#settings.get(OIDC_SETTING);
    if (!isRecord(value)) return null;
    return value as unknown as StoredOidc;
  }

  #redirectUri(): string | null {
    return this.#baseUrl === null ? null : `${this.#baseUrl}${CALLBACK_PATH}`;
  }

  #policy(stored: { allowPrivateNetwork: boolean }): NetworkPolicy {
    return policyOf(stored.allowPrivateNetwork, this.#network);
  }

  /** OIDC is on: configured, switched on, Paid, and BASE_URL is set. */
  active(): boolean {
    const stored = this.#stored();
    return (
      stored !== null &&
      stored.enabled &&
      this.#baseUrl !== null &&
      this.#entitlement.can("oidc")
    );
  }

  /** Only the owner signs in with a password while OIDC is on (O-28). */
  assertLocalLogin(email: string): void {
    if (!this.active()) return;
    const owner = this.#accounts.ownerEmail();
    const given = email.trim().toLowerCase();
    if (owner === null || !sameText(given, owner)) {
      throw new ApiError(403, "sso_required");
    }
  }

  view(): OidcView {
    const stored = this.#stored();
    return {
      configured: stored !== null,
      enabled: stored?.enabled ?? false,
      issuer: stored?.issuer ?? null,
      clientId: stored?.clientId ?? null,
      hasClientSecret: (stored?.clientSecretEnc ?? null) !== null,
      scope: stored?.scope ?? DEFAULT_SCOPE,
      groupsClaim: stored?.groupsClaim ?? DEFAULT_GROUPS_CLAIM,
      roleMapping: stored?.roleMapping ?? {},
      allowPrivateNetwork: stored?.allowPrivateNetwork ?? false,
      redirectUri: this.#redirectUri(),
    };
  }

  /** Reads the discovery document under the policy; checks the issuer. */
  async #discover(
    issuer: string,
    policy: NetworkPolicy,
  ): Promise<{ metadata: ProviderMetadata; algorithm: string }> {
    const base = issuer.replace(/\/+$/, "");
    const address = `${base}/.well-known/openid-configuration`;
    let document: unknown;
    try {
      const answer = await policyFetch(
        address,
        { headers: { accept: "application/json" } },
        policy,
      );
      if (answer.status !== 200) {
        throw new ApiError(422, "oidc_discovery_failed", {
          status: answer.status,
        });
      }
      document = await answer.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof UrlRefusedError) throw urlRefused(error.message);
      throw new ApiError(422, "oidc_discovery_failed");
    }
    const metadata = parseMetadata(document);
    if (metadata === null || !isRecord(document)) {
      throw new ApiError(422, "oidc_discovery_failed");
    }
    if (metadata.issuer !== issuer) {
      throw new ApiError(422, "oidc_issuer_mismatch");
    }
    // The endpoints the server itself calls pass the same policy (O-26).
    for (const endpoint of [metadata.token_endpoint, metadata.jwks_uri]) {
      try {
        await checkUrl(endpoint, policy);
      } catch (error) {
        if (error instanceof UrlRefusedError) throw urlRefused(error.message);
        throw error;
      }
    }
    // The browser goes to the authorization endpoint: https (or the test
    // seam's http) only.
    let authorization: URL;
    try {
      authorization = new URL(metadata.authorization_endpoint);
    } catch {
      throw urlRefused("invalid url");
    }
    const httpOk = policy.allowHttp && authorization.protocol === "http:";
    if (authorization.protocol !== "https:" && !httpOk) {
      throw urlRefused("https only");
    }
    const algorithm = algorithmOf(document);
    if (algorithm === null) {
      throw new ApiError(422, "oidc_unsupported_algorithm");
    }
    return { metadata, algorithm };
  }

  /** PUT /api/v1/settings/oidc (owner only, O-08, O-18, O-23, O-24). */
  async configure(input: OidcInput): Promise<OidcView> {
    for (const role of Object.values(input.roleMapping)) {
      if (!ASSIGNABLE_ROLES.some((item) => item === role)) {
        throw new ApiError(422, "invalid_role_mapping");
      }
    }
    const before = this.#stored();
    // Switching off needs no provider: the owner can turn OIDC off while the
    // provider is down. The stored provider settings stay for a later switch
    // back on.
    if (!input.enabled && before !== null) {
      this.#settings.set(OIDC_SETTING, { ...before, enabled: false });
      return this.view();
    }
    if (this.#baseUrl === null) {
      throw new ApiError(409, "base_url_required");
    }
    // The issuer is checked before any connection (O-24).
    const policy = this.#policy(input);
    try {
      await checkUrl(input.issuer, policy);
    } catch (error) {
      if (error instanceof UrlRefusedError) throw urlRefused(error.message);
      throw error;
    }
    const { metadata, algorithm } = await this.#discover(input.issuer, policy);
    const sameClient =
      before !== null &&
      before.issuer === input.issuer &&
      before.clientId === input.clientId;
    // Omitted keeps the stored secret (same issuer and client only); an
    // empty string clears it (a public client).
    let clientSecretEnc: string | null = null;
    if (input.clientSecret !== undefined && input.clientSecret !== "") {
      clientSecretEnc = this.#aead.encrypt(
        input.clientSecret,
        CLIENT_SECRET_CONTEXT,
      );
    } else if (input.clientSecret === undefined && sameClient) {
      clientSecretEnc = before.clientSecretEnc;
    }
    const stored: StoredOidc = {
      enabled: input.enabled,
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretEnc,
      scope: input.scope ?? DEFAULT_SCOPE,
      groupsClaim: input.groupsClaim ?? DEFAULT_GROUPS_CLAIM,
      roleMapping: { ...input.roleMapping },
      allowPrivateNetwork: input.allowPrivateNetwork,
      algorithm,
      metadata,
    };
    this.#settings.set(OIDC_SETTING, stored);
    return this.view();
  }

  /** The active settings, or the refusal of a sign-in request. */
  #requireActive(): StoredOidc {
    if (!this.#entitlement.can("oidc")) throw featureRequired("oidc");
    const stored = this.#stored();
    if (stored === null || !stored.enabled || this.#baseUrl === null) {
      throw new ApiError(409, "oidc_disabled");
    }
    return stored;
  }

  #configuration(stored: StoredOidc): client.Configuration {
    const secret =
      stored.clientSecretEnc === null
        ? null
        : this.#aead.decryptText(stored.clientSecretEnc, CLIENT_SECRET_CONTEXT);
    const auth =
      secret === null ? client.None() : client.ClientSecretPost(secret);
    const config = new client.Configuration(
      { ...stored.metadata },
      stored.clientId,
      { id_token_signed_response_alg: stored.algorithm },
      auth,
    );
    const policy = this.#policy(stored);
    config[client.customFetch] = (url, options) =>
      policyFetch(
        url,
        {
          method: options.method,
          headers: options.headers,
          body: options.body as string | URLSearchParams | null,
          signal: options.signal ?? null,
        },
        policy,
      );
    if (policy.allowHttp) client.allowInsecureRequests(config);
    // Check the ID token signature with the provider keys (O-12 to O-15).
    client.enableNonRepudiationChecks(config);
    return config;
  }

  /**
   * Drops expired sign-ins. One client address holds at most
   * MAX_PER_ADDRESS open sign-ins (its oldest goes first), and a full store
   * refuses new sign-ins rather than drop anyone else's, so a flood of start
   * requests never ends a real sign-in (L5).
   */
  #makeRoom(now: number, address: string): void {
    const mine: string[] = [];
    for (const [key, item] of this.#transactions) {
      if (now - item.createdAt >= TRANSACTION_TTL_MS) {
        this.#transactions.delete(key);
      } else if (item.address === address) {
        mine.push(key);
      }
    }
    const oldest = mine.at(0);
    if (mine.length >= MAX_PER_ADDRESS && oldest !== undefined) {
      this.#transactions.delete(oldest);
    }
    if (this.#transactions.size >= MAX_TRANSACTIONS) {
      throw new ApiError(429, "rate_limited", { retryAfter: 60 });
    }
  }

  /** Starts a sign-in: the provider URL and the state for the cookie. */
  async start(
    returnTo: string | undefined,
    address: string,
  ): Promise<{ url: string; state: string }> {
    const stored = this.#requireActive();
    const config = this.#configuration(stored);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const now = this.#now().getTime();
    this.#makeRoom(now, address);
    this.#transactions.set(hashOf(state), {
      nonce,
      verifier,
      returnTo: safeReturnTo(returnTo),
      createdAt: now,
      address,
    });
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.#redirectUri() ?? "",
      scope: stored.scope,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { url: url.href, state };
  }

  /**
   * Finishes a sign-in. The state must match the transaction cookie of this
   * browser, be unused and younger than 10 minutes (O-01 to O-05); the code
   * exchange checks PKCE, the nonce and the ID token (O-06 to O-15).
   */
  async callback(
    query: Record<string, string>,
    cookieState: string | null,
  ): Promise<{ user: SignedInUser; returnTo: string }> {
    const stored = this.#requireActive();
    const state = query["state"] ?? "";
    if (state === "" || cookieState === null || !sameText(state, cookieState)) {
      throw stateInvalid();
    }
    const key = hashOf(state);
    const transaction = this.#transactions.get(key);
    // One use only, even when the exchange fails (O-04).
    this.#transactions.delete(key);
    const now = this.#now().getTime();
    if (
      transaction === undefined ||
      now - transaction.createdAt >= TRANSACTION_TTL_MS
    ) {
      throw stateInvalid();
    }
    const claims = await this.#exchange(stored, query, transaction, state);
    const user = this.#accounts.signIn(this.#identity(stored, claims));
    return { user, returnTo: transaction.returnTo };
  }

  async #exchange(
    stored: StoredOidc,
    query: Record<string, string>,
    transaction: Transaction,
    state: string,
  ): Promise<Record<string, unknown>> {
    const config = this.#configuration(stored);
    // The library sends this URL without its query as the redirect_uri, so
    // it is built from BASE_URL, never from the request host (O-23).
    const current = new URL(this.#redirectUri() ?? "");
    for (const [name, value] of Object.entries(query)) {
      current.searchParams.set(name, value);
    }
    try {
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (claims === undefined) throw tokenInvalid();
      return { ...claims };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw tokenInvalid();
    }
  }

  /** The checked claims as an identity with a role, or the refusal. */
  #identity(stored: StoredOidc, claims: Record<string, unknown>): OidcIdentity {
    const issuer = textOf(claims["iss"]);
    const subject = textOf(claims["sub"]);
    if (issuer === null || subject === null || issuer !== stored.issuer) {
      throw tokenInvalid();
    }
    // The library checks exp; an iat far in the future is refused here
    // (O-11), and with several audiences azp must name this client (O-10).
    const iat = claims["iat"];
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof iat !== "number" || iat > nowSeconds + MAX_FUTURE_IAT_S) {
      throw tokenInvalid();
    }
    const aud = claims["aud"];
    const azp = claims["azp"];
    if (azp !== undefined && azp !== stored.clientId) throw tokenInvalid();
    if (Array.isArray(aud) && aud.length > 1 && azp !== stored.clientId) {
      throw tokenInvalid();
    }
    const groupsValue = claims[stored.groupsClaim];
    const groups = Array.isArray(groupsValue)
      ? groupsValue.filter((item): item is string => typeof item === "string")
      : [];
    const role = roleFor(groups, stored.roleMapping);
    if (role === null) {
      this.#accounts.refused(issuer, subject);
      throw noRole();
    }
    // An address the provider has not verified is not used (L6): it could
    // name a colleague or a future invitee.
    const verified = claims["email_verified"] === true;
    const email =
      (verified ? textOf(claims["email"]) : null) ??
      `oidc-${hashOf(`${issuer} ${subject}`).slice(0, 16)}@sso.invalid`;
    const name =
      textOf(claims["name"]) ??
      textOf(claims["preferred_username"]) ??
      email.split("@")[0] ??
      "";
    return { issuer, subject, email, name, role };
  }
}
