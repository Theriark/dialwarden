// The Monaco language of a settings file by its path. The raw editor and the
// save dialog's text diffs share it; ini is the packs' home ground.
export function languageOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ini") || lower.endsWith(".acf")) return "ini";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "shell";
  if (lower.endsWith(".xml") || lower.endsWith(".html")) return "xml";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".toml")) return "ini";
  return "plaintext";
}
