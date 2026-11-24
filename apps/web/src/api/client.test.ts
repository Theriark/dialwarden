// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  apiBlob,
  ApiError,
  asPaymentRequired,
  currentCsrf,
  setCsrf,
} from "./client";
import { errorMessage, fieldErrors, issueSentence } from "./errors";
import { fetchSession } from "./queries";

type Call = [string, RequestInit];

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...headers },
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

function calls(mock: { mock: { calls: unknown[][] } }): Call[] {
  return mock.mock.calls as unknown as Call[];
}

const htmlGateway = () =>
  new Response("<html>Bad gateway</html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  });

const octetStream = { "content-type": "application/octet-stream" };

const namedFile = () =>
  answer(200, "DWBX", {
    ...octetStream,
    "content-disposition": 'attachment; filename="dialwarden-1.dwbx"',
  });

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
    const [get, post] = calls(fetchMock);
    const getHeaders = new Headers(get?.[1].headers);
    const postHeaders = new Headers(post?.[1].headers);
    expect(getHeaders.get("x-csrf-token")).toBeNull();
    expect(postHeaders.get("x-csrf-token")).toBe("csrf-value");
    expect(postHeaders.get("content-type")).toBe("application/json");
    expect(post?.[1].body).toBe('{"a":1}');
    expect(post?.[1].credentials).toBe("same-origin");
  });

  it("throws an ApiError with the server code and details", async () => {
    const body = { error: "rate_limited", retryAfter: 90 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(429, body)),
    );
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

  it("says in plain words that a preset changes nothing", () => {
    // A preset whose values the server already holds answers 422
    // no_change (live check F11).
    expect(errorMessage(new ApiError(422, { error: "no_change" }))).toBe(
      "This server already holds these values.",
    );
  });

  it("names the status when the answer carries no error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlGateway()),
    );
    const failure = await failureOf(api("/api/v1/entitlement"));
    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.code).toBe("http_502");
    expect(apiError.body).toBeNull();
    expect(errorMessage(apiError)).toBe("The server answered 502 (http_502).");
  });

  it("turns validation issues into plain sentences per field", () => {
    const error = new ApiError(400, {
      error: "validation",
      issues: [
        { path: "email", message: "Invalid email address" },
        { path: "password", message: "Too small: expected >=12 characters" },
        { path: "email", message: "a second issue on the same field" },
      ],
    });
    expect(fieldErrors(error).get("email")).toBe(
      "The e-mail address is not valid.",
    );
    expect(fieldErrors(error).get("password")).toBe(
      "The password is too short.",
    );
    expect(errorMessage(error)).toBe("The e-mail address is not valid.");
    expect(
      issueSentence({
        path: "x-dialwarden-passphrase",
        message: "printable ASCII characters only",
      }),
    ).toBe(
      "The passphrase may use only letters, digits, spaces and the punctuation of a US keyboard.",
    );
    expect(issueSentence({ path: "token", message: "Too big: 4000" })).toBe(
      "The licence key is too long.",
    );
    expect(issueSentence({ path: "", message: "Unrecognized key" })).toBe(
      "The input is not valid: Unrecognized key.",
    );
    expect(issueSentence({ path: "other", message: "odd" })).toBe(
      "The field other is not valid: odd.",
    );
    expect(errorMessage(new ApiError(400, { error: "validation" }))).toBe(
      "Some fields are not valid.",
    );
  });

  it("treats 204 as no content and a 401 session as signed out", async () => {
    const empty = () => new Response(null, { status: 204 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => empty()),
    );
    const nothing = await api("/api/v1/auth/logout", { method: "POST" });
    expect(nothing).toBeUndefined();
    setCsrf("stale");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(401, { error: "unauthenticated" })),
    );
    const session = await fetchSession();
    expect(session).toBeNull();
    expect(currentCsrf()).toBeNull();
  });

  it("remembers the CSRF token of a session answer", async () => {
    const signedIn = {
      status: "ok",
      csrfToken: "csrf-from-session",
      user: {
        id: "u1",
        email: "owner@example.test",
        name: "Owner",
        role: "owner",
        totpEnabled: false,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, signedIn)),
    );
    const session = await fetchSession();
    expect(session).toEqual(signedIn);
    expect(currentCsrf()).toBe("csrf-from-session");
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

  it("exposes the 402 body only on a 402 answer", () => {
    const paid = new ApiError(402, {
      error: "payment_required",
      limit: "servers",
      current: 3,
      max: 3,
    });
    expect(paid.paymentRequired).toEqual({
      error: "payment_required",
      plan: "free",
      limit: "servers",
      current: 3,
      max: 3,
    });
    const other = new ApiError(403, { error: "payment_required" });
    expect(other.paymentRequired).toBeNull();
    expect(new ApiError(402, null).paymentRequired).toBeNull();
  });
});

describe("apiBlob", () => {
  it("posts with the CSRF header and reads the file name", async () => {
    const fetchMock = vi.fn(async () => namedFile());
    vi.stubGlobal("fetch", fetchMock);
    setCsrf("csrf-value");
    const result = await apiBlob("/api/v1/system/backup-export", {
      body: { passphrase: "export passphrase 2026" },
    });
    expect(result.filename).toBe("dialwarden-1.dwbx");
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBeGreaterThan(0);
    const [call] = calls(fetchMock);
    expect(call?.[1].method).toBe("POST");
    expect(new Headers(call?.[1].headers).get("x-csrf-token")).toBe(
      "csrf-value",
    );
    expect(call?.[1].body).toBe('{"passphrase":"export passphrase 2026"}');
  });

  it("answers null for a missing file name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, "DWBX", octetStream)),
    );
    const result = await apiBlob("/api/v1/system/backup-export");
    expect(result.filename).toBeNull();
  });

  it("throws the error body of a refused export", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(409, { error: "backup_running" })),
    );
    const failure = await failureOf(apiBlob("/api/v1/system/backup-export"));
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("backup_running");
    expect((failure as ApiError).status).toBe(409);
  });
});
