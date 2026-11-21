// Login rate limit (dev-work-plan P1-A step 3). Failed attempts are counted in
// a sliding window per account and client address (the hard limit), per client
// address, and per account from any address (a looser limit, so nobody can lock
// the only owner out from somewhere else). While a key is over its limit every
// attempt is refused, a correct password included, until the oldest failure
// leaves the window.
//
// An attempt is reserved before the password is checked (reserve) and handed
// back when it succeeds (release or succeed), so concurrent requests cannot
// all pass the check before the first failure is counted.
//
// IPv6 clients are counted per /64, the smallest block one host usually gets.
// Memory is bounded at MAX_KEYS keys per window; a key at or over its limit is
// never evicted while another key can go instead.
import { isIPv4, isIPv6 } from "node:net";

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_ACCOUNT = 5;
export const MAX_FAILURES_PER_ADDRESS = 20;
export const MAX_FAILURES_PER_ACCOUNT_ANY_ADDRESS = 100;
export const MAX_KEYS = 10_000;

export class FailureWindow {
  readonly #hits = new Map<string, number[]>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;

  constructor(
    max: number,
    windowMs: number,
    now: () => number,
    maxKeys = MAX_KEYS,
  ) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  #recent(key: string): number[] {
    const since = this.#now() - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((at) => at > since);
    if (hits.length === 0) {
      this.#hits.delete(key);
    } else {
      this.#hits.set(key, hits);
    }
    return hits;
  }

  /** Milliseconds until the next attempt is allowed; 0 when allowed now. */
  retryAfterMs(key: string): number {
    const hits = this.#recent(key);
    if (hits.length < this.#max) {
      return 0;
    }
    const oldest = hits.at(-this.#max) ?? this.#now();
    return Math.max(1, oldest + this.#windowMs - this.#now());
  }

  fail(key: string): void {
    const hits = this.#recent(key);
    hits.push(this.#now());
    this.#hits.delete(key);
    this.#hits.set(key, hits);
    if (this.#hits.size > this.#maxKeys) {
      this.#evict(key);
    }
  }

  /** Hands back the newest failure of a key (a reserved attempt that passed). */
  release(key: string): void {
    const hits = this.#recent(key);
    hits.pop();
    if (hits.length === 0) {
      this.#hits.delete(key);
    }
  }

  reset(key: string): void {
    this.#hits.delete(key);
  }

  get size(): number {
    return this.#hits.size;
  }

  /**
   * Drops expired keys first, then the least recently failed key under its
   * limit. Only when every key is locked does the oldest locked key go (the
   * memory bound wins); reaching that takes MAX_KEYS locked keys.
   */
  #evict(keep: string): void {
    const since = this.#now() - this.#windowMs;
    let underLimit: string | undefined;
    for (const [key, hits] of this.#hits) {
      if (key === keep) {
        continue;
      }
      const live = hits.filter((at) => at > since);
      if (live.length === 0) {
        this.#hits.delete(key);
        return;
      }
      if (underLimit === undefined && live.length < this.#max) {
        underLimit = key;
      }
    }
    const victim = underLimit ?? this.#hits.keys().next().value;
    if (victim !== undefined && victim !== keep) {
      this.#hits.delete(victim);
    }
  }
}

/** The address key: IPv4 as is, IPv6 by its /64 (IPv4-mapped as IPv4). */
export function addressKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) {
    return mapped[1];
  }
  if (isIPv4(address) || !isIPv6(address)) {
    return address;
  }
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const left = head.split(":").filter((group) => group !== "");
  const right = tail.split(":").filter((group) => group !== "");
  // An embedded IPv4 tail (a.b.c.d) stands for two groups.
  const rightCount = right.length + (right.at(-1)?.includes(".") ? 1 : 0);
  const zeros = address.includes("::") ? 8 - left.length - rightCount : 0;
  const groups = [...left, ...Array.from({ length: zeros }, () => "0")];
  groups.push(...right);
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":");
  return `${prefix}::/64`;
}

export class LoginLimiter {
  readonly #accountAtAddress: FailureWindow;
  readonly #address: FailureWindow;
  readonly #account: FailureWindow;

  constructor(now: () => number = Date.now) {
    this.#accountAtAddress = new FailureWindow(
      MAX_FAILURES_PER_ACCOUNT,
      WINDOW_MS,
      now,
    );
    this.#address = new FailureWindow(MAX_FAILURES_PER_ADDRESS, WINDOW_MS, now);
    this.#account = new FailureWindow(
      MAX_FAILURES_PER_ACCOUNT_ANY_ADDRESS,
      WINDOW_MS,
      now,
    );
  }

  static #keys(address: string, account: string) {
    const where = addressKey(address);
    const who = account.toLowerCase();
    return { where, who, both: `${who} ${where}` };
  }

  /** Seconds to wait, or 0 when the attempt may go ahead. */
  retryAfterSeconds(address: string, account: string): number {
    const { where, who, both } = LoginLimiter.#keys(address, account);
    const wait = Math.max(
      this.#accountAtAddress.retryAfterMs(both),
      this.#address.retryAfterMs(where),
      this.#account.retryAfterMs(who),
    );
    return Math.ceil(wait / 1000);
  }

  /**
   * Checks the limit and, when the attempt may go ahead, counts it at once as
   * a failure. Returns the seconds to wait (nothing reserved) or 0.
   */
  reserve(address: string, account: string): number {
    const wait = this.retryAfterSeconds(address, account);
    if (wait === 0) {
      this.fail(address, account);
    }
    return wait;
  }

  fail(address: string, account: string): void {
    const { where, who, both } = LoginLimiter.#keys(address, account);
    this.#accountAtAddress.fail(both);
    this.#address.fail(where);
    this.#account.fail(who);
  }

  /** Hands back a reserved attempt without clearing earlier failures. */
  release(address: string, account: string): void {
    const { where, who, both } = LoginLimiter.#keys(address, account);
    this.#accountAtAddress.release(both);
    this.#address.release(where);
    this.#account.release(who);
  }

  /** A full sign-in: the reserved attempt goes back and the account is clear. */
  succeed(address: string, account: string): void {
    const { where, who, both } = LoginLimiter.#keys(address, account);
    this.#address.release(where);
    this.#accountAtAddress.reset(both);
    this.#account.reset(who);
  }
}
