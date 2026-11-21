/** The last 6 characters of the trimmed token, the only token text the API shows. */
export function tokenLast6(input: string): string {
  return input.trim().slice(-6);
}
