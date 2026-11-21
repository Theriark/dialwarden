import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(printable, { message: "control characters are not allowed" });

export { text };
