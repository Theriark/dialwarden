// The raw editor (screen 4 of dev-work-plan P5): Monaco over the whole text
// of one file, with the lint findings in the gutter, saved through a change
// set with the same save dialog (contract C5). Reading a raw file is owner
// only, so everyone else sees the designed owner-only state.
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { FileText, History, Save, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { createChangeSet } from "../api/changes";
import { errorMessage } from "../api/errors";
import { rawFileQuery, serverQuery, serverSettingsQuery } from "../api/queries";
import type { ChangeSet, LintEntry } from "../api/schema";
import { useIsOwner } from "../api/session";
import { languageOf } from "../lib/file-language";
import { PageHeader } from "../components/layout/page-header";
import { LazyEditor, type LintMarker } from "../components/code-editor";
import { SaveDialog } from "../components/save-dialog";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { SelectField } from "../components/ui/field";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { useToast } from "../components/ui/toast";

const FILE_LABEL =
  "flex items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg transition-colors duration-150 hover:bg-accent-soft";

function toMarkers(lint: readonly LintEntry[]): LintMarker[] {
  return lint
    .filter((entry) => entry.line !== null)
    .map((entry) => ({
      line: entry.line ?? 1,
      severity: entry.severity,
      message: entry.message,
    }));
}

export function ServerRawPage() {
  const params = useParams({ strict: false }) as { slug: string };
  const slug = params.slug;
  const isOwner = useIsOwner();
  const server = useQuery(serverQuery(slug));
  const settings = useQuery(serverSettingsQuery(slug));
  const files = settings.data?.files ?? [];
  const [fileId, setFileId] = useState<string | null>(null);
  const chosen = fileId ?? files[0]?.fileId ?? null;
  const file = useQuery({
    ...rawFileQuery(slug, chosen ?? ""),
    enabled: isOwner && chosen !== null,
  });
  const markers = useMemo(() => toMarkers(file.data?.lint ?? []), [file.data]);
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);

  const save = useMutation({
    mutationFn: () =>
      createChangeSet(slug, {
        patches: [
          { fileId: chosen ?? "", text: text ?? file.data?.text ?? "" },
        ],
      }),
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The change set was not created",
        description: errorMessage(error),
      });
    },
    onSuccess: (created) => {
      setChangeSet(created);
    },
  });

  if (server.isPending || settings.isPending) {
    return (
      <>
        <PageHeader title="Raw files" description="Loading the file list…" />
        <RowsSkeleton rows={4} />
      </>
    );
  }

  if (server.isError || settings.isError) {
    return (
      <ErrorState
        message="This server could not be loaded."
        onRetry={() => {
          void server.refetch();
          void settings.refetch();
        }}
      />
    );
  }

  if (!isOwner) {
    return (
      <>
        <PageHeader
          title={`${server.data.name} raw files`}
          description="The raw text of every setting file."
        />
        <EmptyState
          icon={<FileText className="size-6" aria-hidden="true" />}
          title="Owner only"
          description="Reading raw files is limited to the owner. The typed settings editor carries every value you need."
        />
      </>
    );
  }

  if (files.length === 0) {
    return (
      <>
        <PageHeader
          title={`${server.data.name} raw files`}
          description="The raw text of every setting file."
        />
        <EmptyState
          icon={<FileText className="size-6" aria-hidden="true" />}
          title="No files"
          description="This pack defines no setting file for this operating system."
        />
      </>
    );
  }

  const editable = settings.data.editable;
  const current = chosen === null ? null : (text ?? file.data?.text ?? null);
  const dirty =
    current !== null && file.data !== undefined && current !== file.data.text;
  // The save dialog's text diff highlights with the file's own language.
  const fileLanguage = (fileId: string) =>
    languageOf(
      settings.data?.files.find((file) => file.fileId === fileId)?.path ?? "",
    );

  return (
    <>
      <PageHeader
        title={`${server.data.name} raw files`}
        description="Edit the text exactly as the file holds it. Saves go through the same review as the typed editor."
        actions={
          <>
            <Link
              to="/servers/$slug/settings"
              params={{ slug }}
              className={FILE_LABEL}
            >
              <Settings2 className="size-4" aria-hidden="true" />
              Typed editor
            </Link>
            <Link
              to="/servers/$slug/history"
              params={{ slug }}
              className={FILE_LABEL}
            >
              <History className="size-4" aria-hidden="true" />
              History
            </Link>
          </>
        }
      />
      {editable ? null : (
        <Alert kind="warning">
          This server is read-only on the Free plan: choose the three editable
          servers in Settings → Plan.
        </Alert>
      )}
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-full sm:w-96">
            <SelectField
              id="raw-file"
              label="File"
              value={chosen ?? ""}
              options={files.map((item) => ({
                value: item.fileId,
                label: `${item.path}${item.exists ? "" : " (missing)"}`,
              }))}
              onChange={(next) => {
                setFileId(next);
                setText(null);
              }}
            />
          </div>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!editable || !dirty}
            icon={<Save className="size-4" aria-hidden="true" />}
            onClick={() => {
              save.mutate();
            }}
          >
            Review and save
          </Button>
        </div>
        {file.isPending ? (
          <RowsSkeleton rows={6} />
        ) : file.isError ? (
          <ErrorState
            message="The file could not be read."
            onRetry={() => {
              void file.refetch();
            }}
          />
        ) : current === null ? null : (
          <>
            {file.data.exists ? null : (
              <Alert kind="warning">
                The file is missing from the server folder. Saving here creates
                it.
              </Alert>
            )}
            <LazyEditor
              value={current}
              language={
                file.data !== undefined
                  ? languageOf(file.data.path)
                  : "plaintext"
              }
              lint={markers}
              readOnly={!editable}
              onChange={(value) => {
                setText(value);
              }}
            />
          </>
        )}
      </div>
      {changeSet === null ? null : (
        <SaveDialog
          slug={slug}
          changeSet={changeSet}
          fileLanguage={fileLanguage}
          onClose={() => {
            setChangeSet(null);
          }}
          onApplied={() => {
            setChangeSet(null);
            setText(null);
            void file.refetch();
          }}
        />
      )}
    </>
  );
}
