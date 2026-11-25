// The role of a user as a badge with its own icon and word (never colour
// alone), and the Free fallback badge for a user whose stored role is kept
// but who acts as a viewer (team/roles.ts effectiveRole).
import { Crown, Eye, Lock, PencilLine, ShieldCheck } from "lucide-react";
import { Badge, type BadgeKind } from "./ui/badge";

export const ROLE_WORDS = new Map<string, string>([
  ["owner", "Owner"],
  ["admin", "Admin"],
  ["editor", "Editor"],
  ["viewer", "Viewer"],
]);

/** The role in words; an unknown value is shown as is. */
export function roleWord(role: string): string {
  return ROLE_WORDS.get(role) ?? role;
}

export const ROLE_SENTENCES = new Map<string, string>([
  [
    "owner",
    "Sees and changes everything; the only account that cannot be removed.",
  ],
  ["admin", "Manages servers, users, invitations and the audit log."],
  ["editor", "Edits the settings of the servers granted for writing."],
  ["viewer", "Reads the settings and history of the servers granted."],
]);

/** One sentence on what a role may do; empty for an unknown value. */
export function roleSentence(role: string): string {
  return ROLE_SENTENCES.get(role) ?? "";
}

function kindOf(role: string): BadgeKind {
  switch (role) {
    case "owner":
      return "info";
    case "admin":
      return "success";
    case "editor":
      return "pending";
    default:
      return "neutral";
  }
}

function iconOf(role: string) {
  const className = "size-3.5 shrink-0";
  switch (role) {
    case "owner":
      return <Crown className={className} aria-hidden="true" />;
    case "admin":
      return <ShieldCheck className={className} aria-hidden="true" />;
    case "editor":
      return <PencilLine className={className} aria-hidden="true" />;
    default:
      return <Eye className={className} aria-hidden="true" />;
  }
}

export function RoleBadge({
  role,
  className,
}: {
  role: string;
  className?: string | undefined;
}) {
  return (
    <Badge kind={kindOf(role)} icon={iconOf(role)} className={className}>
      {roleWord(role)}
    </Badge>
  );
}

/** The reason a stored role is not the acting role on the Free plan. */
export const FALLBACK_REASON =
  "On the Free plan every user but the owner acts as a viewer. The stored role and grants are kept and return at once with a licence.";

export function FallbackBadge({
  className,
}: {
  className?: string | undefined;
}) {
  return (
    <Badge
      kind="warning"
      icon={<Lock className="size-3.5 shrink-0" aria-hidden="true" />}
      className={className}
    >
      Acts as viewer on Free
    </Badge>
  );
}
