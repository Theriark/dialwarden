import { z } from "zod";

/**
 * The licence payload. The customer name is chosen by the buyer (at most 64
 * characters, legal-input-1 5); it is never a legal name or an e-mail address
 * collected without consent. Unknown fields are ignored (stripped).
 */
export const licencePayloadSchema = z.object({
  v: z.literal(1),
  lid: z.string().regex(ULID),
  plan: z.literal("paid"),
  maxServers: z.number().int().min(1).max(10000).optional(),
  customer: z.object({
    id: text(64),
    name: text(64),
  }),
  issuedAt: z.string().refine(realInstant, { message: "not an ISO instant" }),
  updatesUntil: z.string().refine(realDate, { message: "not a date" }),
  kind: z.enum(["customer", "internal-dev"]),
  features: z.array(text(64)).max(64).optional(),
});
