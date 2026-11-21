// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, asPaymentRequired, setCsrf } from "./client";
import { errorMessage, fieldErrors } from "./errors";
import { fetchSession } from "./queries";

type Call = [string, RequestInit];

function answer(status: number, body: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrf(null);
});

describe("api client", () => {
  it("sends JSON with the CSRF header on writes only", async () => {
    const fetchMock = vi.fn(async () => answer(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    setCsrf("csrf-value");
    await api("/api/v1/thing");
    await api("/api/v1/thing", { method: "POST", body: { a: 1 } });
    const calls = fetchMock.mock.calls as unknown as Call[];
    const getInit = calls[0]?.[1];
    const postInit = calls[1]?.[1];
    const getHeaders = new Headers(getInit?.headers);
    const postHeaders = new Headers(postInit?.headers);
    expect(getHeaders.get("x-csrf-token")).toBeNull();
    expect(postHeaders.get("x-csrf-token")).toBe("csrf-value");
    expect(postHeaders.get("content-type")).toBe("application/json");
    expect(postInit?.body).toBe('{"a":1}');
    expect(postInit?.credentials).toBe("same-origin");
  });

  it("throws an ApiError with the server code and details", async () => {
    const body = { error: "rate_limited", retryAfter: 90 };
    vi.stubGlobal("fetch", vi.fn(async () => answer(429, body)));
    const failure = await failureOf(
      api("/api/v1/auth/login", { method: "POST" }),
    );
    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.code).toBe("rate_limited");
    expect(errorMessage(apiError)).toBe(
      "Too many attempts. Try again in 90 seconds.",
    );
  });

  it("maps a network failure and unknown codes to sentences", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const failure = await failureOf(api("/healthz"));
    expect(errorMessage(failure)).toBe(
      "The server could not be reached. Check the connection.",
    );
    expect(errorMessage(new ApiError(418, { error: "teapot" }))).toBe(
      "The server answered 418 (teapot).",
    );
  });

  it("reads field errors from a validation answer", () => {
    const error = new ApiError(400, {
      error: "validation",
      issues: [{ path: "email", message: "Invalid email" }],
    });
    expect(fieldErrors(error).get("email")).toBe("Invalid email");
    expect(errorMessage(error)).toBe("email: Invalid email");
  });

  it("treats 204 as no content and a 401 session as signed out", async () => {
    const empty = () => new Response(null, { status: 204 });
    vi.stubGlobal("fetch", vi.fn(async () => empty()));
    const nothing = await api("/api/v1/auth/logout", { method: "POST" });
    expect(nothing).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(401, { error: "unauthenticated" })),
    );
    const session = await fetchSession();
    expect(session).toBeNull();
  });

  it("recognises the two 402 shapes of contract C1", () => {
    const feature = asPaymentRequired({
      error: "payment_required",
      feature: "schedules",
    });
    expect(feature).toEqual({
      error: "payment_required",
      plan: "free",
      feature: "schedules",
    });
    const limit = asPaymentRequired({
      error: "payment_required",
      limit: "presets",
      current: 3,
      max: 3,
    });
    expect(limit).toEqual({
      error: "payment_required",
      plan: "free",
      limit: "presets",
      current: 3,
      max: 3,
    });
    expect(asPaymentRequired({ error: "forbidden" })).toBeNull();
  });
});
