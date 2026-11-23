// The history timeline (screen 6 of dev-work-plan P5): the signature visual
// of Dialwarden — a vertical timeline of change sets, each a row of chips
// with the author, the time and the outside-edit marker, and one click puts
// the files back (POST /api/v1/snapshots/:id/restore, contract C5). On Free
// the five most recent versions are visible; the older ones are kept and
// visible on Paid.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Download,
  FileWarning,
  History,
  RotateCcw,
  Undo2,
  CalendarClock,
  Layers,
} from "lucide-react";
import { useState, type ComponentType } from "react";
import { restoreSnapshot } from "../api/changes";
import { errorMessage } from "../api/errors";
import { historyQuery, p4keys, serverQuery } from "../api/queries";
import type {
  Cause,
  ChangeSet,
  ChangeSetStatus,
  HistoryEntry as Entry,
  HistorySnapshot,
} from "../api/schema";
import { PageHeader } from "../components/layout/page-header";
import { ChangeChip } from "../components/change-chip";
import { UpgradeHint } from "../components/upgrade-hint";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { useToast } from "../components/ui/toast";
import { formatDateTime } from "../lib/format";
import { cn } from "../lib/cn";

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
      return "Failed to apply";
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

export function TimelineRow({
  entry,
  last,
  onRestore,
  restoring,
}: {
  entry: Entry;
  last: boolean;
  onRestore: (entry: Entry) => void;
  restoring: boolean;
}) {
  const CauseIcon = CAUSE_ICONS[entry.cause];
  const kind = STATUS_KINDS[entry.status];
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
        {entry.snapshots.length > 0 ? (
          <div>
            <Button
              loading={restoring}
              icon={<RotateCcw className="size-4" aria-hidden="true" />}
              onClick={() => {
                onRestore(entry);
              }}
            >
              Restore this version
            </Button>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">
            No stored version to restore for this entry.
          </p>
        )}
      </div>
    </li>
  );
}

export function ServerHistoryPage() {
  const params = useParams({ strict: false }) as { slug: string };
  const slug = params.slug;
  const server = useQuery(serverQuery(slug));
  const history = useQuery(historyQuery(slug));
  const client = useQueryClient();
  const toast = useToast();
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const restore = useMutation({
    mutationFn: async (entry: Entry) => {
      // One click puts every file back to this version: one restore per
      // file, of its before snapshot. The first answer that does not end
      // applied stops the loop - conflict and failed also come back with
      // HTTP 200, and a partial restore must not claim success.
      let last: ChangeSet | null = null;
      for (const snapshot of snapshotsToRestore(entry)) {
        last = await restoreSnapshot(snapshot.id);
        if (last.status !== "applied" && last.status !== "pending") {
          break;
        }
      }
      return last;
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
    onSuccess: (last) => {
      if (
        last === null ||
        last.status === "applied" ||
        last.status === "pending"
      ) {
        toast.push({
          kind: "success",
          title: "Version restored",
          description: "The files hold the older values again.",
        });
        return;
      }
      toast.push({
        kind: "error",
        title: "The version was not restored",
        description:
          last.status === "conflict"
            ? "The file changed outside Dialwarden. Restore the newest version again from the timeline."
            : (last.error?.message ?? "The server could not write the files."),
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
        actions={
          <Link
            to="/servers/$slug/settings"
            params={{ slug }}
            className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg transition-colors duration-150 hover:bg-accent-soft"
          >
            Back to settings
          </Link>
        }
      />
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
