// The raw editor (screen 4 of dev-work-plan P5): Monaco over the whole text
// of one file, with the lint findings in the gutter, saved through a change
// set with the same save dialog (contract C5). Reading a raw file is owner
// only, so everyone else sees the designed owner-only state.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { FileText, Save } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import type { PackFile } from "@dialwarden/packs-schema";
import { createChangeSet } from "../api/changes";
import { errorMessage } from "../api/errors";
import {
  rawFileQuery,
  serverQuery,
  serverSettingsQuery,
  settingsMetaQuery,
} from "../api/queries";
import type { ChangeSet } from "../api/schema";
import { useIsOwner } from "../api/session";
import { languageOf } from "../lib/file-language";
import { packOf } from "../lib/pack";
import { draftLint, lintMarkers } from "../lib/raw-lint";
import { PageHeader } from "../components/layout/page-header";
import { LazyEditor } from "../components/code-editor";
import { SaveDialog } from "../components/save-dialog";
import { ServerTabs } from "../components/server-tabs";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { SelectField } from "../components/ui/field";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { useToast } from "../components/ui/toast";

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
  const packId = settings.data?.packId;
  const meta = useQuery({
    ...settingsMetaQuery(packId ?? ""),
    enabled: packId !== undefined,
  });
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);

  // The draft is the editor's own text (text) until a file switch or a
  // reload after a save makes the server text the document again. The
  // editor owns its model: the version below tells it when the document is
  // a new one, so typing never races a render (live check F13).
  const draft = text ?? file.data?.text ?? null;
  const textVersion = `${chosen ?? ""}:${file.dataUpdatedAt}`;

  // The draft's own lint, the same lintFile the server runs (live check
  // F3): the gutter marks the malformed line as it is typed, not only
  // after a save refuses, and a clean file stays clean. It runs a beat
  // behind the keystroke, and Review waits for it, so a blocking error
  // still disables the save (P5-D F1).
  const lintedDraft = useDeferredValue(draft);
  const lint = useMemo(
    () =>
      lintedDraft === null || meta.data === undefined
        ? []
        : draftLint(packOf(meta.data), chosen ?? "", lintedDraft),
    [lintedDraft, meta.data, chosen],
  );
  const markers = useMemo(
    () => lintMarkers(lintedDraft ?? "", lint),
    [lintedDraft, lint],
  );
  const blocked = lint.some((issue) => issue.severity === "error");
  const linting = lintedDraft !== draft;

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
  const current = chosen === null ? null : draft;
  const dirty =
    current !== null && file.data !== undefined && current !== file.data.text;
  // The save dialog's text diff highlights with the file's own language.
  const fileLanguage = (fileId: string) =>
    languageOf(
      settings.data?.files.find((file) => file.fileId === fileId)?.path ?? "",
    );
  const stoppedOnlyFiles = ((meta.data?.files ?? []) as PackFile[])
    .filter((item) => item.applyPolicy === "stopped-only")
    .map((item) => item.id);

  return (
    <>
      <PageHeader
        title={`${server.data.name} raw files`}
        description="Edit the text exactly as the file holds it. Saves go through the same review as the typed editor."
      />
      <ServerTabs slug={slug} current="raw" />
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
            disabled={!editable || !dirty || blocked || linting}
            icon={<Save className="size-4" aria-hidden="true" />}
            onClick={() => {
              save.mutate();
            }}
          >
            Review and save
          </Button>
          {blocked ? (
            <span className="pb-1 text-sm text-fg-muted">
              fix the errors first
            </span>
          ) : null}
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
              text={current}
              textVersion={textVersion}
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
          stoppedOnlyFiles={stoppedOnlyFiles}
          onClose={() => {
            setChangeSet(null);
          }}
          onApplied={() => {
            // The saved file is the document again: the refetch gives it
            // a new version and the editor takes the stored text as one
            // edit, caret and undo kept.
            setChangeSet(null);
            setText(null);
            void file.refetch();
          }}
        />
      )}
    </>
  );
}
