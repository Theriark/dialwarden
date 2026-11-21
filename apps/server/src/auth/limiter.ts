// Login rate limit (dev-work-plan P1-A step 3). Failed attempts are counted in
// a sliding window per client address and per account. While a key is over its
// limit every attempt is refused, a correct password included, until the
// oldest failure leaves the window. Memory is bounded: at most MAX_KEYS keys.

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_ACCOUNT = 5;
export const MAX_FAILURES_PER_ADDRESS = 20;
const MAX_KEYS = 10_000;

export class FailureWindow {
  readonly #hits = new Map<string, number[]>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(max: number, windowMs: number, now: () => number) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
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
    if (this.#hits.size > MAX_KEYS) {
      const first = this.#hits.keys().next();
      if (first.done !== true) {
        this.#hits.delete(first.value);
      }
    }
  }

  reset(key: string): void {
    this.#hits.delete(key);
  }
}

export class LoginLimiter {
  readonly #account: FailureWindow;
  readonly #address: FailureWindow;

  constructor(now: () => number = Date.now) {
    this.#account = new FailureWindow(MAX_FAILURES_PER_ACCOUNT, WINDOW_MS, now);
    this.#address = new FailureWindow(MAX_FAILURES_PER_ADDRESS, WINDOW_MS, now);
  }

  /** Seconds to wait, or 0 when the attempt may go ahead. */
  retryAfterSeconds(address: string, account: string): number {
    const wait = Math.max(
      this.#account.retryAfterMs(account.toLowerCase()),
      this.#address.retryAfterMs(address),
    );
    return Math.ceil(wait / 1000);
  }

  fail(address: string, account: string): void {
    this.#account.fail(account.toLowerCase());
    this.#address.fail(address);
  }

  succeed(account: string): void {
    this.#account.reset(account.toLowerCase());
  }
}
