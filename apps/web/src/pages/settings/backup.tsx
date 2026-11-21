// Backups (owner): the local backups with time, size and integrity, Run now,
// the restore drill of one backup, and the passphrase export
// (/api/v1/system/backups, /api/v1/system/backup-export).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Download, Play, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { api, apiBlob } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { backupsQuery, keys, statusQuery } from "../../api/queries";
import type { BackupItem, DrillReport } from "../../api/schema";
import { useIsOwner } from "../../api/session";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { PasswordField } from "../../components/ui/field";
import {
  EmptyState,
  ErrorState,
  RowsSkeleton,
} from "../../components/ui/states";
import { Table, Td, Th } from "../../components/ui/table";
import { useToast } from "../../components/ui/toast";
import { downloadBlob } from "../../lib/download";
import {
  describeSchedule,
  formatBytes,
  formatDateTime,
} from "../../lib/format";
import {
  PASSPHRASE_HELP,
  passphraseProblem,
  passphraseReady,
} from "../../lib/passphrase";

const APP_SECRET_TEXT =
  "This instance generated DATA_DIR/app-secret.key at first start. A backup restores only with the same key, so keep a copy outside this server.";
const RETENTION_TEXT =
  "The last three days are kept, and never fewer than the last three good backups. Copies are local to this instance.";

function AppSecretBanner() {
  const client = useQueryClient();
  const status = useQuery(statusQuery());
  const acknowledge = useMutation({
    mutationFn: () =>
      api<undefined>("/api/v1/system/app-secret/acknowledge", {
        method: "POST",
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.status });
    },
  });
  if (status.data === undefined || !status.data.appSecret.showBackupBanner) {
    return null;
  }
  return (
    <Alert
      kind="warning"
      title="Back up the app secret key"
      action={
        <Button
          loading={acknowledge.isPending}
          onClick={() => {
            acknowledge.mutate();
          }}
        >
          I have backed it up
        </Button>
      }
    >
      {APP_SECRET_TEXT}
    </Alert>
  );
}

function ScheduleCard() {
  const status = useQuery(statusQuery());
  if (status.data === undefined) {
    return null;
  }
  const backups = status.data.backups;
  return (
    <Card
      title="Schedule"
      aside={
        backups.running ? (
          <Badge kind="pending">Backup running</Badge>
        ) : (
          <Badge kind="success">Idle</Badge>
        )
      }
    >
      <p className="text-sm text-fg">
        {describeSchedule(backups.schedule, backups.timezone)}
      </p>
      <p className="text-sm text-fg-muted">{RETENTION_TEXT}</p>
    </Card>
  );
}

function DrillDialog({
  report,
  onClose,
}: {
  report: DrillReport | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={report !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title="Restore drill"
      description={
        report === null
          ? ""
          : `Backup ${report.backupId}, ${report.durationMs} ms.`
      }
    >
      {report !== null ? (
        <ul className="flex flex-col gap-2 text-sm">
          {report.checks.map((check) => (
            <li key={check.name} className="flex items-start gap-2">
              <Badge kind={check.ok ? "success" : "error"}>
                {check.ok ? "ok" : "failed"}
              </Badge>
              <span className="min-w-0">
                <span className="font-medium text-fg">{check.name}</span>
                <span className="block text-fg-muted">{check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}

function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const [first, setFirst] = useState("");
  const [again, setAgain] = useState("");
  const exportBackup = useMutation({
    mutationFn: () =>
      apiBlob("/api/v1/system/backup-export", {
        method: "POST",
        body: { passphrase: first },
      }),
    onSuccess: (result) => {
      downloadBlob(result.blob, result.filename ?? "dialwarden-backup.dwbx");
      onOpenChange(false);
      setFirst("");
      setAgain("");
      toast.push({
        kind: "success",
        title: "Export started",
        description:
          "Keep the passphrase: the file cannot be opened without it.",
      });
    },
  });
  const mismatch = again !== "" && first !== again;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    exportBackup.mutate();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export an app backup"
      description="A fresh backup, encrypted with a passphrase you choose. It restores a new instance during first-run setup."
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {exportBackup.isError ? (
          <Alert kind="error">{errorMessage(exportBackup.error)}</Alert>
        ) : null}
        <PasswordField
          id="export-passphrase"
          label="Passphrase"
          help={PASSPHRASE_HELP}
          autoComplete="off"
          value={first}
          error={passphraseProblem(first) ?? undefined}
          onChange={(event) => {
            setFirst(event.target.value);
          }}
        />
        <PasswordField
          id="export-passphrase-again"
          label="Passphrase again"
          autoComplete="off"
          value={again}
          error={mismatch ? "The two passphrases differ." : undefined}
          onChange={(event) => {
            setAgain(event.target.value);
          }}
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            loading={exportBackup.isPending}
            disabled={!passphraseReady(first) || first !== again}
            icon={<Download className="size-4" aria-hidden="true" />}
          >
            Export
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function BackupRow({
  item,
  onDrill,
  drilling,
}: {
  item: BackupItem;
  onDrill: (id: string) => void;
  drilling: boolean;
}) {
  return (
    <tr>
      <Td mono>{formatDateTime(item.createdAt)}</Td>
      <Td align="right" mono>
        {formatBytes(item.sizeBytes)}
      </Td>
      <Td align="right" mono>
        {item.blobCount}
      </Td>
      <Td mono>{item.appVersion ?? "—"}</Td>
      <Td>
        {item.integrity === "ok" ? (
          <Badge kind="success">Verified</Badge>
        ) : (
          <Badge kind="error">Incomplete</Badge>
        )}
      </Td>
      <Td align="right">
        <Button
          size="md"
          loading={drilling}
          disabled={item.integrity !== "ok"}
          onClick={() => {
            onDrill(item.id);
          }}
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
        >
          Check
        </Button>
      </Td>
    </tr>
  );
}

function BackupsCard() {
  const client = useQueryClient();
  const toast = useToast();
  const backups = useQuery(backupsQuery());
  const [exportOpen, setExportOpen] = useState(false);
  const [report, setReport] = useState<DrillReport | null>(null);
  const [drillingId, setDrillingId] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () =>
      api<BackupItem>("/api/v1/system/backups", { method: "POST" }),
    onSuccess: (item) => {
      void client.invalidateQueries({ queryKey: keys.backups });
      toast.push({
        kind: "success",
        title: "Backup done",
        description: `${formatBytes(item.sizeBytes)}, integrity ${item.integrity}.`,
      });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "Backup failed",
        description: errorMessage(error),
      });
    },
  });

  const drill = useMutation({
    mutationFn: (id: string) =>
      api<DrillReport>(`/api/v1/system/backups/${id}/drill`, {
        method: "POST",
      }),
    onMutate: (id) => {
      setDrillingId(id);
    },
    onSettled: () => {
      setDrillingId(null);
    },
    onSuccess: (result) => {
      setReport(result);
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "Restore drill failed",
        description: errorMessage(error),
      });
    },
  });

  const actions = (
    <>
      <Button
        onClick={() => {
          setExportOpen(true);
        }}
        icon={<Download className="size-4" aria-hidden="true" />}
      >
        Export
      </Button>
      <Button
        variant="primary"
        loading={run.isPending}
        onClick={() => {
          run.mutate();
        }}
        icon={<Play className="size-4" aria-hidden="true" />}
      >
        Run now
      </Button>
    </>
  );

  let body: ReactNode;
  if (backups.isPending) {
    body = <RowsSkeleton rows={3} />;
  } else if (backups.isError) {
    body = (
      <ErrorState
        message={errorMessage(backups.error)}
        onRetry={() => {
          void backups.refetch();
        }}
        retrying={backups.isFetching}
      />
    );
  } else if (backups.data.items.length === 0) {
    body = (
      <EmptyState
        icon={<DatabaseBackup className="size-6" aria-hidden="true" />}
        title="No backups yet"
        description="The first one runs on the schedule above, or now with Run now."
      />
    );
  } else {
    body = (
      <Table label="Local backups">
        <thead>
          <tr>
            <Th>Taken</Th>
            <Th align="right">Size</Th>
            <Th align="right">Files</Th>
            <Th>Version</Th>
            <Th>Integrity</Th>
            <Th align="right">Restore drill</Th>
          </tr>
        </thead>
        <tbody>
          {backups.data.items.map((item) => (
            <BackupRow
              key={item.id}
              item={item}
              drilling={drillingId === item.id}
              onDrill={(id) => {
                drill.mutate(id);
              }}
            />
          ))}
        </tbody>
      </Table>
    );
  }

  return (
    <Card
      title="Local backups"
      description="A consistent copy of the database and the snapshots it references, with an integrity check."
      aside={<div className="flex flex-wrap gap-2">{actions}</div>}
    >
      {body}
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <DrillDialog
        report={report}
        onClose={() => {
          setReport(null);
        }}
      />
    </Card>
  );
}

export function BackupPage() {
  const owner = useIsOwner();
  if (!owner) {
    return (
      <Card title="Backups">
        <Alert kind="info">Only the owner can see and run backups.</Alert>
      </Card>
    );
  }
  return (
    <>
      <AppSecretBanner />
      <ScheduleCard />
      <BackupsCard />
    </>
  );
}
