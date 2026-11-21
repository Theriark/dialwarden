import { z } from "zod";

export const a = z.object({
  features: z.array(text(64)).max(64).optional(),
});
