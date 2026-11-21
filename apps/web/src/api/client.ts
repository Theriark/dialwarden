// The API client: same-origin fetch with the session cookie, the X-CSRF-Token
// header on every state-changing request, JSON in and out, and one ApiError
// shape for every failure (the server's error code plus its details).
import type { ApiErrorBody, PaymentRequiredBody } from "./schema";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null) {
    const code = body?.error ?? (status === 0 ? "network" : `http_${status}`);
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** The 402 body of contract C1, or null for any other error. */
  get paymentRequired(): PaymentRequiredBody | null {
    if (this.status !== 402 || this.body === null) {
      return null;
    }
    return asPaymentRequired(this.body);
  }
}

export function asPaymentRequired(
  body: ApiErrorBody,
): PaymentRequiredBody | null {
  if (body.error !== "payment_required") {
    return null;
  }
  const out: PaymentRequiredBody = { error: "payment_required", plan: "free" };
  if (typeof body.feature === "string") {
    out.feature = body.feature;
  }
  if (typeof body.limit === "string") {
    out.limit = body.limit;
  }
  if (typeof body.current === "number") {
    out.current = body.current;
  }
  if (typeof body.max === "number") {
    out.max = body.max;
  }
  return out;
}

let csrf: string | null = null;

/** Remembered from the sign-in or session answer; sent on every write. */
export function setCsrf(value: string | null): void {
  csrf = value;
}

export function currentCsrf(): string | null {
  return csrf;
}

function parseBody(text: string): unknown {
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asErrorBody(value: unknown): ApiErrorBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["error"] !== "string") {
    return null;
  }
  return value as ApiErrorBody;
}

/** One JSON request. 204 resolves to undefined; anything not ok throws. */
export async function api<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  headers.set("accept", "application/json");
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  if (method !== "GET" && csrf !== null) {
    headers.set("x-csrf-token", csrf);
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, null);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const parsed = parseBody(await response.text());
  if (!response.ok) {
    throw new ApiError(response.status, asErrorBody(parsed));
  }
  return parsed as T;
}

/** A request whose answer is a file (the backup export). */
export async function apiBlob(
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const method = options.method ?? "POST";
  const headers = new Headers(options.headers ?? {});
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  if (csrf !== null) {
    headers.set("x-csrf-token", csrf);
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, null);
  }
  if (!response.ok) {
    const parsed = parseBody(await response.text());
    throw new ApiError(response.status, asErrorBody(parsed));
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await response.blob(), filename: match?.[1] ?? null };
}
