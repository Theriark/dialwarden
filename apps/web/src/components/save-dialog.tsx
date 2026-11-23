// The save dialog (screen 5 of dev-work-plan P5): what a change set will do
// before it is applied — the semantic chips, the text diff in the Monaco diff
// editor, the lint, the restart-required badges — and apply. Hooks (restart,
// stop and start) arrive with P6, so only "without a restart" is offered and
// the choice is shown disabled, never hidden.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
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
}

export function SaveDialog({
  slug,
  changeSet,
  onClose,
  onApplied,
}: SaveDialogProps) {
  const client = useQueryClient();
  const toast = useToast();

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
      }
    },
  });

  const restarts = changeSet.diff.semantic.filter(
    (chip) => chip.restartRequired,
  ).length;
  const applied = changeSet.status === "applied";
  const pending = changeSet.status === "pending";
  const conflict = changeSet.status === "conflict";
  const failed = changeSet.status === "failed";
  const done = applied || pending || conflict;

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
      description={`Change set of ${changeSet.diff.semantic.length} ${
        changeSet.diff.semantic.length === 1 ? "setting" : "settings"
      }, created ${formatDateTime(changeSet.createdAt)}.`}
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
            : `The last try failed: ${changeSet.error?.message ?? "the server could not write the files"}. A failed change set can be applied again.`}
        </Alert>
      ) : null}
      {conflict && changeSet.conflict !== null ? (
        <div className="flex flex-col gap-3">
          {changeSet.conflict.files.map((file) =>
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
        {changeSet.diff.semantic.map((chip, index) => (
          <ChangeChip key={`${changeSet.id}-${index}`} chip={chip} />
        ))}
      </ul>
      {restarts > 0 ? (
        <Alert kind="warning">
          <span className="flex items-center gap-1.5 font-medium">
            <RotateCw className="size-4 shrink-0" aria-hidden="true" />
            {restarts} {restarts === 1 ? "setting" : "settings"} need a server
            restart to take effect.
          </span>
          <p className="mt-1">
            Restarting the server from Dialwarden arrives with phase P6; until
            then restart it the way you always do.
          </p>
        </Alert>
      ) : null}
      {changeSet.lint.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {changeSet.lint.map((entry, index) => {
            const kind = lintKind(entry.severity);
            return (
              <p
                key={`${changeSet.id}-lint-${index}`}
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
      {changeSet.diff.text.map((part) => {
        const sides = splitUnifiedDiff(part.unifiedDiff);
        return (
          <div key={part.fileId} className="flex flex-col gap-1">
            <p className="text-xs font-medium text-fg-muted uppercase">
              {part.fileId}
            </p>
            <LazyDiffEditor before={sides.before} after={sides.after} />
          </div>
        );
      })}
    </Dialog>
  );
}
