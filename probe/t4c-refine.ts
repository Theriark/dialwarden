import { z } from "zod";

export const a = z.object({
  issuedAt: z.string().refine(realInstant, { message: "not an ISO instant" }),
  updatesUntil: z.string().refine(realDate, { message: "not a date" }),
});
