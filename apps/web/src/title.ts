/** The document title: the section first, then the product name. */
export function pageTitle(section?: string): string {
  return section === undefined || section === ""
    ? "Dialwarden"
    : `${section} · Dialwarden`;
}
