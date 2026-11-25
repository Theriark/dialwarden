// The one sentence every read-only screen shows a viewer (P8 live check F1):
// the settings editor and the history timeline say the same thing in the
// same words, with the role of the session and what the screen lets the
// person read.
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
  className?: string | undefined;
}

export function ReadOnlyNotice({
  role,
  reads,
  writes,
  className,
}: ReadOnlyNoticeProps) {
  return (
    <Alert kind="info" className={className}>
      <span className="flex items-center gap-2">
        <Eye className="size-4 shrink-0" aria-hidden="true" />
        You are signed in as {roleWord(role).toLowerCase()}: you read {reads}.
        The owner, an admin or an editor with write access {writes}.
      </span>
    </Alert>
  );
}
