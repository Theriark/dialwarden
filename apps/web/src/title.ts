// Page titles follow one pattern: "Section · Dialwarden".
export function pageTitle(section?: string): string {
  return section ? `${section} · Dialwarden` : "Dialwarden";
}
