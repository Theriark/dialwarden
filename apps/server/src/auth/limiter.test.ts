// The login limiter (security review THE-2134 L1, threat tests T5; code review
// H2, M1 and M2): reservations, eviction that never frees a locked key, IPv6
// counted per /64, and the hard limit per account and address.
import { describe, expect, it } from "vitest";
import {
  addressKey,
  FailureWindow,
  LoginLimiter,
  MAX_FAILURES_PER_ACCOUNT,
  MAX_FAILURES_PER_ACCOUNT_ANY_ADDRESS,
  MAX_FAILURES_PER_ADDRESS,
  MAX_KEYS,
  WINDOW_MS,
} from "./limiter.js";

function clock() {
  let at = Date.parse("2026-11-21T10:00:00Z");
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const OWNER = "owner@dialwarden.test";

describe("FailureWindow", () => {
  it("keeps a locked key when a flood of new keys passes the bound", () => {
    const { now } = clock();
    const window = new FailureWindow(5, WINDOW_MS, now);
    for (let i = 0; i < 5; i += 1) {
      window.fail(OWNER);
    }
    for (let i = 0; i <= MAX_KEYS; i += 1) {
      window.fail(`flood-${i}@dialwarden.test`);
    }
    expect(window.retryAfterMs(OWNER)).toBeGreaterThan(0);
    expect(window.size).toBeLessThanOrEqual(MAX_KEYS);
  });

  it("drops expired keys first", () => {
    const time = clock();
    const window = new FailureWindow(5, WINDOW_MS, time.now, 3);
    window.fail("old");
    time.advance(WINDOW_MS + 1);
    window.fail("a");
    window.fail("b");
    window.fail("c");
    expect(window.size).toBe(3);
    expect(window.retryAfterMs("a")).toBe(0);
  });

  it("hands back a reserved failure", () => {
    const { now } = clock();
    const window = new FailureWindow(1, WINDOW_MS, now);
    window.fail(OWNER);
    expect(window.retryAfterMs(OWNER)).toBeGreaterThan(0);
    window.release(OWNER);
    expect(window.retryAfterMs(OWNER)).toBe(0);
  });
});

describe("addressKey", () => {
  it("counts IPv6 addresses per /64 and keeps IPv4 as it is", () => {
    expect(addressKey("2001:db8::1")).toBe(addressKey("2001:db8::2"));
    expect(addressKey("2001:db8::1")).not.toBe(addressKey("2001:db8:1::1"));
    expect(addressKey("2001:db8:0:0:ffff::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("2001::1:2:3:4:5:6")).toBe("2001:0:1:2::/64");
    expect(addressKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(addressKey("198.51.100.7")).toBe("198.51.100.7");
  });
});

describe("LoginLimiter", () => {
  it("lets at most the account limit of parallel attempts through", () => {
    const { now } = clock();
    const limiter = new LoginLimiter(now);
    let reserved = 0;
    for (let i = 0; i < 30; i += 1) {
      if (limiter.reserve("203.0.113.9", OWNER) === 0) {
        reserved += 1;
      }
    }
    expect(reserved).toBe(MAX_FAILURES_PER_ACCOUNT);
  });

  it("an address over its limit is refused for every account in its /64", () => {
    const { now } = clock();
    const limiter = new LoginLimiter(now);
    for (let i = 0; i < MAX_FAILURES_PER_ADDRESS; i += 1) {
      limiter.fail("2001:db8::1", `user${i}@dialwarden.test`);
    }
    const account = "a@dialwarden.test";
    const sameBlock = limiter.retryAfterSeconds("2001:db8::2", account);
    expect(sameBlock).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds("2001:db8:1::1", account)).toBe(0);
  });

  it("failures from one address do not lock the owner out elsewhere", () => {
    const { now } = clock();
    const limiter = new LoginLimiter(now);
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i += 1) {
      limiter.fail("198.51.100.7", OWNER);
    }
    expect(limiter.retryAfterSeconds("198.51.100.7", OWNER)).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds("198.51.100.8", OWNER)).toBe(0);
  });

  it("still limits one account across many addresses", () => {
    const { now } = clock();
    const limiter = new LoginLimiter(now);
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT_ANY_ADDRESS; i += 1) {
      limiter.fail(`198.51.${Math.floor(i / 250)}.${i % 250}`, OWNER);
    }
    expect(limiter.retryAfterSeconds("192.0.2.1", OWNER)).toBeGreaterThan(0);
  });

  it("a success hands back the reservation and clears the account", () => {
    const time = clock();
    const limiter = new LoginLimiter(time.now);
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT - 1; i += 1) {
      limiter.fail("198.51.100.7", OWNER);
    }
    expect(limiter.reserve("198.51.100.7", OWNER)).toBe(0);
    limiter.succeed("198.51.100.7", OWNER);
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT - 1; i += 1) {
      expect(limiter.reserve("198.51.100.7", OWNER)).toBe(0);
    }
    time.advance(WINDOW_MS + 1);
    expect(limiter.retryAfterSeconds("198.51.100.7", OWNER)).toBe(0);
  });
});
