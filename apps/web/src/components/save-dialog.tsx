// The save dialog (screen 5 of dev-work-plan P5): what a change set will do
// before it is applied — the semantic chips, the text diff in the Monaco diff
// editor, the lint, the restart-required badges — and the apply choice of
// P6-C: save only, or save and restart. Save and restart maps to the C5
// runHooks restart, or stop-start when the change touches a stopped-only
// file, so the server stops, writes and starts. A stopped-only change saved
// on a running server comes back pending and is written at the next stop.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, RotateCw } from "lucide-react";
import { useState } from "react";
import { applyChangeSet, type RunHooks } from "../api/changes";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import { hooksQuery, p4keys, p6keys, serverStatusQuery } from "../api/queries";
import type { ChangeSet, HooksView } from "../api/schema";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { useToast } from "./ui/toast";
import { ChangeChip } from "./change-chip";
import { LazyDiffEditor } from "./code-editor";
import { splitUnifiedDiff } from "../lib/unified-diff";
import { formatDateTime } from "../lib/format";
import { cn } from "../lib/cn";

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

export type ApplyChoice = "save" | "restart";

/**
 * The C5 runHooks of a choice: a change that touches a stopped-only file
 * needs the stop, write, start cycle; any other change is written and the
 * server restarted (or reloaded live when every setting allows it).
 */
export function runHooksOf(
  choice: ApplyChoice,
  stoppedOnly: boolean,
): RunHooks {
  if (choice === "save") return "none";
  return stoppedOnly ? "stop-start" : "restart";
}

/** True when some client can bring the server back after a write. */
export function canRestart(hooks: HooksView | undefined): boolean {
  if (hooks === undefined) return false;
  const { available } = hooks;
  return (
    available.restart !== null ||
    (available.stop !== null && available.start !== null) ||
    available.save !== null
  );
}

/** The files a change set writes, from its semantic and text diffs. */
export function touchedFiles(changeSet: ChangeSet): string[] {
  const files = new Set<string>();
  for (const chip of changeSet.diff.semantic) files.add(chip.fileId);
  for (const part of changeSet.diff.text) files.add(part.fileId);
  return [...files];
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
  /**
   * The ids of the pack files with applyPolicy stopped-only: a change to
   * one of them is read by the game at start only.
   */
  stoppedOnlyFiles?: readonly string[] | undefined;
}

const OPTION =
  "flex cursor-pointer gap-3 rounded-control border border-border-strong bg-surface p-3 has-[:checked]:border-primary has-[:checked]:bg-accent-soft has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";

export function SaveDialog({
  slug,
  changeSet,
  fileLanguage,
  stoppedOnlyFiles = [],
  onClose,
  onApplied,
}: SaveDialogProps) {
  const client = useQueryClient();
  const toast = useToast();
  // The change set the dialog shows: the draft it opened with until the
  // apply answers, then the returned one - the server also answers HTTP 200
  // with conflict or failed, and those must change this dialog, not vanish.
  const [returned, setReturned] = useState<ChangeSet | null>(null);
  const [choice, setChoice] = useState<ApplyChoice>("save");
  const [refused, setRefused] = useState<string | null>(null);
  const current = returned ?? changeSet;
  const hooks = useQuery(hooksQuery(slug));
  const status = useQuery(serverStatusQuery(slug));

  const stoppedOnly = touchedFiles(current).some((fileId) =>
    stoppedOnlyFiles.includes(fileId),
  );
  const running = status.data?.state === "running";
  const restartable = canRestart(hooks.data);

  const apply = useMutation({
    mutationFn: () =>
      applyChangeSet(changeSet.id, runHooksOf(choice, stoppedOnly)),
    onError: (error) => {
      if (error instanceof ApiError && error.code === "hook_not_configured") {
        setRefused(
          "No hook can restart this server yet, so nothing was written. Set one up on the Hooks tab, or save only.",
        );
        return;
      }
      toast.push({
        kind: "error",
        title: "The save failed",
        description: errorMessage(error),
      });
    },
    onSuccess: (applied) => {
      setReturned(applied);
      setRefused(null);
      void client.invalidateQueries({ queryKey: p4keys.settings(slug) });
      void client.invalidateQueries({ queryKey: p4keys.history(slug) });
      void client.invalidateQueries({ queryKey: p4keys.servers });
      void client.invalidateQueries({ queryKey: p6keys.status(slug) });
      void client.invalidateQueries({ queryKey: p6keys.pending(slug) });
      void client.invalidateQueries({ queryKey: ["activity"] });
      if (applied.status === "applied" || applied.status === "pending") {
        toast.push({
          kind: "success",
          title:
            applied.status === "pending" ? "Saved as pending" : "Changes saved",
          description:
            applied.status === "pending"
              ? "These files are written when the server is stopped next."
              : choice === "restart"
                ? "The files hold the new values and the restart hook ran."
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

  const saveOnlyHelp =
    stoppedOnly && running
      ? "The game reads these files at start only, and the server is running: the change waits as pending and is written when the server is stopped next."
      : stoppedOnly
        ? "The game reads these files at start only. The server is not seen running, so the files are written now."
        : "The files are written now; a restart is up to you.";
  const restartHelp = !restartable
    ? "No hook can restart this server yet."
    : stoppedOnly
      ? "Stops the server, writes the files, then starts it again."
      : "Writes the files, then restarts the server; a change the game reloads live is sent without a restart.";

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
              icon={
                choice === "restart" ? (
                  <RotateCw className="size-4" aria-hidden="true" />
                ) : undefined
              }
              onClick={() => {
                apply.mutate();
              }}
            >
              {choice === "restart" ? "Save and restart" : "Save"}
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
      {refused !== null ? <Alert kind="error">{refused}</Alert> : null}
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
      <div className="flex flex-wrap items-center gap-1.5">
        <ul className="flex flex-wrap gap-1.5">
          {current.diff.semantic.map((chip, index) => (
            <ChangeChip key={`${current.id}-${index}`} chip={chip} />
          ))}
        </ul>
        {stoppedOnly ? (
          <span title="The game reads these files when it starts; a running server keeps the change pending until it stops.">
            <Badge
              kind="pending"
              icon={<Pause className="size-3.5 shrink-0" aria-hidden="true" />}
            >
              Read at start only
            </Badge>
          </span>
        ) : null}
      </div>
      {restarts > 0 ? (
        <Alert kind="warning">
          <span className="flex items-center gap-1.5 font-medium">
            <RotateCw className="size-4 shrink-0" aria-hidden="true" />
            {restarts} {restarts === 1 ? "setting needs" : "settings need"} a
            server restart to take effect.
          </span>
          <p className="mt-1">
            Choose Save and restart below, or restart the server the way you
            always do.
          </p>
        </Alert>
      ) : null}
      {done || conflict ? null : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-fg">
            After saving
          </legend>
          <label className={OPTION}>
            <input
              type="radio"
              name="apply-choice"
              value="save"
              className="mt-1 accent-primary"
              checked={choice === "save"}
              onChange={() => {
                setChoice("save");
              }}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">Save only</span>
              <span className="text-sm text-fg-muted">{saveOnlyHelp}</span>
            </span>
          </label>
          <label className={OPTION}>
            <input
              type="radio"
              name="apply-choice"
              value="restart"
              className="mt-1 accent-primary"
              checked={choice === "restart"}
              disabled={!restartable}
              onChange={() => {
                setChoice("restart");
              }}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">
                Save and restart
              </span>
              <span className={cn("text-sm text-fg-muted")}>
                {restartHelp}
                {restartable ? null : (
                  <>
                    {" "}
                    <a
                      href={`/servers/${slug}/hooks`}
                      className="font-medium text-primary underline"
                    >
                      Set up a hook
                    </a>
                    .
                  </>
                )}
              </span>
            </span>
          </label>
        </fieldset>
      )}
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
