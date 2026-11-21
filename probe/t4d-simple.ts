import { z } from "zod";

export const a = z.object({
  v: z.literal(1),
  lid: z.string().regex(ULID),
  plan: z.literal("paid"),
  customer: z.object({
    id: text(64),
    name: text(64),
  }),
  kind: z.enum(["customer", "internal-dev"]),
});
