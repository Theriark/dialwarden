// The pending badge (dev-work-plan P6-C step 3): how many change sets of a
// server wait for it to stop (contract C5 stopped-only policy). Nothing is
// rendered for zero; with a slug the badge links to the pending list on the
// history page.
import { Link } from "@tanstack/react-router";
import { Badge } from "./ui/badge";

export interface PendingBadgeProps {
  count: number;
  /** When given, the badge links to the server's history page. */
  slug?: string | undefined;
  className?: string | undefined;
}

export function pendingWord(count: number): string {
  return `${count} pending ${count === 1 ? "change" : "changes"}`;
}

const TITLE = "Written when the server is stopped next";

export function PendingBadge({ count, slug, className }: PendingBadgeProps) {
  if (count <= 0) {
    return null;
  }
  const badge = (
    <Badge kind="pending" className={className}>
      {pendingWord(count)}
    </Badge>
  );
  if (slug === undefined) {
    return <span title={TITLE}>{badge}</span>;
  }
  return (
    <Link
      to="/servers/$slug/history"
      params={{ slug }}
      title={TITLE}
      className="inline-flex rounded-full"
    >
      {badge}
    </Link>
  );
}
