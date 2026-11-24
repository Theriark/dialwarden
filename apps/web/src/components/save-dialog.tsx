// The save dialog (screen 5 of dev-work-plan P5): what a change set will do
// before it is applied — the semantic chips, the text diff in the Monaco diff
// editor, the lint, the restart-required badges — and apply. Hooks (restart,
// stop and start) arrive with P6, so only "without a restart" is offered and
// the choice is shown disabled, never hidden.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useState } from "react";
import { applyChangeSet } from "../api/changes";
import { errorMessage } from "../api/errors";
import { p4keys } from "../api/queries";
import type { ChangeSet } from "../api/schema";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { useToast } from "./ui/toast";
import { ChangeChip } from "./change-chip";
import { LazyDiffEditor } from "./code-editor";
import { splitUnifiedDiff } from "../lib/unified-diff";
import { formatDateTime } from "../lib/format";

function lintWord(severity: string): string {
  if (severity === "error") return "Blocks the save";
  if (severity === "warning") return "Warning";
  return "Note";
}

function lintKind(severity: string): "error" | "warning" | "info" | undefined {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  if (severity === "info") return "info";
  return undefined;
}

export interface SaveDialogProps {
  slug: string;
  /** The draft change set the save created (or a restore or preset made). */
  changeSet: ChangeSet;
  /** Called when the dialog closes without applying (cancel). */
  onClose: () => void;
  /** Called after a successful apply, with the applied change set. */
  onApplied: (changeSet: ChangeSet) => void;
  /**
   * The Monaco language of a text diff by file id; ini when not given (the
   * presets flow has no file paths).
   */
  fileLanguage?: ((fileId: string) => string) | undefined;
}

export function SaveDialog({
  slug,
  changeSet,
  fileLanguage,
  onClose,
  onApplied,
}: SaveDialogProps) {
  const client = useQueryClient();
  const toast = useToast();
  // The change set the dialog shows: the draft it opened with until the
  // apply answers, then the returned one - the server also answers HTTP 200
  // with conflict or failed, and those must change this dialog, not vanish.
  const [returned, setReturned] = useState<ChangeSet | null>(null);
  const current = returned ?? changeSet;

  const apply = useMutation({
    mutationFn: () => applyChangeSet(changeSet.id, "none"),
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The save failed",
        description: errorMessage(error),
      });
    },
    onSuccess: (applied) => {
      setReturned(applied);
      void client.invalidateQueries({ queryKey: p4keys.settings(slug) });
      void client.invalidateQueries({ queryKey: p4keys.history(slug) });
      void client.invalidateQueries({ queryKey: p4keys.servers });
      if (applied.status === "applied" || applied.status === "pending") {
        toast.push({
          kind: "success",
          title:
            applied.status === "pending" ? "Saved as pending" : "Changes saved",
          description:
            applied.status === "pending"
              ? "These files are written when the server is stopped next."
              : "The files hold the new values.",
        });
        onApplied(applied);
        return;
      }
      toast.push({
        kind: "error",
        title:
          applied.status === "conflict"
            ? "The save ended in a conflict"
            : "The save failed",
        description:
          applied.error?.message ??
          (applied.status === "conflict"
            ? "The file changed outside Dialwarden. Start again from the editor."
            : "A failed change set can be applied again."),
      });
    },
  });

  const restarts = current.diff.semantic.filter(
    (chip) => chip.restartRequired,
  ).length;
  const applied = current.status === "applied";
  const pending = current.status === "pending";
  const conflict = current.status === "conflict";
  const failed = current.status === "failed";
  const done = applied || pending || conflict;
  // The errors that stop the write, the same filter the server applies: a
  // file-level error of a written file (settingKey null) and an error on a
  // setting this change set sets. Warnings never block (live check F1).
  const changedKeys = new Set(
    current.diff.semantic.map((chip) => chip.settingKey),
  );
  const blocking = current.lint.some(
    (entry) =>
      entry.severity === "error" &&
      (entry.settingKey === null || changedKeys.has(entry.settingKey)),
  );
  // The server message may already end in a full stop; one sentence keeps
  // exactly one (the live check saw a double full stop here).
  const failedReason = (
    current.error?.message ?? "the server could not write the files"
  ).replace(/\.+$/, "");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title={
        conflict
          ? "The file changed outside Dialwarden"
          : applied
            ? "Changes saved"
            : pending
              ? "Saved as pending"
              : failed
                ? "The save failed"
                : "Save these changes?"
      }
      description={`Change set of ${current.diff.semantic.length} ${
        current.diff.semantic.length === 1 ? "setting" : "settings"
      }, created ${formatDateTime(current.createdAt)}.`}
      className="max-w-3xl"
      footer={
        conflict ? (
          <Button variant="primary" onClick={onClose}>
            Start again
          </Button>
        ) : done ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            {blocking ? (
              <span className="mr-auto self-center text-sm text-fg-muted">
                fix the errors first
              </span>
            ) : null}
            <Button
              variant="ghost"
              onClick={onClose}
              disabled={apply.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={apply.isPending}
              disabled={blocking}
              onClick={() => {
                apply.mutate();
              }}
            >
              Save without restart
            </Button>
            <Button
              disabled
              title="Restarting from Dialwarden arrives with phase P6"
            >
              Restart after save (P6)
            </Button>
          </>
        )
      }
    >
      {failed || conflict ? (
        <Alert kind="error">
          {conflict
            ? "Another writer changed the file while this change set was open. The change set is closed: copy anything you need, reload the editor and save a new change set."
            : `The last try failed: ${failedReason}. A failed change set can be applied again.`}
        </Alert>
      ) : null}
      {conflict && current.conflict !== null ? (
        <div className="flex flex-col gap-3">
          {current.conflict.files.map((file) =>
            file.kind === "settings" ? (
              <div
                key={file.fileId}
                className="rounded-control border border-border p-3"
              >
                <p className="mb-2 text-xs font-medium text-fg-muted uppercase">
                  {file.fileId}
                </p>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {file.settings.map((item) => (
                    <li key={item.settingKey} className="flex flex-col">
                      <span className="font-medium text-fg">{item.label}</span>
                      <span className="text-xs text-fg-muted">
                        On the server now: {JSON.stringify(item.theirs)} · This
                        change set wanted: {JSON.stringify(item.ours)} · Before
                        both: {JSON.stringify(item.base)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div
                key={file.fileId}
                className="rounded-control border border-border p-3"
              >
                <p className="mb-2 text-xs font-medium text-fg-muted uppercase">
                  {file.fileId}
                </p>
                <p className="text-sm text-fg">
                  {file.conflicts} conflicting{" "}
                  {file.conflicts === 1 ? "line" : "lines"}
                </p>
              </div>
            ),
          )}
        </div>
      ) : null}
      <ul className="flex flex-wrap gap-1.5">
        {current.diff.semantic.map((chip, index) => (
          <ChangeChip key={`${current.id}-${index}`} chip={chip} />
        ))}
      </ul>
      {restarts > 0 ? (
        <Alert kind="warning">
          <span className="flex items-center gap-1.5 font-medium">
            <RotateCw className="size-4 shrink-0" aria-hidden="true" />
            {restarts} {restarts === 1 ? "setting needs" : "settings need"} a
            server restart to take effect.
          </span>
          <p className="mt-1">
            Restarting the server from Dialwarden arrives with phase P6; until
            then restart it the way you always do.
          </p>
        </Alert>
      ) : null}
      {current.lint.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {current.lint.map((entry, index) => {
            const kind = lintKind(entry.severity);
            return (
              <p
                key={`${current.id}-lint-${index}`}
                className="flex items-start gap-2 text-sm"
              >
                {kind === undefined ? null : (
                  <Badge kind={kind}>{lintWord(entry.severity)}</Badge>
                )}
                <span>
                  {entry.message}
                  {entry.line !== null ? ` (line ${entry.line})` : ""}
                </span>
              </p>
            );
          })}
        </div>
      ) : null}
      {current.diff.text.map((part) => {
        const sides = splitUnifiedDiff(part.unifiedDiff);
        return (
          <div key={part.fileId} className="flex flex-col gap-1">
            <p className="text-xs font-medium text-fg-muted uppercase">
              {part.fileId}
            </p>
            <LazyDiffEditor
              before={sides.before}
              after={sides.after}
              language={fileLanguage?.(part.fileId) ?? "ini"}
            />
          </div>
        );
      })}
    </Dialog>
  );
}
