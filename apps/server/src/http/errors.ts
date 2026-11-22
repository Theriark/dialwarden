// API errors. Every error body has an "error" code the web app can map to
// words; validation errors add the zod issues (paths and messages only, never
// the submitted values). The 402 body is contract C1.
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { FeatureKey, LimitKey } from "@dialwarden/entitlement";
import { z } from "zod";
import { RequestValidationError } from "./zod.js";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** Contract C1: the body every Free-plan refusal carries. */
export interface PaymentRequiredBody {
  error: "payment_required";
  plan: "free";
  feature?: FeatureKey;
  limit?: LimitKey;
  current?: number;
  max?: number;
}

export const paymentRequiredSchema = z.object({
  error: z.literal("payment_required"),
  plan: z.literal("free"),
  feature: z.string().optional(),
  limit: z.string().optional(),
  current: z.number().optional(),
  max: z.number().optional(),
});

export function featureRequired(feature: FeatureKey): ApiError {
  return new ApiError(402, "payment_required", { plan: "free", feature });
}

export function limitReached(
  limit: LimitKey,
  current: number,
  max: number,
): ApiError {
  return new ApiError(402, "payment_required", {
    plan: "free",
    limit,
    current,
    max,
  });
}

export const errorSchema = z.object({ error: z.string() }).loose();

function zodIssues(
  error: RequestValidationError,
): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof ApiError) {
    const body = { error: error.code, ...error.details };
    void reply.code(error.statusCode).send(body);
    return;
  }
  // Only request validation is the client's fault; any other ZodError (for
  // example a response that does not match its schema) is a logged 500.
  if (error instanceof RequestValidationError) {
    const body = { error: "validation", issues: zodIssues(error) };
    void reply.code(400).send(body);
    return;
  }
  const status = (error as FastifyError).statusCode ?? 500;
  if (status >= 400 && status < 500) {
    const code = (error as FastifyError).code ?? "bad_request";
    void reply.code(status).send({ error: code.toLowerCase() });
    return;
  }
  request.log.error({ err: error }, "request failed");
  void reply.code(500).send({ error: "internal" });
}
