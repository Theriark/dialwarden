// The bulk apply wizard (dev-work-plan P9-C step 1, Paid feature
// presets.bulk): from a preset on /presets, pick the servers of its game,
// review one diff per server (the drafts of POST bulk-drafts, each its own
// change set of cause preset), choose the hook mode of contract C5, apply
// (POST bulk-apply, one apply per server, never stopped by one failure) and
// read the results with the partial-failure report. Four steps in one
// dialog, every control a native one, so the keyboard walks it: Tab, Space
// on the boxes, Enter on Next.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  Layers,
  Lock,
  RotateCw,
  Server as ServerIcon,
} from "lucide-react";
import { useState } from "react";
import type { RunHooks } from "../api/changes";
import { ApiError } from "../api/client";
import { codeWords, errorMessage } from "../api/errors";
import { bulkApply, bulkDrafts } from "../api/fleet";
import { entitlementQuery, p4keys } from "../api/queries";
import type {
  BulkDraftItem,
  BulkReport,
  BulkReportItem,
  Chip,
  PaymentRequiredBody,
  Server,
  UserPreset,
} from "../api/schema";
import { cn } from "../lib/cn";
import { ChangeChip } from "./change-chip";
import { UpgradeHint } from "./upgrade-hint";
import { Alert } from "./ui/alert";
import { Badge, type BadgeKind } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export type WizardStep = "servers" | "review" | "hooks" | "results";

const STEPS: readonly { id: WizardStep; label: string }[] = [
  { id: "servers", label: "Servers" },
  { id: "review", label: "Review" },
  { id: "hooks", label: "Hooks" },
  { id: "results", label: "Results" },
];

const HOOK_OPTIONS: readonly {
  value: RunHooks;
  label: string;
  help: string;
}[] = [
  {
    value: "none",
    label: "Save only",
    help: "The files are written now; a change the game reads at start only waits as pending on a running server.",
  },
  {
    value: "restart",
    label: "Save and restart",
    help: "Writes the files, then runs each server's restart hook; a server without one answers refused and keeps its draft.",
  },
  {
    value: "stop-start",
    label: "Stop, save and start",
    help: "Stops each server, writes the files and starts it again; a server without both hooks answers refused.",
  },
];

const OPTION =
  "flex cursor-pointer gap-3 rounded-control border border-border-strong bg-surface p-3 has-[:checked]:border-primary has-[:checked]:bg-accent-soft";

/** The words and badge of one result item of the partial-failure report. */
export function resultWords(item: BulkReportItem): {
  kind: BadgeKind;
  word: string;
  detail: string;
} {
  switch (item.status) {
    case "applied":
      return {
        kind: "success",
        word: "Applied",
        detail: "The files hold the new values.",
      };
    case "pending":
      return {
        kind: "pending",
        word: "Pending",
        detail: "Written when the server is stopped next.",
      };
    case "conflict":
      return {
        kind: "error",
        word: "Conflict",
        detail: "The file changed outside Dialwarden; the draft is closed.",
      };
    case "refused":
      return {
        kind: "error",
        word: "Refused",
        detail: codeWords(item.error?.code ?? "forbidden"),
      };
    case "failed":
      return {
        kind: "error",
        word: "Failed",
        detail:
          item.error?.message ?? codeWords(item.error?.code ?? "internal"),
      };
    default:
      return { kind: "neutral", word: item.status, detail: "" };
  }
}

/**
 * A server takes a bulk draft when the plan lets it be edited and this
 * caller may write it (P10-A L22); the others stay listed with the reason.
 */
export function bulkSelectable(server: Server): boolean {
  return server.editable && server.access !== "read";
}

/**
 * The chips worth reading in a review (P9 live check L2): a flag set to off
 * where the file held nothing changes nothing the game sees, so a server
 * without the launch file would otherwise show one such chip per flag.
 * They are counted in one muted line instead.
 */
export function splitQuietChips(chips: readonly Chip[]): {
  shown: Chip[];
  quiet: Chip[];
} {
  const quiet = chips.filter(
    (chip) => chip.kind === "added" && chip.to === false,
  );
  const shown = chips.filter((chip) => !quiet.includes(chip));
  return { shown, quiet };
}

function StepList({ current }: { current: WizardStep }) {
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <ol
      aria-label="Steps"
      className="flex flex-wrap gap-2 text-xs font-medium text-fg-muted"
    >
      {STEPS.map((step, position) => {
        const done = position < index;
        const active = step.id === current;
        return (
          <li
            key={step.id}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1",
              active
                ? "border-primary bg-accent-soft text-fg"
                : done
                  ? "border-success/40 bg-success-soft text-success"
                  : "border-border bg-surface",
            )}
          >
            {done ? (
              <CircleCheck className="size-3.5" aria-hidden="true" />
            ) : (
              <span
                aria-hidden="true"
                className="flex size-4 items-center justify-center rounded-full bg-surface text-[10px]"
              >
                {position + 1}
              </span>
            )}
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

export interface BulkApplyWizardProps {
  preset: UserPreset;
  /** The servers of the preset's game. */
  servers: readonly Server[];
  onClose: () => void;
}

export function BulkApplyWizard({
  preset,
  servers,
  onClose,
}: BulkApplyWizardProps) {
  const client = useQueryClient();
  const entitlement = useQuery(entitlementQuery());
  const [step, setStep] = useState<WizardStep>("servers");
  const [selected, setSelected] = useState<string[]>(() =>
    servers.filter(bulkSelectable).map((server) => server.id),
  );
  const [drafts, setDrafts] = useState<readonly BulkDraftItem[]>([]);
  const [runHooks, setRunHooks] = useState<RunHooks>("none");
  const [report, setReport] = useState<BulkReport | null>(null);
  const [payment, setPayment] = useState<PaymentRequiredBody | null>(null);

  const bulkOff =
    entitlement.data !== undefined &&
    entitlement.data.features["presets.bulk"] === false;
  const featureHint: PaymentRequiredBody = {
    error: "payment_required",
    plan: "free",
    feature: "presets.bulk",
  };

  const draft = useMutation({
    mutationFn: () => bulkDrafts(preset.id, selected),
    onSuccess: (answer) => {
      setPayment(null);
      setDrafts(answer.items);
      setStep("review");
    },
    onError: (error) => {
      setPayment(error instanceof ApiError ? error.paymentRequired : null);
    },
  });

  const ready = drafts.filter((item) => item.changeSet !== null);

  const apply = useMutation({
    mutationFn: () =>
      bulkApply(
        ready.map((item) => item.changeSet?.id ?? ""),
        runHooks,
      ),
    onSuccess: (answer) => {
      setPayment(null);
      setReport(answer);
      setStep("results");
      void client.invalidateQueries({ queryKey: p4keys.servers });
      void client.invalidateQueries({ queryKey: ["servers"] });
      void client.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (error) => {
      setPayment(error instanceof ApiError ? error.paymentRequired : null);
    },
  });

  const nameOf = (id: string | null): string =>
    servers.find((server) => server.id === id)?.name ?? id ?? "—";

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  };

  const restartsOf = (item: BulkDraftItem): number =>
    item.changeSet?.diff.semantic.filter((chip) => chip.restartRequired)
      .length ?? 0;

  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (step === "servers") {
    const allIds = servers.filter(bulkSelectable).map((server) => server.id);
    const every = allIds.every((id) => selected.includes(id));
    body = (
      <div className="flex flex-col gap-4">
        {bulkOff ? <UpgradeHint body={featureHint} /> : null}
        {payment !== null && !bulkOff ? <UpgradeHint body={payment} /> : null}
        {draft.isError && payment === null ? (
          <Alert kind="error">{errorMessage(draft.error)}</Alert>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 flex w-full flex-wrap items-center justify-between gap-2 text-sm font-medium text-fg">
            <span>
              Servers of {servers[0]?.displayName ?? "this game"} (
              {selected.length} of {servers.length} chosen)
            </span>
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setSelected(every ? [] : allIds);
              }}
            >
              {every ? "Clear" : "Choose all"}
            </Button>
          </legend>
          <ul className="flex max-h-72 flex-col gap-1.5 overflow-auto rounded-control border border-border p-2">
            {servers.map((server) => {
              const id = `bulk-server-${server.id}`;
              const readGrant = server.access === "read";
              return (
                <li key={server.id}>
                  <label
                    htmlFor={id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-control px-2 py-1.5 text-sm",
                      readGrant
                        ? "cursor-not-allowed opacity-70"
                        : "cursor-pointer hover:bg-accent-soft",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <input
                        id={id}
                        type="checkbox"
                        className="size-4 accent-[var(--dw-primary)]"
                        checked={selected.includes(server.id)}
                        disabled={readGrant}
                        onChange={() => {
                          toggle(server.id);
                        }}
                      />
                      <span className="truncate font-medium text-fg">
                        {server.name}
                      </span>
                      <span className="truncate text-xs text-fg-muted">
                        {server.os}
                      </span>
                    </span>
                    {readGrant ? (
                      <Badge kind="neutral" icon={<Eye className="size-3.5" />}>
                        Read access
                      </Badge>
                    ) : server.editable ? null : (
                      <Badge
                        kind="neutral"
                        icon={<Lock className="size-3.5" />}
                      >
                        Read-only on Free
                      </Badge>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-fg-muted">
            Each server gets its own draft from its own files; a server you
            cannot write answers in its own line, the others go on. A server
            your grant only reads stays out.
          </p>
        </fieldset>
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={draft.isPending}
          disabled={selected.length === 0 || bulkOff}
          onClick={() => {
            draft.mutate();
          }}
        >
          Next: review the diffs
        </Button>
      </>
    );
  } else if (step === "review") {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">
          {ready.length} of {drafts.length}{" "}
          {drafts.length === 1 ? "server has" : "servers have"} a change set
          ready. The chips show what each server's files will get.
        </p>
        <ol className="flex flex-col divide-y divide-border rounded-card border border-border">
          {drafts.map((item) => {
            const restarts = restartsOf(item);
            const chips = item.changeSet?.diff.semantic ?? [];
            const { shown, quiet } = splitQuietChips(chips);
            return (
              <li key={item.server} className="flex flex-col gap-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    <ServerIcon
                      className="size-4 shrink-0"
                      aria-hidden="true"
                    />
                    {nameOf(item.server)}
                  </span>
                  {item.changeSet === null ? (
                    <Badge
                      kind={item.error?.code === "no_change" ? "info" : "error"}
                    >
                      {item.error?.code === "no_change"
                        ? "Already holds these values"
                        : codeWords(item.error?.code ?? "internal")}
                    </Badge>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge kind="info" icon={<Layers className="size-3.5" />}>
                        {chips.length}{" "}
                        {chips.length === 1 ? "setting" : "settings"}
                      </Badge>
                      {restarts > 0 ? (
                        <Badge
                          kind="pending"
                          icon={<RotateCw className="size-3.5" />}
                        >
                          {restarts} need a restart
                        </Badge>
                      ) : null}
                    </span>
                  )}
                </div>
                {chips.length > 0 ? (
                  <ul className="flex flex-wrap items-center gap-1.5">
                    {shown.map((chip, index) => (
                      <ChangeChip key={`${item.server}-${index}`} chip={chip} />
                    ))}
                    {quiet.length > 0 ? (
                      <li
                        className="text-xs text-fg-muted"
                        title={quiet
                          .map((chip) => chip.label || chip.settingKey || "")
                          .join(", ")}
                      >
                        {quiet.length}{" "}
                        {quiet.length === 1
                          ? "flag stays off (it was not set)"
                          : "flags stay off (they were not set)"}
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    );
    footer = (
      <>
        <Button
          variant="ghost"
          onClick={() => {
            setStep("servers");
          }}
        >
          Back
        </Button>
        <Button
          variant="primary"
          disabled={ready.length === 0}
          onClick={() => {
            setStep("hooks");
          }}
        >
          Next: hooks
        </Button>
      </>
    );
  } else if (step === "hooks") {
    body = (
      <div className="flex flex-col gap-4">
        {payment !== null ? <UpgradeHint body={payment} /> : null}
        {apply.isError && payment === null ? (
          <Alert kind="error">{errorMessage(apply.error)}</Alert>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-fg">
            After writing the files on {ready.length}{" "}
            {ready.length === 1 ? "server" : "servers"}
          </legend>
          {HOOK_OPTIONS.map((option) => (
            <label key={option.value} className={OPTION}>
              <input
                type="radio"
                name="bulk-hooks"
                value={option.value}
                className="mt-1 accent-primary"
                checked={runHooks === option.value}
                onChange={() => {
                  setRunHooks(option.value);
                }}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-fg">
                  {option.label}
                </span>
                <span className="text-sm text-fg-muted">{option.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
    );
    footer = (
      <>
        <Button
          variant="ghost"
          disabled={apply.isPending}
          onClick={() => {
            setStep("review");
          }}
        >
          Back
        </Button>
        <Button
          variant="primary"
          loading={apply.isPending}
          onClick={() => {
            apply.mutate();
          }}
        >
          Apply to {ready.length} {ready.length === 1 ? "server" : "servers"}
        </Button>
      </>
    );
  } else {
    const done = report ?? { items: [], applied: 0, pending: 0, failed: 0 };
    const good = done.applied + done.pending;
    const tile = (
      icon: React.ReactNode,
      label: string,
      value: number,
      tone: string,
    ) => (
      <div
        className={cn("flex flex-col gap-0.5 rounded-card border p-3", tone)}
      >
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase">
          {icon}
          {label}
        </span>
        <span className="font-heading text-2xl font-semibold text-fg">
          {value}
        </span>
      </div>
    );
    body = (
      <div className="flex flex-col gap-4">
        {done.failed === 0 ? (
          <Alert kind="success" title="Every server took the preset">
            {done.applied} applied, {done.pending} pending.
          </Alert>
        ) : good === 0 ? (
          <Alert kind="error" title="No server took the preset">
            Every apply failed; the drafts of the failed servers can be applied
            again from their history.
          </Alert>
        ) : (
          <Alert kind="warning" title="Partly applied">
            {good} of {done.items.length} servers took the preset; {done.failed}{" "}
            did not. The ones that failed keep their draft and the others are
            not rolled back.
          </Alert>
        )}
        <div className="grid grid-cols-3 gap-2">
          {tile(
            <CircleCheck className="size-3.5" aria-hidden="true" />,
            "Applied",
            done.applied,
            "border-success/40 bg-success-soft text-success",
          )}
          {tile(
            <Clock className="size-3.5" aria-hidden="true" />,
            "Pending",
            done.pending,
            "border-pending/40 bg-pending-soft text-pending",
          )}
          {tile(
            <CircleX className="size-3.5" aria-hidden="true" />,
            "Failed",
            done.failed,
            "border-error/40 bg-error-soft text-error",
          )}
        </div>
        <table
          className="w-full border-collapse text-sm"
          aria-label="Results by server"
        >
          <thead>
            <tr>
              <th
                scope="col"
                className="border-b border-border-strong py-2 text-left text-xs font-medium tracking-wide text-fg-muted uppercase"
              >
                Server
              </th>
              <th
                scope="col"
                className="border-b border-border-strong py-2 text-left text-xs font-medium tracking-wide text-fg-muted uppercase"
              >
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {done.items.map((item) => {
              const words = resultWords(item);
              return (
                <tr key={item.changeSetId}>
                  <td className="border-b border-border py-2 pr-3 align-top font-medium text-fg">
                    {nameOf(item.server)}
                  </td>
                  <td className="border-b border-border py-2 align-top">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge kind={words.kind}>{words.word}</Badge>
                      <span className="text-xs text-fg-muted">
                        {words.detail}
                      </span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
    footer = (
      <Button variant="primary" onClick={onClose}>
        Close
      </Button>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title={`Apply ${preset.name} to many servers`}
      description={
        step === "results"
          ? "What each server did with the preset."
          : "One change set per server, applied one after the other."
      }
      className="max-w-3xl"
      footer={footer}
    >
      <StepList current={step} />
      {body}
    </Dialog>
  );
}
