/** Joins class names, skipping false, null, undefined and empty strings. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts
    .filter((part) => typeof part === "string" && part !== "")
    .join(" ");
}
