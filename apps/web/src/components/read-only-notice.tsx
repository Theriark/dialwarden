// The one sentence every read-only screen shows a viewer (P8 live check F1):
// the settings editor and the history timeline say the same thing in the
// same words, with the role of the session and what the screen lets the
// person read. An editor whose grant on this server is read gets the same
// sentence about the grant (P10-A L22), so the disabled controls are
// explained by the server's own answer, not by the role.
import { Eye } from "lucide-react";
import { roleWord } from "./role-badge";
import { Alert } from "./ui/alert";

export interface ReadOnlyNoticeProps {
  /** The session role, as the server names it. */
  role: string;
  /** What the person reads here: "these settings", "this history". */
  reads: string;
  /** What a writer does here: "changes them", "restores a version". */
  writes: string;
  /** True when the role could write but the grant on this server is read. */
  grant?: boolean | undefined;
  className?: string | undefined;
}

export function ReadOnlyNotice({
  role,
  reads,
  writes,
  grant = false,
  className,
}: ReadOnlyNoticeProps) {
  return (
    <Alert kind="info" className={className}>
      <span className="flex items-center gap-2">
        <Eye className="size-4 shrink-0" aria-hidden="true" />
        {grant
          ? `You are signed in as ${roleWord(role).toLowerCase()} with read access to this server: you read ${reads}. A write grant from the owner or an admin ${writes}.`
          : `You are signed in as ${roleWord(role).toLowerCase()}: you read ${reads}. The owner, an admin or an editor with write access ${writes}.`}
      </span>
    </Alert>
  );
}
