import { z } from "zod";

export const a = z.object({
  maxServers: z.number().int().min(1).max(10000).optional(),
});
