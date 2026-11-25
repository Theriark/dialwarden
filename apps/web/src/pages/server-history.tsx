// The history timeline (screen 6 of dev-work-plan P5): the signature visual
// of Dialwarden — a vertical timeline of change sets, each a row of chips
// with the author, the time and the outside-edit marker, and one click puts
// the files back (POST /api/v1/snapshots/:id/restore, contract C5). On Free
// the five most recent versions are visible; the older ones are kept and
// visible on Paid.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  Clock,
  Download,
  FileWarning,
  History,
  RotateCcw,
  Square,
  Undo2,
  CalendarClock,
  Layers,
} from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import { SHELL_ADAPTERS, type PackFile } from "@dialwarden/packs-schema";
import { restoreSnapshot, runHook } from "../api/changes";
import { errorMessage } from "../api/errors";
import {
  historyQuery,
  hooksQuery,
  p4keys,
  p6keys,
  pendingQuery,
  serverQuery,
  settingsMetaQuery,
} from "../api/queries";
import type {
  Cause,
  ChangeSet,
  ChangeSetStatus,
  HistoryEntry as Entry,
  HistorySnapshot,
} from "../api/schema";
import {
  RESTORE_ROLES,
  SHELL_RESTORE_ROLES,
  useCanRestore,
  useCanRunHooks,
  useSessionUser,
} from "../api/session";
import { PageHeader } from "../components/layout/page-header";
import { ChangeChip } from "../components/change-chip";
import { ReadOnlyNotice } from "../components/read-only-notice";
import {
  isServerMissing,
  ServerMissingState,
} from "../components/server-missing";
import { ServerTabs } from "../components/server-tabs";
import { UpgradeHint } from "../components/upgrade-hint";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/dialog";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { useToast } from "../components/ui/toast";
import { formatDateTime } from "../lib/format";
import { cn } from "../lib/cn";
import { sourceWord } from "./server-hooks";

const CAUSE_WORDS: Record<Cause, string> = {
  app: "Changed in Dialwarden",
  external: "Edited outside Dialwarden",
  rollback: "Rollback",
  schedule: "Scheduled change",
  preset: "Preset applied",
  import: "First import",
};

const CAUSE_ICONS: Record<Cause, ComponentType<{ className?: string }>> = {
  app: History,
  external: FileWarning,
  rollback: Undo2,
  schedule: CalendarClock,
  preset: Layers,
  import: Download,
};

const STATUS_KINDS: Partial<
  Record<ChangeSetStatus, "warning" | "error" | "info" | "neutral" | "pending">
> = {
  pending: "pending",
  conflict: "error",
  failed: "error",
  scheduled: "info",
  reverted: "neutral",
};

function statusWord(status: ChangeSetStatus): string {
  switch (status) {
    case "pending":
      return "Waiting for the server to stop";
    case "conflict":
      return "Ended in a conflict";
    case "failed":
      return "Save failed";
    case "scheduled":
      return "Scheduled";
    case "reverted":
      return "Undone by a rollback";
    default:
      return "Applied";
  }
}

/**
 * The snapshots one click restores: at most one per file, and for an applied
 * change the before snapshot - the write path records before then after per
 * file, so restoring both would write the change right back. Entries with a
 * single snapshot per file (first import, outside edit) keep theirs.
 */
export function snapshotsToRestore(entry: Entry): HistorySnapshot[] {
  const wanted = new Map<string, HistorySnapshot>();
  for (const snapshot of entry.snapshots) {
    const chosen = wanted.get(snapshot.fileId);
    if (chosen === undefined) {
      wanted.set(snapshot.fileId, snapshot);
      continue;
    }
    if (chosen.kind !== "before" && snapshot.kind === "before") {
      wanted.set(snapshot.fileId, snapshot);
    }
  }
  return [...wanted.values()];
}

/**
 * Whether the signed-in user may restore an entry (P8 live check F1):
 * allowed; read-only for a viewer, who sees no restore control at all (the
 * page says why once); admin-only for an editor on a version that holds a
 * shell-read file, where the control stays visible but off with the reason.
 */
export type RestoreAccess = "allowed" | "read-only" | "admin-only";

export const ADMIN_ONLY_REASON =
  "This version holds a launch or shell file: restoring it needs the owner or an admin.";

/** The ids of the pack files a shell reads (the server's isShellFile rule). */
export function shellFileIds(files: readonly PackFile[]): ReadonlySet<string> {
  return new Set(
    files.filter((file) => SHELL_ADAPTERS.has(file.adapter)).map((f) => f.id),
  );
}

/** The access of one role to one entry, given the shell-read files. */
export function restoreAccessOf(
  role: string | null,
  entry: Entry,
  shellFiles: ReadonlySet<string>,
): RestoreAccess {
  if (role === null || !RESTORE_ROLES.includes(role)) {
    return "read-only";
  }
  if (SHELL_RESTORE_ROLES.includes(role)) {
    return "allowed";
  }
  const touchesShell = snapshotsToRestore(entry).some((snapshot) =>
    shellFiles.has(snapshot.fileId),
  );
  return touchesShell ? "admin-only" : "allowed";
}

export function TimelineRow({
  entry,
  last,
  onRestore,
  restoring,
  access = "allowed",
}: {
  entry: Entry;
  last: boolean;
  onRestore: (entry: Entry) => void;
  restoring: boolean;
  access?: RestoreAccess | undefined;
}) {
  const CauseIcon = CAUSE_ICONS[entry.cause];
  const kind = STATUS_KINDS[entry.status];
  const reasonId = `${entry.changeSetId}-restore-reason`;
  return (
    <li className="relative flex gap-4 pb-8">
      {last ? null : (
        <div
          aria-hidden="true"
          className="absolute top-5 left-[7px] -bottom-2 w-px bg-border"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "relative z-10 mt-1 flex size-[15px] shrink-0 rounded-full border-2",
          entry.cause === "external"
            ? "border-warning bg-warning-soft"
            : "border-primary bg-surface",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
          <span className="flex items-center gap-1 font-medium text-fg">
            <CauseIcon className="size-3.5 shrink-0" />
            {CAUSE_WORDS[entry.cause]}
          </span>
          <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
          <span>by {entry.author}</span>
          {kind === undefined ? null : (
            <Badge kind={kind}>{statusWord(entry.status)}</Badge>
          )}
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {entry.chips.map((chip, index) => (
            <ChangeChip key={`${entry.changeSetId}-${index}`} chip={chip} />
          ))}
        </ul>
        {entry.snapshots.length === 0 ? (
          <p className="text-xs text-fg-muted">
            Nothing to restore for this entry
          </p>
        ) : access === "read-only" ? null : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              loading={restoring}
              disabled={access === "admin-only"}
              aria-describedby={access === "admin-only" ? reasonId : undefined}
              title={access === "admin-only" ? ADMIN_ONLY_REASON : undefined}
              icon={<RotateCcw className="size-4" aria-hidden="true" />}
              onClick={() => {
                onRestore(entry);
              }}
            >
              Restore this version
            </Button>
            {access === "admin-only" ? (
              <span id={reasonId} className="text-xs text-fg-muted">
                {ADMIN_ONLY_REASON}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The pending list (dev-work-plan P6-C step 3): the change sets of this
 * server waiting for it to stop, oldest first, from GET pending (contract
 * C5), with the stop hook at hand when one can run it.
 */
export function PendingList({ slug }: { slug: string }) {
  const pending = useQuery(pendingQuery(slug));
  const hooks = useQuery(hooksQuery(slug));
  const canRun = useCanRunHooks();
  const client = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  const stop = useMutation({
    mutationFn: () => runHook(slug, "stop"),
    onSuccess: (answer) => {
      const flushed = answer.flushed ?? 0;
      toast.push({
        kind: "success",
        title: answer.stopped === true ? "Server stopped" : "Stop sent",
        description:
          answer.stopped === true
            ? `${flushed} pending ${flushed === 1 ? "change was" : "changes were"} written.`
            : "The probe did not see the server stopped within the wait; the pending changes are written at the next check that does.",
      });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The stop hook did not run",
        description: errorMessage(error),
      });
    },
    onSettled: () => {
      setConfirming(false);
      void client.invalidateQueries({ queryKey: p6keys.pending(slug) });
      void client.invalidateQueries({ queryKey: p6keys.status(slug) });
      void client.invalidateQueries({ queryKey: p4keys.history(slug) });
      void client.invalidateQueries({ queryKey: p4keys.settings(slug) });
      void client.invalidateQueries({ queryKey: ["activity"] });
    },
  });

  if (pending.isPending) {
    return <RowsSkeleton rows={2} />;
  }
  if (pending.isError) {
    return (
      <ErrorState
        message="The pending changes could not be loaded."
        onRetry={() => {
          void pending.refetch();
        }}
      />
    );
  }
  const items = pending.data.items;
  if (items.length === 0) {
    return null;
  }
  const stopSource = hooks.data?.available.stop ?? null;
  return (
    <Card
      title="Waiting for the server to stop"
      description="The game reads these files when it starts, so each change is written once the server is seen stopped, oldest first."
      aside={
        <Badge kind="pending">
          {items.length} pending {items.length === 1 ? "change" : "changes"}
        </Badge>
      }
    >
      <ol className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 py-3 first:pt-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
              <span className="flex items-center gap-1 font-medium text-fg">
                <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                Saved as pending
              </span>
              <time dateTime={item.createdAt}>
                {formatDateTime(item.createdAt)}
              </time>
              <span>by {item.author}</span>
            </div>
            <ul className="flex flex-wrap gap-1.5">
              {item.diff.semantic.map((chip, index) => (
                <ChangeChip key={`${item.id}-${index}`} chip={chip} />
              ))}
              {item.diff.semantic.length === 0
                ? item.diff.text.map((part) => (
                    <li
                      key={part.fileId}
                      className="inline-flex items-center rounded-full border border-info/40 bg-info-soft px-2 py-0.5 text-xs font-medium text-info"
                    >
                      {part.fileId}: text edited
                    </li>
                  ))
                : null}
            </ul>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-fg-muted">
          {stopSource === null
            ? "No hook can stop this server from here: stop it the way you always do, and the next status check writes the changes."
            : `The stop hook runs through the ${sourceWord(stopSource)} client and writes the changes once the server is down.`}
        </span>
        {stopSource !== null ? (
          <Button
            variant="primary"
            disabled={!canRun}
            loading={stop.isPending}
            icon={<Square className="size-4" aria-hidden="true" />}
            title={canRun ? undefined : "Running a hook needs the editor role"}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Stop the server now
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Stop the server now?"
        description="Players are disconnected. The pending changes are written once the probe sees the server stopped, and the start hook runs again when one asked for it."
        confirmLabel="Stop the server"
        destructive
        loading={stop.isPending}
        onConfirm={() => {
          stop.mutate();
        }}
      />
    </Card>
  );
}

export function ServerHistoryPage() {
  const params = useParams({ strict: false }) as { slug: string };
  const slug = params.slug;
  const server = useQuery(serverQuery(slug));
  const history = useQuery(historyQuery(slug));
  const client = useQueryClient();
  const toast = useToast();
  const user = useSessionUser();
  const canRestore = useCanRestore();
  // The pack's file list tells which snapshots hold a shell-read file; while
  // it is unknown (loading, or a failed read) the server's own check answers
  // a click, and the toast says why (live check F2).
  const packId = server.data?.packId;
  const meta = useQuery({
    ...settingsMetaQuery(packId ?? ""),
    enabled: packId !== undefined,
  });
  const shellFiles = useMemo(
    () => shellFileIds((meta.data?.files ?? []) as PackFile[]),
    [meta.data],
  );
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const restore = useMutation({
    mutationFn: async (entry: Entry) => {
      // One click puts every file back to this version: one restore per
      // file, of its before snapshot. The first answer that does not end
      // applied stops the loop - conflict and failed also come back with
      // HTTP 200, and a partial restore must not claim success.
      let last: ChangeSet | null = null;
      let written = 0;
      for (const snapshot of snapshotsToRestore(entry)) {
        last = await restoreSnapshot(snapshot.id);
        if (last.status !== "applied" && last.status !== "pending") {
          break;
        }
        written += 1;
      }
      return { last, written };
    },
    onMutate: (entry) => {
      setRestoringId(entry.changeSetId);
    },
    onSettled: () => {
      setRestoringId(null);
      void client.invalidateQueries({ queryKey: p4keys.history(slug) });
      void client.invalidateQueries({ queryKey: p4keys.settings(slug) });
      void client.invalidateQueries({ queryKey: p4keys.servers });
    },
    onSuccess: ({ last, written }) => {
      // The toast tells the truth about the files: pending means nothing
      // is written yet (the save dialog says the same), and a failure after
      // an earlier file applied says so instead of claiming nothing moved.
      if (last === null || last.status === "applied") {
        toast.push({
          kind: "success",
          title: "Version restored",
          description: "The files hold the older values again.",
        });
        return;
      }
      if (last.status === "pending") {
        toast.push({
          kind: "success",
          title: "Restore saved as pending",
          description:
            "The older values are written when the server is stopped next.",
        });
        return;
      }
      const reason =
        last.status === "conflict"
          ? "The file changed outside Dialwarden. Restore the newest version again from the timeline."
          : (last.error?.message ?? "The server could not write the files.");
      toast.push({
        kind: "error",
        title:
          written === 0
            ? "The version was not restored"
            : "The version was only partly restored",
        description:
          written === 0
            ? reason
            : `${written} ${written === 1 ? "file holds" : "files hold"} the older values; the next one did not. ${reason}`,
      });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The version was not restored",
        description: errorMessage(error),
      });
    },
  });

  if (server.isPending || history.isPending) {
    return (
      <>
        <PageHeader title="History" description="Loading the timeline…" />
        <RowsSkeleton rows={4} />
      </>
    );
  }

  if (isServerMissing(server.error) || isServerMissing(history.error)) {
    return <ServerMissingState />;
  }

  if (server.isError) {
    return (
      <ErrorState
        message="This server could not be loaded."
        onRetry={() => {
          void server.refetch();
        }}
      />
    );
  }

  const entries = history.data?.entries ?? [];
  const visibleLimit = history.data?.visibleLimit ?? null;
  const hiddenCount = history.data?.hiddenCount ?? 0;

  return (
    <>
      <PageHeader
        title={`${server.data.name} history`}
        description="Every change of this server, newest first. One click puts the settings back to how they were before a change."
      />
      <ServerTabs slug={slug} current="history" />
      {canRestore ? null : (
        <ReadOnlyNotice
          role={user?.role ?? "viewer"}
          reads="this history"
          writes="restores a version"
          className="mb-4"
        />
      )}
      <div className="mb-6 empty:hidden">
        <PendingList slug={slug} />
      </div>
      {history.isError ? (
        <ErrorState
          message="The history could not be loaded."
          onRetry={() => {
            void history.refetch();
          }}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<History className="size-6" aria-hidden="true" />}
          title="No changes yet"
          description="The first edit, the first import or the first outside edit appears here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          <ol className="flex flex-col">
            {entries.map((entry, index) => (
              <TimelineRow
                key={entry.changeSetId}
                entry={entry}
                last={index === entries.length - 1}
                onRestore={(item) => {
                  restore.mutate(item);
                }}
                restoring={restoringId === entry.changeSetId}
                access={restoreAccessOf(user?.role ?? null, entry, shellFiles)}
              />
            ))}
          </ol>
          {visibleLimit !== null && hiddenCount > 0 ? (
            <div className="flex flex-col gap-3">
              <Alert kind="info">
                {hiddenCount} older{" "}
                {hiddenCount === 1 ? "version is" : "versions are"} kept and
                visible on the Paid plan.
              </Alert>
              <UpgradeHint
                body={{
                  error: "payment_required",
                  plan: "free",
                  limit: "historyVisible",
                  max: visibleLimit,
                }}
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
