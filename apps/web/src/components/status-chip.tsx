// The status chip of the fleet cards and the server pages (dev-work-plan
// P6-C step 4): running, stopped or unknown from the probe of contract C7,
// with the player count when the probe gives it. Unknown is never a red
// card: the reason sits in the title. A demo server carries the simulated
// badge, because its status never comes from a real game.
import { FlaskConical, Play, Square } from "lucide-react";
import type { ServerStatus } from "../api/schema";
import { errorMessage } from "../api/errors";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/states";
import { cn } from "../lib/cn";

export interface StatusChipProps {
  /** The probe answer; undefined while it loads or when it failed. */
  status?: ServerStatus | undefined;
  loading?: boolean | undefined;
  /** The query error, when the status route itself failed. */
  error?: unknown;
  /** True for a demo server: its state is not a real game's. */
  simulated?: boolean | undefined;
  className?: string | undefined;
}

/** The chip's words for one answer: "Running · 3 players", "Stopped", … */
export function statusWord(status: ServerStatus): string {
  if (status.state === "running") {
    if (status.players === null) {
      return "Running";
    }
    return `Running · ${status.players} ${
      status.players === 1 ? "player" : "players"
    }`;
  }
  if (status.state === "stopped") {
    return "Stopped";
  }
  return "Unknown";
}

/** Why the chip says unknown, for the title and the screen reader. */
export function unknownReason(status: ServerStatus): string {
  if (status.source === null) {
    return "No probe is configured for this server. Set one up on the Hooks tab.";
  }
  return `The ${status.source} probe did not answer.`;
}

export function StatusChip({
  status,
  loading = false,
  error,
  simulated = false,
  className,
}: StatusChipProps) {
  let chip: React.ReactNode;
  if (loading) {
    chip = (
      <span
        aria-busy="true"
        aria-label="Checking the server status"
        className="inline-flex"
      >
        <Skeleton className="h-6 w-24 rounded-full" />
      </span>
    );
  } else if (status === undefined) {
    const reason =
      error === undefined
        ? "The status has not been checked yet."
        : `The status could not be checked: ${errorMessage(error)}`;
    chip = (
      <span title={reason}>
        <Badge kind="info">Unknown</Badge>
        <span className="sr-only">{reason}</span>
      </span>
    );
  } else if (status.state === "running") {
    chip = (
      <span title={`Reported by the ${status.source ?? "probe"} probe`}>
        <Badge
          kind="success"
          icon={<Play className="size-3.5 shrink-0" aria-hidden="true" />}
        >
          {statusWord(status)}
        </Badge>
      </span>
    );
  } else if (status.state === "stopped") {
    chip = (
      <span title={`Reported by the ${status.source ?? "probe"} probe`}>
        <Badge
          kind="neutral"
          icon={<Square className="size-3.5 shrink-0" aria-hidden="true" />}
        >
          Stopped
        </Badge>
      </span>
    );
  } else {
    chip = (
      <span title={unknownReason(status)}>
        <Badge kind="info">Unknown</Badge>
        <span className="sr-only">{unknownReason(status)}</span>
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex flex-wrap items-center gap-1.5", className)}
    >
      {chip}
      {simulated ? (
        <span title="A demo server: this status is simulated, not read from a real game.">
          <Badge
            kind="info"
            icon={
              <FlaskConical className="size-3.5 shrink-0" aria-hidden="true" />
            }
          >
            Simulated
          </Badge>
        </span>
      ) : null}
    </span>
  );
}
