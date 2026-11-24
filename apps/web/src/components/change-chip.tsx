// The one shared change chip of contract C5 semantic[] (dev-work-plan P5):
// the fleet cards, the save dialog, the history timeline and the presets flow
// all render it, and schedules, reports and Discord previews reuse it later.
// It is presentational only: colours follow the badge palette of the design
// system and every kind carries an icon and text, never colour alone.
import {
  Download,
  EyeOff,
  FileCode2,
  FileWarning,
  Minus,
  PenLine,
  Plus,
  RotateCw,
  type LucideIcon,
} from "lucide-react";
import type { Chip, ChipKind } from "../api/schema";
import { cn } from "../lib/cn";

/** A value as a chip shows it: booleans as on and off, JSON kept compact. */
export function formatChipValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "not set";
  }
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value === "" ? '""' : value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

/** The full sentence of a chip, also its title and accessible name. */
export function chipText(chip: Chip): string {
  if (chip.kind === "lines") {
    // The server's line count already ends with the word changed, so the
    // chip never repeats it.
    const lines = typeof chip.to === "string" ? chip.to : "";
    return `${chip.label} ${lines}`.replace("  ", " ");
  }
  if (chip.kind === "external" || chip.kind === "import") {
    const what =
      chip.kind === "external" ? "edited outside Dialwarden" : "imported";
    const lines = typeof chip.to === "string" ? chip.to : "";
    return `${chip.label} ${lines} (${what})`.replace("  ", " ");
  }
  // The pack's label is the human name; the key is the fallback only.
  const label = chip.label === "" ? (chip.settingKey ?? "") : chip.label;
  const from = formatChipValue(chip.from);
  const to = formatChipValue(chip.to);
  if (from === "not set") {
    return `${label}: set to ${to}`;
  }
  if (to === "not set") {
    return `${label}: removed (was ${from})`;
  }
  return `${label}: ${from} → ${to}`;
}

function kindClass(kind: ChipKind): string {
  switch (kind) {
    case "added":
      return "border-success/40 bg-success-soft text-success";
    case "removed":
      return "border-error/40 bg-error-soft text-error";
    case "masked":
      return "border-border bg-surface text-fg-muted";
    case "external":
      return "border-warning/40 bg-warning-soft text-warning";
    default:
      return "border-info/40 bg-info-soft text-info";
  }
}

function kindIcon(kind: ChipKind): { Icon: LucideIcon; word: string } {
  switch (kind) {
    case "added":
      return { Icon: Plus, word: "Added" };
    case "removed":
      return { Icon: Minus, word: "Removed" };
    case "masked":
      return { Icon: EyeOff, word: "Secret" };
    case "lines":
      return { Icon: FileCode2, word: "Text" };
    case "external":
      return { Icon: FileWarning, word: "Outside edit" };
    case "import":
      return { Icon: Download, word: "Import" };
    default:
      return { Icon: PenLine, word: "Changed" };
  }
}

interface ChangeChipProps {
  chip: Chip;
  className?: string | undefined;
}

export function ChangeChip({ chip, className }: ChangeChipProps) {
  const { Icon, word } = kindIcon(chip.kind);
  const text = chipText(chip);
  return (
    <li
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        kindClass(chip.kind),
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{word}: </span>
      <span className="truncate" title={text}>
        {text}
      </span>
      {chip.restartRequired ? (
        <span
          className="inline-flex items-center gap-1 text-pending"
          title="The server must restart for this change to take effect"
        >
          <RotateCw className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">Restart required</span>
        </span>
      ) : null}
    </li>
  );
}
