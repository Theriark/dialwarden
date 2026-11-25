// Privacy (dev-work-plan P8-B screen 5), on every plan: how long snapshots
// are kept (all within the meter, the newest N versions, or N days), how
// long the audit log is kept, and whether the audit log stores the client
// address in full, truncated or not at all. The owner and admins set them;
// everyone can download their own data here.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, History, MapPinOff, ScrollText } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage, fieldErrors } from "../../api/errors";
import {
  auditSettingsQuery,
  p8keys,
  snapshotSettingsQuery,
} from "../../api/queries";
import type {
  AuditSettings,
  IpMode,
  RetentionMode,
  SnapshotRetention,
} from "../../api/schema";
import { useCanManageUsers } from "../../api/session";
import {
  exportMe,
  saveAuditSettings,
  saveSnapshotSettings,
} from "../../api/team";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { TextField } from "../../components/ui/field";
import { CardSkeleton, ErrorState } from "../../components/ui/states";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { downloadBlob } from "../../lib/download";

const OPTION =
  "flex cursor-pointer gap-3 rounded-control border border-border-strong bg-surface p-3 has-[:checked]:border-primary has-[:checked]:bg-accent-soft has-[:focus-visible]:shadow-[0_0_0_2px_var(--dw-bg),0_0_0_4px_var(--dw-primary)] has-[:disabled]:opacity-60";

function RadioOption({
  name,
  value,
  checked,
  disabled,
  title,
  description,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  title: string;
  description: string;
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  return (
    <label className={cn(OPTION)}>
      <input
        type="radio"
        name={name}
        value={value}
        className="mt-1 size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={() => {
          onChange(value);
        }}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium text-fg">{title}</span>
        <span className="text-sm text-fg-muted">{description}</span>
        {checked && children !== undefined ? (
          <span className="pt-2">{children}</span>
        ) : null}
      </span>
    </label>
  );
}

function numberOrNull(text: string): number | null {
  const value = Number(text);
  return text.trim() === "" || !Number.isInteger(value) ? null : value;
}

function SnapshotCard({ current }: { current: SnapshotRetention }) {
  const client = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<RetentionMode>(current.mode);
  const [days, setDays] = useState(String(current.days ?? 30));
  const [versions, setVersions] = useState(String(current.versions ?? 20));
  useEffect(() => {
    setMode(current.mode);
    setDays(String(current.days ?? 30));
    setVersions(String(current.versions ?? 20));
  }, [current]);
  const save = useMutation({
    mutationFn: (input: SnapshotRetention) => saveSnapshotSettings(input),
    onSuccess: (data) => {
      client.setQueryData(p8keys.snapshots, data);
      toast.push({
        kind: "success",
        title: "Snapshot retention saved",
        description: "The daily job applies it after the backup.",
      });
    },
  });
  const fields = fieldErrors(save.error);
  const daysValue = numberOrNull(days);
  const versionsValue = numberOrNull(versions);
  const ready =
    mode === "all" ||
    (mode === "days" && daysValue !== null && daysValue >= 1) ||
    (mode === "versions" && versionsValue !== null && versionsValue >= 1);
  const changed =
    mode !== current.mode ||
    (mode === "days" && daysValue !== current.days) ||
    (mode === "versions" && versionsValue !== current.versions);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({
      mode,
      days: mode === "days" ? daysValue : null,
      versions: mode === "versions" ? versionsValue : null,
    });
  };
  const isMode = (value: string): value is RetentionMode =>
    value === "all" || value === "days" || value === "versions";
  return (
    <Card
      title="Snapshot retention"
      description="Every save keeps a snapshot of the files it changed, so a version can be restored. Choose how long they stay."
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {save.isError && fields.size === 0 ? (
          <Alert kind="error">{errorMessage(save.error)}</Alert>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Snapshot retention</legend>
          <RadioOption
            name="snapshot-mode"
            value="all"
            checked={mode === "all"}
            disabled={save.isPending}
            title="Keep every snapshot"
            description="Within the 1 GB snapshot meter of this instance. The default."
            onChange={(value) => {
              if (isMode(value)) setMode(value);
            }}
          />
          <RadioOption
            name="snapshot-mode"
            value="versions"
            checked={mode === "versions"}
            disabled={save.isPending}
            title="Keep the newest versions of every file"
            description="Older snapshots of a file are removed once more than this many exist."
            onChange={(value) => {
              if (isMode(value)) setMode(value);
            }}
          >
            <TextField
              id="snapshot-versions"
              label="Versions to keep"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              className="max-w-40"
              value={versions}
              disabled={save.isPending}
              error={fields.get("snapshotRetention.versions")}
              onChange={(event) => {
                setVersions(event.target.value);
              }}
            />
          </RadioOption>
          <RadioOption
            name="snapshot-mode"
            value="days"
            checked={mode === "days"}
            disabled={save.isPending}
            title="Keep the last days"
            description="Snapshots older than this many days are removed."
            onChange={(value) => {
              if (isMode(value)) setMode(value);
            }}
          >
            <TextField
              id="snapshot-days"
              label="Days to keep"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              className="max-w-40"
              value={days}
              disabled={save.isPending}
              error={fields.get("snapshotRetention.days")}
              onChange={(event) => {
                setDays(event.target.value);
              }}
            />
          </RadioOption>
        </fieldset>
        <p className="text-xs text-fg-muted">
          The newest snapshot of every file, and anything an open change set
          still needs, is always kept.
        </p>
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabled={!ready || !changed}
          >
            Save retention
          </Button>
        </div>
      </form>
    </Card>
  );
}

const IP_OPTIONS: readonly {
  value: IpMode;
  title: string;
  description: string;
}[] = [
  {
    value: "full",
    title: "Full address",
    description: "The client address as the request arrived, for forensics.",
  },
  {
    value: "truncated",
    title: "Truncated",
    description:
      "The network only: the last byte of an IPv4 address and the host part of an IPv6 address are dropped. The default.",
  },
  {
    value: "none",
    title: "None",
    description: "No address is stored with the rows.",
  },
];

function AuditCard({ current }: { current: AuditSettings }) {
  const client = useQueryClient();
  const toast = useToast();
  const [ipMode, setIpMode] = useState<IpMode>(current.ipMode);
  const [limited, setLimited] = useState(current.retentionDays !== null);
  const [days, setDays] = useState(String(current.retentionDays ?? 365));
  useEffect(() => {
    setIpMode(current.ipMode);
    setLimited(current.retentionDays !== null);
    setDays(String(current.retentionDays ?? 365));
  }, [current]);
  const save = useMutation({
    mutationFn: (input: AuditSettings) => saveAuditSettings(input),
    onSuccess: (data) => {
      client.setQueryData(p8keys.auditSettings, data);
      toast.push({
        kind: "success",
        title: "Audit settings saved",
        description:
          data.retentionDays === null
            ? "Every row is kept."
            : `Rows older than ${data.retentionDays} days are removed by the daily job, behind a checkpoint that keeps the chain valid.`,
      });
    },
  });
  const fields = fieldErrors(save.error);
  const daysValue = numberOrNull(days);
  const retentionDays = limited ? daysValue : null;
  const ready = !limited || (daysValue !== null && daysValue >= 1);
  const changed =
    ipMode !== current.ipMode || retentionDays !== current.retentionDays;
  const isIpMode = (value: string): value is IpMode =>
    value === "full" || value === "truncated" || value === "none";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({ ipMode, retentionDays });
  };
  return (
    <Card
      title="Audit log"
      description="What the hash-chained log keeps about the people in it, and for how long."
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {save.isError && fields.size === 0 ? (
          <Alert kind="error">{errorMessage(save.error)}</Alert>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 flex items-center gap-2 text-sm font-medium text-fg">
            <MapPinOff className="size-4" aria-hidden="true" />
            Client address
          </legend>
          {IP_OPTIONS.map((option) => (
            <RadioOption
              key={option.value}
              name="audit-ip"
              value={option.value}
              checked={ipMode === option.value}
              disabled={save.isPending}
              title={option.title}
              description={option.description}
              onChange={(value) => {
                if (isIpMode(value)) setIpMode(value);
              }}
            />
          ))}
          <p className="text-xs text-fg-muted">
            The address sits outside the hash, so a later change of this
            setting, or the erasure of a person, never breaks the chain.
          </p>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 flex items-center gap-2 text-sm font-medium text-fg">
            <History className="size-4" aria-hidden="true" />
            Retention
          </legend>
          <RadioOption
            name="audit-retention"
            value="all"
            checked={!limited}
            disabled={save.isPending}
            title="Keep every row"
            description="The log grows with the instance. The default."
            onChange={() => {
              setLimited(false);
            }}
          />
          <RadioOption
            name="audit-retention"
            value="days"
            checked={limited}
            disabled={save.isPending}
            title="Remove rows older than"
            description="The daily job removes them and writes a checkpoint, so the rest of the chain still verifies."
            onChange={() => {
              setLimited(true);
            }}
          >
            <TextField
              id="audit-days"
              label="Days to keep"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              className="max-w-40"
              value={days}
              disabled={save.isPending}
              error={fields.get("retentionDays")}
              onChange={(event) => {
                setDays(event.target.value);
              }}
            />
          </RadioOption>
        </fieldset>
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabled={!ready || !changed}
          >
            Save audit settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

function MyDataCard() {
  const toast = useToast();
  const download = useMutation({
    mutationFn: () => exportMe(),
    onSuccess: (result) => {
      downloadBlob(result.blob, result.filename ?? "dialwarden-export.json");
      toast.push({
        kind: "success",
        title: "Export started",
        description: "A JSON file with your account and your activity.",
      });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The export failed",
        description: errorMessage(error),
      });
    },
  });
  return (
    <Card
      title="Your data"
      description="Everything this instance holds about you, as one JSON file. No password, token or secret is in it."
    >
      <div>
        <Button
          loading={download.isPending}
          onClick={() => {
            download.mutate();
          }}
          icon={<Download className="size-4" aria-hidden="true" />}
        >
          Download my data
        </Button>
      </div>
    </Card>
  );
}

export function PrivacyPage() {
  const admin = useCanManageUsers();
  const snapshots = useQuery({ ...snapshotSettingsQuery(), enabled: admin });
  const audit = useQuery({ ...auditSettingsQuery(), enabled: admin });
  if (!admin) {
    return (
      <>
        <Card title="Privacy">
          <Alert kind="info">
            The owner and admins set the retention of snapshots and of the audit
            log.
          </Alert>
        </Card>
        <MyDataCard />
      </>
    );
  }
  if (snapshots.isPending || audit.isPending) {
    return (
      <>
        <CardSkeleton />
        <CardSkeleton />
      </>
    );
  }
  if (snapshots.isError || audit.isError) {
    return (
      <ErrorState
        message={errorMessage(snapshots.error ?? audit.error)}
        onRetry={() => {
          void snapshots.refetch();
          void audit.refetch();
        }}
        retrying={snapshots.isFetching || audit.isFetching}
      />
    );
  }
  return (
    <>
      <Alert kind="info" title="On every plan">
        <span className="flex items-start gap-2">
          <ScrollText className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          These privacy controls work on Free and Paid alike; recording never
          stops and the owner can always read and verify the log.
        </span>
      </Alert>
      <SnapshotCard current={snapshots.data.snapshotRetention} />
      <AuditCard current={audit.data} />
      <MyDataCard />
    </>
  );
}
