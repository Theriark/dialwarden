// The licence page (contract C1): plan, state, source, the licence facts, the
// 30-day warning, paste and remove (owner), and the owner-only switch
// "Use the Free plan on this instance" for a licence managed by the
// environment (dev-work-plan P1-A step 6).
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { KeyRound, Server, Upload } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { errorMessage } from "../../api/errors";
import {
  editableServersQuery,
  entitlementQuery,
  invalidatePlanDependent,
  keys,
  registryQuery,
} from "../../api/queries";
import type {
  Entitlement,
  LicenceState,
  PaymentRequiredBody,
} from "../../api/schema";
import { useIsOwner } from "../../api/session";
import { UpgradeHint } from "../../components/upgrade-hint";
import { Alert } from "../../components/ui/alert";
import { Badge, type BadgeKind } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, Fact } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/dialog";
import { TextAreaField } from "../../components/ui/field";
import { CardSkeleton, ErrorState } from "../../components/ui/states";
import { SwitchField } from "../../components/ui/switch";
import { useToast } from "../../components/ui/toast";
import { daysUntil, formatDate } from "../../lib/format";

export function stateLabel(state: LicenceState): string {
  switch (state) {
    case "active":
      return "Active";
    case "term_ended_for_this_version":
      return "Updates ended for this version";
    case "revoked":
      return "Revoked";
    case "invalid_signature":
      return "Signature not valid";
    case "malformed":
      return "Not a licence key";
    case "dev_window_passed":
      return "Development window passed";
    default:
      return "No licence";
  }
}

export function stateKind(state: LicenceState): BadgeKind {
  switch (state) {
    case "active":
      return "success";
    case "term_ended_for_this_version":
    case "dev_window_passed":
      return "warning";
    case "revoked":
    case "invalid_signature":
    case "malformed":
      return "error";
    default:
      return "neutral";
  }
}

const LIST_ICON = "size-4 shrink-0 text-primary";
const UI_OVERRIDES =
  "A key added in the UI decides while it is stored. Remove it to use the environment licence again.";

/**
 * A licence change answers the new entitlement; the plan badge of About
 * (/healthz), the editable servers of the Free hint, and the P8 answers
 * that depend on the plan (users, invitations, audit export, tokens, single
 * sign-on) follow it without a reload.
 */
function applyEntitlement(client: QueryClient, data: Entitlement): void {
  client.setQueryData(keys.entitlement, data);
  void client.invalidateQueries({ queryKey: keys.health });
  void client.invalidateQueries({ queryKey: keys.editable });
  invalidatePlanDependent(client);
}

function kindLabel(kind: "customer" | "internal-dev" | null): string {
  if (kind === "customer") {
    return "Customer";
  }
  if (kind === "internal-dev") {
    return "Internal development";
  }
  return "—";
}

function SourceBadge({ source }: { source: Entitlement["source"] }) {
  if (source === "ui") {
    return (
      <Badge kind="info" icon={<Upload className="size-3.5" />}>
        Added in the UI
      </Badge>
    );
  }
  if (source === "environment") {
    return (
      <Badge kind="neutral" icon={<Server className="size-3.5" />}>
        Managed by the environment
      </Badge>
    );
  }
  return null;
}

function PlanCard({ entitlement }: { entitlement: Entitlement }) {
  const licence = entitlement.licence;
  const paid = entitlement.plan === "paid";
  const until = licence?.updatesUntil ?? null;
  const days = until === null ? null : daysUntil(until);
  const warning =
    until === null
      ? ""
      : `Updates end on ${formatDate(until)} (${days ?? 0} days). This version keeps Paid; releases after that date need a renewed key.`;
  return (
    <Card
      title={paid ? "Dialwarden Paid" : "Dialwarden Free"}
      description={
        paid
          ? "Every feature and limit of the Paid plan is on."
          : "Three editable servers, five visible versions and three presets."
      }
      aside={
        <div className="flex flex-wrap gap-2">
          <Badge kind={paid ? "success" : "info"}>
            {paid ? "Paid" : "Free"}
          </Badge>
          <Badge kind={stateKind(entitlement.state)}>
            {stateLabel(entitlement.state)}
          </Badge>
          <SourceBadge source={entitlement.source} />
        </div>
      }
    >
      {licence !== null && licence.warn30 && until !== null ? (
        <Alert kind="warning" title="Updates end soon">
          {warning}
        </Alert>
      ) : null}
      {licence !== null ? (
        <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <Fact label="Customer">{licence.customerName ?? "—"}</Fact>
          <Fact label="Kind">{kindLabel(licence.kind)}</Fact>
          <Fact label="Issued on">{formatDate(licence.issuedAt)}</Fact>
          <Fact label="Updates until">{formatDate(licence.updatesUntil)}</Fact>
          <Fact label="Key id" mono>
            {`${licence.lidHash8 ?? "—"} …${licence.last6}`}
          </Fact>
          <Fact label="Build date">{formatDate(entitlement.buildDate)}</Fact>
        </dl>
      ) : (
        <p className="text-sm text-fg-muted">
          No licence key is in use. Paste one below to unlock the Paid plan.
        </p>
      )}
    </Card>
  );
}

/**
 * The Free state: what Paid adds, and the limit a Free instance meets first
 * (editable servers), rendered by the same UpgradeHint every 402 answer uses,
 * from the real entitlement and the real editable-servers count.
 */
function PaidList({ entitlement }: { entitlement: Entitlement }) {
  const registry = useQuery(registryQuery());
  const editable = useQuery(editableServersQuery());
  if (registry.data === undefined) {
    return null;
  }
  const features = registry.data.features.filter((f) => f.available);
  const max = entitlement.limits.servers;
  const hint: PaymentRequiredBody | null =
    max === null || editable.data === undefined
      ? null
      : {
          error: "payment_required",
          plan: "free",
          limit: "servers",
          current: editable.data.servers.length,
          max,
        };
  return (
    <Card
      title="What Paid adds"
      description="Unlocked by a licence key; no outside connection is needed."
    >
      {hint !== null ? <UpgradeHint body={hint} /> : null}
      <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        {features.map((feature) => (
          <li key={feature.key} className="flex items-center gap-2">
            <KeyRound className={LIST_ICON} aria-hidden="true" />
            {feature.label}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PasteCard({ entitlement }: { entitlement: Entitlement }) {
  const client = useQueryClient();
  const toast = useToast();
  const owner = useIsOwner();
  const [pasted, setPasted] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const paste = useMutation({
    mutationFn: (value: string) =>
      api<Entitlement>("/api/v1/licence", {
        method: "PUT",
        body: { token: value },
      }),
    onSuccess: (data) => {
      applyEntitlement(client, data);
      setPasted("");
      toast.push({
        kind: data.plan === "paid" ? "success" : "info",
        title: data.plan === "paid" ? "Paid plan is on" : "Licence stored",
        description: stateLabel(data.state),
      });
    },
  });
  const remove = useMutation({
    mutationFn: () => api<Entitlement>("/api/v1/licence", { method: "DELETE" }),
    onSuccess: (data) => {
      applyEntitlement(client, data);
      setRemoveOpen(false);
      toast.push({ kind: "success", title: "Licence removed" });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    paste.mutate(pasted.trim());
  };
  if (!owner) {
    return (
      <Card title="Licence key">
        <Alert kind="info">
          Only the owner can add or remove a licence key.
        </Alert>
      </Card>
    );
  }
  return (
    <Card
      title="Licence key"
      description="Paste the key you received. It is checked on this instance; nothing is sent anywhere."
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextAreaField
          id="licence-token"
          label="Key"
          placeholder="DW1.…"
          spellCheck={false}
          value={pasted}
          error={paste.isError ? errorMessage(paste.error) : undefined}
          onChange={(event) => {
            setPasted(event.target.value);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="primary"
            loading={paste.isPending}
            disabled={pasted.trim() === ""}
          >
            Use this key
          </Button>
          {entitlement.source === "ui" ? (
            <Button
              variant="destructive"
              onClick={() => {
                setRemoveOpen(true);
              }}
            >
              Remove the key
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove the licence key"
        description="The instance falls back to the environment licence, or to the Free plan, at once."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          remove.mutate();
        }}
      >
        {remove.isError ? (
          <Alert kind="error">{errorMessage(remove.error)}</Alert>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}

function EnvironmentCard({ entitlement }: { entitlement: Entitlement }) {
  const client = useQueryClient();
  const toast = useToast();
  const owner = useIsOwner();
  const env = entitlement.envLicence;
  const toggle = useMutation({
    mutationFn: (ignored: boolean) =>
      api<Entitlement>("/api/v1/licence/environment", {
        method: "PUT",
        body: { ignored },
      }),
    onSuccess: (data) => {
      applyEntitlement(client, data);
      toast.push({
        kind: "success",
        title: data.envLicence.ignored
          ? "This instance now runs the Free plan"
          : "The environment licence is back in use",
      });
    },
  });
  if (!env.present) {
    return null;
  }
  const overridden = entitlement.source === "ui";
  const unusable = `The environment licence is not usable: ${stateLabel(env.state).toLowerCase()}. The instance runs Free until it is replaced.`;
  return (
    <Card
      title="Licence managed by the environment"
      description="DIALWARDEN_LICENCE is set for this instance. It cannot be removed here."
      aside={<Badge kind={stateKind(env.state)}>{stateLabel(env.state)}</Badge>}
    >
      {env.state !== "active" ? <Alert kind="warning">{unusable}</Alert> : null}
      {overridden ? <Alert kind="info">{UI_OVERRIDES}</Alert> : null}
      {toggle.isError ? (
        <Alert kind="error">{errorMessage(toggle.error)}</Alert>
      ) : null}
      <SwitchField
        id="licence-env-ignored"
        label="Use the Free plan on this instance"
        description="Ignore the environment licence and run Free. Turn it off to return to Paid at once."
        checked={env.ignored}
        disabled={!owner || overridden || toggle.isPending}
        onCheckedChange={(checked) => {
          toggle.mutate(checked);
        }}
      />
      {!owner ? (
        <p className="text-sm text-fg-muted">Only the owner can change this.</p>
      ) : null}
    </Card>
  );
}

export function LicencePage() {
  const entitlement = useQuery(entitlementQuery());
  if (entitlement.isPending) {
    return (
      <>
        <CardSkeleton />
        <CardSkeleton />
      </>
    );
  }
  if (entitlement.isError) {
    return (
      <ErrorState
        message={errorMessage(entitlement.error)}
        onRetry={() => {
          void entitlement.refetch();
        }}
        retrying={entitlement.isFetching}
      />
    );
  }
  const data = entitlement.data;
  return (
    <>
      <PlanCard entitlement={data} />
      <EnvironmentCard entitlement={data} />
      <PasteCard entitlement={data} />
      {data.plan === "free" ? <PaidList entitlement={data} /> : null}
    </>
  );
}
