// The launch page of a server (dev-work-plan P6-C steps 1, 5 and 6): where
// the launch line lives (the app-managed args file, a LinuxGSM instance cfg,
// a container env file or a hosting panel), the launch flags editor with a
// live preview of the line it writes, the copy-to-panel text with the
// panel's warnings, and the one-line snippets that wire the args file into
// bash, PowerShell, Docker Compose and systemd start commands.
//
// The server of 27.0.0 writes the app-managed args file; the source chosen
// here decides what this page shows and is kept in this browser
// (dw.launch.SLUG) until the server records it per server.
/* eslint-disable security/detect-object-injection -- the keys are the pack's setting keys and the server's own JSON answer, never free-form input */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  FileCode2,
  FileTerminal,
  Rocket,
  Save,
  ServerCog,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  launchPanelWarnings,
  launchSourcePaths,
  launchSourceViews,
  renderLaunchLine,
  sameJson,
  settingsOfFile,
  type JsonValue,
  type LaunchSource,
  type LaunchSourceView,
  type Pack,
  type PackFile,
  type Setting,
} from "@dialwarden/packs-schema";
import { createChangeSet, type EditInput } from "../api/changes";
import { errorMessage } from "../api/errors";
import {
  serverQuery,
  serverSettingsQuery,
  settingsMetaQuery,
} from "../api/queries";
import type { ChangeSet } from "../api/schema";
import { canWriteServer, readGrantOnly, useSessionUser } from "../api/session";
import { PageHeader } from "../components/layout/page-header";
import { LaunchSnippetPanel } from "../components/launch-snippets";
import { ReadOnlyNotice } from "../components/read-only-notice";
import { SaveDialog } from "../components/save-dialog";
import {
  isServerMissing,
  ServerMissingState,
} from "../components/server-missing";
import { ServerTabs } from "../components/server-tabs";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { CodeBlock } from "../components/ui/code-block";
import { TextField } from "../components/ui/field";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { useToast } from "../components/ui/toast";
import { languageOf } from "../lib/file-language";
import { issuesOf, packOf } from "../lib/pack";
import { readStored, writeStored } from "../lib/storage";
import { useMediaQuery } from "../lib/use-media-query";
import { GroupSection } from "./server-settings";

type SourceKind = LaunchSource["kind"];

const SOURCE_WORDS: Readonly<
  Record<SourceKind, { label: string; icon: LucideIcon; sentence: string }>
> = {
  args: {
    label: "App-managed args file",
    icon: FileCode2,
    sentence:
      "Dialwarden reads and writes dialwarden-args.txt next to the game; your start command reads it with one of the snippets below.",
  },
  linuxgsm: {
    label: "LinuxGSM instance config",
    icon: ServerCog,
    sentence:
      "The flags live in the instance cfg as shell variables; LinuxGSM puts them on the command line at launch.",
  },
  env: {
    label: "Container env file",
    icon: FileTerminal,
    sentence:
      "The flags live in an env file, one variable per line, read by the game container.",
  },
  panel: {
    label: "Hosting panel",
    icon: SlidersHorizontal,
    sentence:
      "The panel owns the start command. Dialwarden shows the line to copy into it and never writes the file.",
  },
};

const OPTION =
  "flex cursor-pointer gap-3 rounded-control border border-border-strong bg-surface p-3 has-[:checked]:border-primary has-[:checked]:bg-accent-soft";

function isSourceKind(value: string | null): value is SourceKind {
  return (
    value === "args" ||
    value === "linuxgsm" ||
    value === "env" ||
    value === "panel"
  );
}

export function storedSource(slug: string): SourceKind | null {
  const value = readStored(`dw.launch.${slug}`);
  return isSourceKind(value) ? value : null;
}

export function storedExecutable(slug: string): string {
  return readStored(`dw.launch.${slug}.executable`) ?? "";
}

/** The launch source declared for a kind, as the pack file holds it. */
function sourceOf(file: PackFile, kind: SourceKind): LaunchSource {
  const declared = (file.launchSources ?? []).find(
    (source) => source.kind === kind,
  );
  return declared ?? { kind: "args" };
}

/**
 * The launch line the current values write: every launch setting of the
 * file with a value, except the masked secrets (their mask would be
 * refused as a shell character and must not be shown anyway).
 */
export function previewLine(
  pack: Pack,
  fileId: string,
  values: Readonly<Record<string, unknown>>,
): { line: string; omitted: string[] } | { error: string } {
  const omitted: string[] = [];
  const edits: { key: string; value: JsonValue }[] = [];
  for (const setting of settingsOfFile(pack, fileId)) {
    const value = values[setting.key];
    if (value === undefined || value === null) continue;
    if (setting.secret === true) {
      omitted.push(setting.label ?? setting.key);
      continue;
    }
    edits.push({ key: setting.key, value: value as JsonValue });
  }
  try {
    return {
      line: renderLaunchLine(pack, fileId, new Uint8Array(), edits),
      omitted,
    };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function VariableTable({ source }: { source: LaunchSource }) {
  if (source.kind !== "linuxgsm" && source.kind !== "env") return null;
  const rows = Object.entries(source.flagVars ?? {});
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-fg">Where each flag lives</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
        {rows.map(([flag, variable]) => (
          <div key={flag} className="contents">
            <dt className="text-fg-muted">{flag}</dt>
            <dd className="text-fg">{variable}</dd>
          </div>
        ))}
        {source.kind === "linuxgsm" && source.modifiersVar !== undefined ? (
          <div className="contents">
            <dt className="text-fg-muted">-preset, -modifier, -setkey</dt>
            <dd className="text-fg">{source.modifiersVar}</dd>
          </div>
        ) : null}
        {source.argsVar !== undefined ? (
          <div className="contents">
            <dt className="text-fg-muted">every other flag</dt>
            <dd className="text-fg">{source.argsVar}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export function ServerLaunchPage() {
  const params = useParams({ strict: false }) as { slug: string };
  const slug = params.slug;
  const server = useQuery(serverQuery(slug));
  const settings = useQuery(serverSettingsQuery(slug));
  const packId = settings.data?.packId;
  const meta = useQuery({
    ...settingsMetaQuery(packId ?? ""),
    enabled: packId !== undefined,
  });
  const phone = !useMediaQuery("(min-width: 640px)");
  const toast = useToast();
  const user = useSessionUser();
  // The role and the grant decide who edits the flags (P10-A L22); the plan
  // decides whether the server takes edits at all. The server stays the
  // authority on both.
  const canWrite = canWriteServer(user, settings.data?.access);
  const grantOnly = readGrantOnly(user, settings.data?.access);
  const [chosen, setChosen] = useState<SourceKind | null>(() =>
    storedSource(slug),
  );
  const [executable, setExecutable] = useState(() => storedExecutable(slug));
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);

  const pack = useMemo(
    () => (meta.data === undefined ? null : packOf(meta.data)),
    [meta.data],
  );
  const launchFile = useMemo(
    () => pack?.files.find((file) => file.adapter === "launch") ?? null,
    [pack],
  );
  const launchSettings = useMemo(
    () =>
      pack === null || launchFile === null
        ? []
        : settingsOfFile(pack, launchFile.id),
    [pack, launchFile],
  );
  const effective = useMemo(
    () => ({ ...(settings.data?.values ?? {}), ...draft }),
    [settings.data, draft],
  );
  const issues = useMemo(
    () => (pack === null ? new Map() : issuesOf(pack, effective)),
    [pack, effective],
  );
  const blocked = useMemo(
    () => [...issues.values()].some((issue) => issue.severity === "error"),
    [issues],
  );
  const editedCount = useMemo(
    () =>
      Object.keys(draft).filter(
        (key) =>
          !sameJson(
            (draft[key] ?? null) as JsonValue,
            (settings.data?.values[key] ?? null) as JsonValue,
          ),
      ).length,
    [draft, settings.data],
  );
  const onFieldChange = useCallback(
    (key: string, value: unknown) => {
      // A reader's fields are disabled; no edit reaches the draft either.
      if (!canWrite) return;
      setDraft((current) => ({ ...current, [key]: value }));
    },
    [canWrite],
  );
  const onFieldReset = useCallback((key: string) => {
    setDraft((current) =>
      Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
    );
  }, []);

  const save = useMutation({
    mutationFn: () => {
      const edits: EditInput[] = Object.keys(draft)
        .filter(
          (key) =>
            !sameJson(
              (draft[key] ?? null) as JsonValue,
              (settings.data?.values[key] ?? null) as JsonValue,
            ),
        )
        .map((key) => ({ settingKey: key, value: draft[key] ?? null }));
      return createChangeSet(slug, { edits });
    },
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
        <PageHeader title="Launch" description="Loading the launch sources…" />
        <RowsSkeleton rows={5} />
      </>
    );
  }

  if (isServerMissing(server.error) || isServerMissing(settings.error)) {
    return <ServerMissingState />;
  }

  if (server.isError || settings.isError || meta.isError) {
    return (
      <>
        <PageHeader
          title="Launch"
          description="Where the launch line lives and how the start command reads it."
        />
        <ErrorState
          message="The launch sources could not be loaded."
          onRetry={() => {
            void server.refetch();
            void settings.refetch();
            void meta.refetch();
          }}
        />
      </>
    );
  }

  if (pack === null || meta.data === undefined) {
    return (
      <>
        <PageHeader title="Launch" description="Loading the pack…" />
        <RowsSkeleton rows={3} />
      </>
    );
  }

  const data = server.data;
  const title = `${data.name} launch`;

  if (launchFile === null) {
    return (
      <>
        <PageHeader
          title={title}
          description="Where the launch line lives and how the start command reads it."
        />
        <ServerTabs slug={slug} current="launch" />
        <EmptyState
          icon={<Rocket className="size-6" aria-hidden="true" />}
          title="No launch line for this game"
          description={`The ${meta.data.displayName} pack keeps every setting in files, so there is no argument line to manage here.`}
        />
      </>
    );
  }

  const views = launchSourceViews(pack, launchFile.id);
  const current: SourceKind =
    chosen !== null && views.some((view) => view.kind === chosen)
      ? chosen
      : "args";
  const source = sourceOf(launchFile, current);
  const paths = launchSourcePaths(pack, launchFile.id, source, data.os);
  const argsFile =
    launchSourcePaths(pack, launchFile.id, { kind: "args" }, data.os).at(0) ??
    "dialwarden-args.txt";
  const preview = previewLine(pack, launchFile.id, effective);
  const warnings = launchPanelWarnings(pack, launchFile.id);
  const planEditable = settings.data.editable;
  const editable = planEditable && canWrite;
  const stoppedOnlyFiles = pack.files
    .filter((file) => file.applyPolicy === "stopped-only")
    .map((file) => file.id);
  const groups = groupsOfLaunch(launchSettings);
  const fileLanguage = (fileId: string) =>
    languageOf(
      settings.data.files.find((file) => file.fileId === fileId)?.path ?? "",
    );

  return (
    <>
      <PageHeader
        title={title}
        description="Where the launch line lives and how the start command reads it."
      />
      <ServerTabs slug={slug} current="launch" />
      <div className="flex flex-col gap-6">
        <Card
          title="Launch source"
          description="Where the argument line of this game lives. The app-managed file is always available."
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Launch source</legend>
            {views.map((view: LaunchSourceView) => {
              const words = SOURCE_WORDS[view.kind];
              const Icon = words.icon;
              const viewPaths =
                (data.os === "linux" ? view.paths.linux : view.paths.windows) ??
                [];
              return (
                <label key={view.kind} className={OPTION}>
                  <input
                    type="radio"
                    name="launch-source"
                    value={view.kind}
                    className="mt-1 accent-primary"
                    checked={current === view.kind}
                    onChange={() => {
                      setChosen(view.kind);
                      writeStored(`dw.launch.${slug}`, view.kind);
                    }}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      {words.label}
                      {view.writable ? null : (
                        <Badge kind="neutral">Read-only</Badge>
                      )}
                    </span>
                    <span className="text-sm text-fg-muted">
                      {words.sentence}
                    </span>
                    {viewPaths.length > 0 ? (
                      <span className="font-mono text-xs break-all text-fg-muted">
                        {viewPaths.join(", ")}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {current === "args" ? null : (
            <Alert kind="info">
              Dialwarden 27.0.0 writes the app-managed args file. This choice
              shapes what this page shows; writing straight into the{" "}
              {SOURCE_WORDS[current].label.toLowerCase()} per server is a later
              server change.
            </Alert>
          )}
          <VariableTable source={source} />
        </Card>

        <Card
          title="Launch line"
          description={
            current === "panel"
              ? "Copy this line into the panel's start command. It is what the current flags would write."
              : `What ${paths.at(0) ?? argsFile} holds with the current flags; edits below change it live.`
          }
        >
          {"error" in preview ? (
            <Alert kind="warning">
              The line cannot be rendered: {preview.error}
            </Alert>
          ) : (
            <>
              <CodeBlock value={preview.line} label="Launch line" />
              {preview.omitted.length > 0 ? (
                <p className="text-xs text-fg-muted">
                  Left out of the preview because they are secret:{" "}
                  {preview.omitted.join(", ")}.
                </p>
              ) : null}
            </>
          )}
          {current === "panel" && warnings.length > 0 ? (
            <Alert kind="warning" title="Keys the panel tends to rewrite">
              <ul className="flex flex-col gap-0.5">
                {warnings.map((warning) => (
                  <li key={warning.key} className="flex items-start gap-1.5">
                    <TriangleAlert
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    {warning.message}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </Card>

        {current === "args" ? (
          <Card
            title="Start command snippets"
            description="One line that makes the start command read the args file. Pick the shell or runtime you use and copy it."
          >
            <div className="sm:w-96">
              <TextField
                id="launch-executable"
                label="Game executable"
                help="The command the snippet runs, as the start script sees it."
                placeholder={
                  data.os === "windows" ? ".\\server.exe" : "./server_binary"
                }
                className="font-mono"
                value={executable}
                onChange={(event) => {
                  setExecutable(event.target.value);
                  writeStored(
                    `dw.launch.${slug}.executable`,
                    event.target.value,
                  );
                }}
              />
            </div>
            <LaunchSnippetPanel
              fileName={argsFile}
              executable={
                executable.trim() === ""
                  ? data.os === "windows"
                    ? ".\\server.exe"
                    : "./server_binary"
                  : executable.trim()
              }
              os={data.os}
            />
          </Card>
        ) : null}

        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-xl font-semibold text-fg">
              Launch flags
            </h2>
            <p className="text-sm text-fg-muted">
              Every flag of the launch line, validated with the pack&apos;s
              rules. The world preset always stays in front of the modifiers and
              keys.
            </p>
          </div>
          {canWrite ? null : (
            <ReadOnlyNotice
              role={user?.role ?? "viewer"}
              reads="these flags"
              writes="changes them"
              grant={grantOnly}
            />
          )}
          {planEditable ? null : (
            <Alert kind="warning">
              This server is read-only on the Free plan: the three editable
              servers are chosen in Settings → Plan.
            </Alert>
          )}
          {groups.length === 0 ? (
            <EmptyState
              icon={<Rocket className="size-6" aria-hidden="true" />}
              title="No launch flags"
              description="This pack declares no typed flag for the launch line."
            />
          ) : (
            groups.map((group) => (
              <GroupSection
                key={group.name}
                group={group}
                values={settings.data.values}
                draft={draft}
                issues={issues}
                disabled={!editable}
                phone={phone}
                onChange={onFieldChange}
                onReset={onFieldReset}
              />
            ))
          )}
        </section>
      </div>
      {editable && editedCount > 0 ? (
        <div className="sticky bottom-0 z-20 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-card">
          <span className="flex items-center gap-2 text-sm text-fg">
            <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
            {editedCount} {editedCount === 1 ? "flag" : "flags"} changed
            {blocked ? " — fix the errors first" : ""}
          </span>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={blocked}
            icon={<Save className="size-4" aria-hidden="true" />}
            onClick={() => {
              save.mutate();
            }}
          >
            Review and save
          </Button>
        </div>
      ) : null}
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
            setChangeSet(null);
            setDraft({});
          }}
        />
      )}
    </>
  );
}

/** The launch settings by group, in pack order. */
function groupsOfLaunch(
  settings: readonly Setting[],
): { name: string; settings: readonly Setting[] }[] {
  const groups: { name: string; settings: Setting[] }[] = [];
  for (const setting of settings) {
    const name = setting.group ?? "Launch";
    const existing = groups.find((group) => group.name === name);
    if (existing === undefined) {
      groups.push({ name, settings: [setting] });
    } else {
      existing.settings.push(setting);
    }
  }
  return groups;
}
