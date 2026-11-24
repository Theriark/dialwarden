// The shapes of contract C5 (dev-work-plan-2): change sets, their semantic
// and text diff, lint, the conflict view and history entries. Field names
// are exact; a change needs an R&D Lead task first.
import type { JsonValue } from "@dialwarden/packs-schema";

export const CHANGE_SET_STATUSES = [
  "draft",
  "pending",
  "applied",
  "conflict",
  "failed",
  "scheduled",
  "reverted",
] as const;

export type ChangeSetStatus = (typeof CHANGE_SET_STATUSES)[number];

/**
 * The hook mode an apply asks for (contract C5 runHooks): none writes only;
 * restart writes and runs the pack live-reload action when every changed
 * setting is liveReloadable, else the restart hook; stop-start stops the
 * server, writes while it is down and starts it again.
 */
export const RUN_HOOKS = ["none", "restart", "stop-start"] as const;

export type RunHooks = (typeof RUN_HOOKS)[number];

/**
 * Why a history entry exists. import is the first read of a server's files
 * (P4-A); the others are the causes of contract C5.
 */
export const CAUSES = [
  "app",
  "external",
  "rollback",
  "schedule",
  "preset",
  "import",
] as const;

export type Cause = (typeof CAUSES)[number];

/**
 * The state machine of a change set. A draft is applied (or becomes a
 * conflict, or fails); pending (P6, stopped-only files) and scheduled (P9)
 * wait and then do the same. A failed change set may be applied again; an
 * applied one becomes reverted when a rollback undoes it. conflict and
 * reverted are final: the next step is a new change set.
 */
const TRANSITIONS = new Map<ChangeSetStatus, readonly ChangeSetStatus[]>([
  ["draft", ["pending", "applied", "conflict", "failed", "scheduled"]],
  ["pending", ["applied", "conflict", "failed"]],
  ["scheduled", ["pending", "applied", "conflict", "failed", "reverted"]],
  ["failed", ["applied", "conflict", "failed"]],
  ["applied", ["reverted"]],
  ["conflict", []],
  ["reverted", []],
]);

/** True when a change set in status from may move to status to. */
export function canMove(from: ChangeSetStatus, to: ChangeSetStatus): boolean {
  return TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** True when POST /change-sets/ID/apply accepts a change set in status. */
export function isApplicable(status: ChangeSetStatus): boolean {
  return status === "draft" || status === "failed";
}

/**
 * One chip of the semantic diff (C5 semantic[]: settingKey, label, from, to,
 * restartRequired) with the kind the chip component draws and the file it is
 * in. lines, external and import chips name a file whose text changed
 * without a known setting changing: their to says how many lines.
 */
export type ChipKind =
  "changed" | "added" | "removed" | "masked" | "lines" | "external" | "import";

export interface Chip {
  readonly kind: ChipKind;
  readonly fileId: string;
  readonly settingKey: string | null;
  readonly label: string;
  readonly from: JsonValue;
  readonly to: JsonValue;
  readonly restartRequired: boolean;
}

export interface TextDiff {
  readonly fileId: string;
  readonly unifiedDiff: string;
}

export interface Diff {
  readonly semantic: Chip[];
  readonly text: TextDiff[];
}

/**
 * One finding of a change set: file lint (with line and column) or a
 * setting issue of validate(). serverEvaluated marks the rules only the
 * server runs on the real stored values (THE-2361); the browser skips those
 * rules and shows these issues instead.
 */
export interface LintEntry {
  readonly fileId: string | null;
  readonly settingKey: string | null;
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly serverEvaluated: boolean;
}

/** A setting both the change and an outside edit changed. */
export interface ConflictSetting {
  readonly settingKey: string;
  readonly label: string;
  readonly base: JsonValue;
  readonly ours: JsonValue;
  readonly theirs: JsonValue;
}

/** The conflict view of one file, by setting or by text. */
export type ConflictFile =
  | {
      readonly kind: "settings";
      readonly fileId: string;
      readonly settings: ConflictSetting[];
    }
  | {
      readonly kind: "text";
      readonly fileId: string;
      readonly conflicts: number;
      /** The change against the base it was made on (unified diff). */
      readonly ours: string;
      /** The outside edit against the same base (unified diff). */
      readonly theirs: string;
    };

export interface ChangeSetError {
  readonly code: string;
  readonly message: string;
}

export interface ChangeSetView {
  readonly id: string;
  readonly serverId: string;
  readonly status: ChangeSetStatus;
  readonly cause: Cause;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
  readonly restoreOf: string | null;
  readonly diff: Diff;
  readonly lint: LintEntry[];
  readonly conflict: { readonly files: ConflictFile[] } | null;
  readonly error: ChangeSetError | null;
}

export interface HistorySnapshot {
  readonly id: string;
  readonly fileId: string;
  readonly kind: string;
  readonly at: string;
}

export interface HistoryEntry {
  readonly changeSetId: string;
  readonly at: string;
  readonly author: string;
  readonly cause: Cause;
  readonly status: ChangeSetStatus;
  readonly chips: Chip[];
  /** The file versions the entry kept; POST /snapshots/ID/restore takes one. */
  readonly snapshots: HistorySnapshot[];
}

export interface History {
  readonly entries: HistoryEntry[];
  /** 5 on Free (limit historyVisible), null on Paid. */
  readonly visibleLimit: number | null;
  /** Older entries kept but not shown on Free. */
  readonly hiddenCount: number;
}
