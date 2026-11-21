// Format engine (interface contract C2). P2 adds the FormatAdapter
// implementations; P0 fixes the adapter ids and one byte-preserving helper.

export const FORMAT_IDS = [
  "ini",
  "struct",
  "json",
  "xml",
  "lua",
  "cfg",
  "shellvar",
  "launch",
  "codec",
] as const;

export type FormatId = (typeof FORMAT_IDS)[number];

export function isFormatId(value: string): value is FormatId {
  return (FORMAT_IDS as readonly string[]).includes(value);
}

/** The line ending a file already uses, so a write keeps it unchanged. */
export function detectNewline(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}
