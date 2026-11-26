// The background drift check of one server (dev-work-plan P9-C step 3,
// Paid feature drift.background), on the history page: whether the check
// is on and how often, the last result with its time, a check now (read
// access, like opening the editor), and the switch and interval for the
// owner and admins. On Free the card says the checks are part of the Paid
// plan and that the detection on every open stays free.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CircleCheck, CircleX, FileWarning, Radar } from "lucide-react";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import { checkDrift, setDrift } from "../api/fleet";
import { driftQuery, p4keys, p9keys } from "../api/queries";
import { DRIFT_INTERVAL, type Drift } from "../api/schema";
import { useCanConfigureHooks } from "../api/session";
import { formatDateTime } from "../lib/format";
import { UpgradeHint } from "./upgrade-hint";
import { Alert } from "./ui/alert";
import { Badge, type BadgeKind } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { TextField } from "./ui/field";
import { Skeleton } from "./ui/states";
import { SwitchField } from "./ui/switch";
import { useToast } from "./ui/toast";

/** The badge of a drift answer: never colour alone. */
export function driftWords(drift: Drift | undefined): {
  kind: BadgeKind;
  word: string;
} {
  if (drift === undefined || drift.lastResult === null) {
    return { kind: "neutral", word: "Not checked yet" };
  }
  if (drift.lastResult === "drift") {
    return { kind: "warning", word: "Drift found" };
  }
  if (drift.lastResult === "error") {
    return { kind: "error", word: "Check failed" };
  }
  return { kind: "success", word: "Clean" };
}

function DriftBadge({ drift }: { drift: Drift | undefined }) {
  const { kind, word } = driftWords(drift);
  const icon =
    kind === "warning" ? (
      <FileWarning className="size-3.5" aria-hidden="true" />
    ) : kind === "error" ? (
      <CircleX className="size-3.5" aria-hidden="true" />
    ) : kind === "success" ? (
      <CircleCheck className="size-3.5" aria-hidden="true" />
    ) : (
      <Radar className="size-3.5" aria-hidden="true" />
    );
  return (
    <Badge kind={kind} icon={icon}>
      {word}
    </Badge>
  );
}

export function DriftCard({ slug }: { slug: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const canConfigure = useCanConfigureHooks();
  const list = useQuery(driftQuery());
  const drift = list.data?.items.find((item) => item.serverId === slug);
  const [enabled, setEnabled] = useState(false);
  const [interval, setInterval] = useState(String(DRIFT_INTERVAL.default));

  const storedEnabled = drift?.enabled;
  const storedInterval = drift?.intervalMinutes;
  useEffect(() => {
    // The stored settings arrive, or a save answers: the form follows. Only
    // the two stored values count, so a refetch that moves lastCheckedAt
    // (a background check, a focus) leaves an interval being typed alone.
    if (storedEnabled !== undefined && storedInterval !== undefined) {
      setEnabled(storedEnabled);
      setInterval(String(storedInterval));
    }
  }, [storedEnabled, storedInterval]);

  const settle = (answer: Drift) => {
    client.setQueryData(
      p9keys.drift,
      (current: { items: Drift[] } | undefined) => {
        const items = (current?.items ?? []).filter(
          (item) => item.serverId !== slug,
        );
        return { items: [...items, answer] };
      },
    );
    void client.invalidateQueries({ queryKey: p4keys.history(slug) });
    void client.invalidateQueries({ queryKey: ["activity"] });
  };

  const save = useMutation({
    mutationFn: (input: { enabled: boolean; intervalMinutes: number }) =>
      setDrift(slug, input),
    onSuccess: (answer) => {
      settle(answer);
      toast.push({
        kind: "success",
        title: answer.enabled
          ? `Background check every ${answer.intervalMinutes} minutes`
          : "Background check off",
      });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The drift settings were not saved",
        description: errorMessage(error),
      });
    },
  });

  const check = useMutation({
    mutationFn: () => checkDrift(slug),
    onSuccess: (answer) => {
      settle(answer);
      const { word } = driftWords(answer);
      toast.push({
        kind: answer.lastResult === "error" ? "error" : "success",
        title: `Checked: ${word.toLowerCase()}`,
        description:
          answer.lastResult === "drift"
            ? "The outside edit is in the history below."
            : answer.lastResult === "error"
              ? (answer.lastError ?? "The files could not be read.")
              : "The files match the last known values.",
      });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The check did not run",
        description: errorMessage(error),
      });
    },
  });

  if (list.isPending) {
    return (
      <Card title="Background drift check">
        <Skeleton className="h-5 w-56" />
      </Card>
    );
  }

  if (list.isError) {
    const payment =
      list.error instanceof ApiError ? list.error.paymentRequired : null;
    if (payment !== null) {
      return (
        <Card
          title="Background drift check"
          description="Checks the files on a timer and records an outside edit before anyone opens the editor."
          aside={<Badge kind="neutral">Paid</Badge>}
        >
          <UpgradeHint body={payment} />
          <p className="text-sm text-fg-muted">
            Opening the editor still finds an outside edit on every plan.
          </p>
        </Card>
      );
    }
    return (
      <Card title="Background drift check">
        <Alert kind="error">{errorMessage(list.error)}</Alert>
      </Card>
    );
  }

  const minutes = Number(interval);
  const intervalOk =
    Number.isInteger(minutes) &&
    minutes >= DRIFT_INTERVAL.min &&
    minutes <= DRIFT_INTERVAL.max;
  const dirty =
    drift === undefined
      ? enabled || minutes !== DRIFT_INTERVAL.default
      : enabled !== drift.enabled || minutes !== drift.intervalMinutes;

  return (
    <Card
      title="Background drift check"
      description={
        drift?.enabled === true
          ? `Every ${drift.intervalMinutes} minutes; next ${formatDateTime(drift.nextCheckAt)}.`
          : "Off: an outside edit is found when someone opens the editor."
      }
      aside={<DriftBadge drift={drift} />}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium text-fg-muted">Last checked:</dt>
          <dd className="text-fg">{formatDateTime(drift?.lastCheckedAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium text-fg-muted">Result:</dt>
          <dd className="text-fg">
            {drift?.lastResult === "error"
              ? (drift.lastError ?? "error")
              : drift?.lastResult === "drift"
                ? "files changed outside Dialwarden"
                : drift?.lastResult === "clean"
                  ? "files match"
                  : "—"}
          </dd>
        </div>
      </dl>
      {canConfigure ? (
        <div className="flex flex-col gap-3 rounded-control border border-border p-3">
          <SwitchField
            id={`drift-enabled-${slug}`}
            label="Check on a timer"
            description="Reads the files at the interval below and records an outside edit as a history entry and an activity event."
            checked={enabled}
            disabled={save.isPending}
            onCheckedChange={setEnabled}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-48">
              <TextField
                id={`drift-interval-${slug}`}
                label="Every (minutes)"
                type="number"
                min={DRIFT_INTERVAL.min}
                max={DRIFT_INTERVAL.max}
                value={interval}
                disabled={save.isPending}
                error={
                  intervalOk
                    ? undefined
                    : `Between ${DRIFT_INTERVAL.min} and ${DRIFT_INTERVAL.max} minutes.`
                }
                onChange={(event) => {
                  setInterval(event.target.value);
                }}
              />
            </div>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!intervalOk || !dirty}
              onClick={() => {
                save.mutate({ enabled, intervalMinutes: minutes });
              }}
            >
              Save drift settings
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">
          The owner and admins set the timer.
        </p>
      )}
      <div>
        <Button
          loading={check.isPending}
          icon={<Radar className="size-4" aria-hidden="true" />}
          onClick={() => {
            check.mutate();
          }}
        >
          Check now
        </Button>
      </div>
    </Card>
  );
}
