// The network policy of every server-side OIDC request (P8-A step 5, R&D
// decision rnd-decision-p8a Q3, threat specs O-24 to O-26). The identity
// provider URL is typed by the owner, so the server must not become a way to
// reach the host itself, the cloud metadata service or the local network:
// - https only, parsed with the WHATWG URL parser (numeric host forms such as
//   2130706433, 0x7f.1 and 127.1 become 127.0.0.1 before the check);
// - every address the name resolves to must be public unicast; private
//   (RFC 1918), carrier-grade NAT and unique local addresses pass only with
//   the owner's "identity provider on a private network" setting; loopback,
//   link-local (cloud metadata), unspecified and multicast never pass;
// - the connection goes to the checked address (pinned lookup), so a second
//   DNS answer cannot move it (DNS rebinding);
// - no redirect is followed, 5 s to connect, 10 s in total, 512 KiB at most.
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

export const CONNECT_TIMEOUT_MS = 5_000;
export const TOTAL_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 512 * 1024;

/** Resolves a host name to every address it has. */
export type Resolver = (host: string) => Promise<string[]>;

/**
 * Test seam (BuildOptions.oidcNetwork), never read from the environment: the
 * tests reach an identity provider on 127.0.0.1 over http, and the policy
 * tests swap the resolver.
 */
export interface OidcNetworkOptions {
  allowLoopback?: boolean;
  allowHttp?: boolean;
  resolve?: Resolver;
}

export interface NetworkPolicy {
  /** The owner's setting: RFC 1918, CGNAT and ULA addresses pass. */
  allowPrivateNetwork: boolean;
  allowLoopback: boolean;
  allowHttp: boolean;
  resolve: Resolver;
}

/** A URL or address the policy refuses (the routes answer oidc_url_refused). */
export class UrlRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UrlRefusedError";
  }
}

const PRIVATE_RANGES = new Set(["private", "carrierGradeNat", "uniqueLocal"]);

export const systemResolver: Resolver = async (host) => {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
};

export function policyOf(
  allowPrivateNetwork: boolean,
  options: OidcNetworkOptions = {},
): NetworkPolicy {
  return {
    allowPrivateNetwork,
    allowLoopback: options.allowLoopback === true,
    allowHttp: options.allowHttp === true,
    resolve: options.resolve ?? systemResolver,
  };
}

/** Whether one address may be reached under the policy. */
export function addressAllowed(text: string, policy: NetworkPolicy): boolean {
  // A zone id (fe80::1%eth0) is link-local anyway; drop it for the parser.
  const bare = text.split("%")[0] ?? "";
  if (!ipaddr.isValid(bare)) return false;
  let address = ipaddr.parse(bare);
  if (address.kind() === "ipv6") {
    const v6 = address as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) address = v6.toIPv4Address();
  }
  const range = address.range();
  if (range === "unicast") return true;
  if (PRIVATE_RANGES.has(range)) return policy.allowPrivateNetwork;
  if (range === "loopback") return policy.allowLoopback;
  return false;
}

/** The host of a URL without the brackets of an IPv6 literal. */
function hostOf(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Checks a URL and resolves its host; returns the checked addresses the
 * connection must use. Throws UrlRefusedError.
 */
export async function checkUrl(
  input: string | URL,
  policy: NetworkPolicy,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlRefusedError("not a URL");
  }
  const httpOk = policy.allowHttp && url.protocol === "http:";
  if (url.protocol !== "https:" && !httpOk) {
    throw new UrlRefusedError("https only");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UrlRefusedError("credentials in the URL");
  }
  const addresses = await checkHost(hostOf(url), policy);
  return { url, addresses };
}

/**
 * Resolves a host name (or takes an IP literal) and checks every address
 * under the policy; returns the addresses a connection must use. The SMTP
 * notification channel checks its host with it (P9-B). Throws
 * UrlRefusedError.
 */
export async function checkHost(
  host: string,
  policy: NetworkPolicy,
): Promise<string[]> {
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await policy.resolve(host);
    } catch {
      throw new UrlRefusedError("the host name does not resolve");
    }
  }
  if (addresses.length === 0) {
    throw new UrlRefusedError("the host name does not resolve");
  }
  // Every address must pass: a name with one public and one internal
  // address could otherwise be used to reach the internal one.
  if (!addresses.every((address) => addressAllowed(address, policy))) {
    throw new UrlRefusedError("address not allowed");
  }
  return addresses;
}

/** A lookup that answers the checked addresses only (no second DNS query). */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
  return (_hostname, options, callback) => {
    const first = entries[0];
    if (first === undefined) {
      callback(new Error("no checked address"), "", 4);
      return;
    }
    if (options.all === true) {
      callback(null, entries);
      return;
    }
    callback(null, first.address, first.family);
  };
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
): Promise<Buffer> {
  if (body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new UrlRefusedError("answer too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export interface PolicyFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams | null;
  signal?: AbortSignal | null;
}

/**
 * fetch under the policy. The answer is a standard Response with the body
 * read in full (at most MAX_BODY_BYTES). A redirect is refused.
 */
export async function policyFetch(
  input: string,
  options: PolicyFetchOptions,
  policy: NetworkPolicy,
): Promise<Response> {
  const { url, addresses } = await checkUrl(input, policy);
  const agent = new Agent({
    connect: { lookup: pinnedLookup(addresses), timeout: CONNECT_TIMEOUT_MS },
  });
  const signals = [AbortSignal.timeout(TOTAL_TIMEOUT_MS)];
  if (options.signal !== undefined && options.signal !== null) {
    signals.push(options.signal);
  }
  try {
    const answer = await undiciFetch(url, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body ?? null,
      redirect: "manual",
      signal: AbortSignal.any(signals),
      dispatcher: agent,
    });
    if (answer.status >= 300 && answer.status < 400) {
      await answer.body?.cancel();
      throw new UrlRefusedError("redirects are not followed");
    }
    const bytes = await readCapped(
      answer.body as ReadableStream<Uint8Array> | null,
    );
    const headers = new Headers();
    answer.headers.forEach((value, key) => {
      headers.set(key, value);
    });
    // A 204 or 205 answer may not carry a body, not even an empty one.
    const empty = answer.status === 204 || answer.status === 205;
    const body = empty ? null : bytes;
    return new Response(body, { status: answer.status, headers });
  } finally {
    await agent.close();
  }
}
