// The typed settings editor (screen 3 of dev-work-plan P5, contract C3):
// the pack's settings grouped, searchable, filterable by changed-from-
// default, validated inline by the shared validate() with the pack's rule
// messages, with restart-required, panel-managed and secret badges, masked
// secret fields, and unknown keys shown as unknown and kept. Saving goes
// through a change set (contract C5) and the save dialog.
/* eslint-disable security/detect-object-injection -- the keys are the pack's setting keys and the server's own JSON answer, never free-form input */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronDown,
  EyeOff,
  FileWarning,
  Search,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  sameAsDefault,
  sameJson,
  type JsonValue,
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
import { PageHeader } from "../components/layout/page-header";
import { SettingField } from "../components/editor/setting-field";
import { ReadOnlyNotice } from "../components/read-only-notice";
import { SaveDialog } from "../components/save-dialog";
import {
  isServerMissing,
  ServerMissingState,
} from "../components/server-missing";
import { ServerTabs } from "../components/server-tabs";
import { UpgradeHint } from "../components/upgrade-hint";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  CardSkeleton,
  ErrorState,
  RowsSkeleton,
} from "../components/ui/states";
import { TextField } from "../components/ui/field";
import { SwitchField } from "../components/ui/switch";
import { useToast } from "../components/ui/toast";
import { languageOf } from "../lib/file-language";
import { issuesOf, packOf, settingsByKey } from "../lib/pack";
import { cn } from "../lib/cn";
import type { ChangeSet } from "../api/schema";
import { canWriteServer, readGrantOnly, useSessionUser } from "../api/session";
import { useMediaQuery } from "../lib/use-media-query";

interface Group {
  readonly name: string;
  readonly settings: readonly Setting[];
}

function groupsOf(settings: readonly Setting[]): Group[] {
  const groups: Group[] = [];
  for (const setting of settings) {
    const name = setting.group ?? "General";
    const existing = groups.find((group) => group.name === name);
    if (existing === undefined) {
      groups.push({ name, settings: [setting] });
    } else {
      groups[groups.indexOf(existing)] = {
        ...existing,
        settings: [...existing.settings, setting],
      };
    }
  }
  return groups;
}

export function GroupSection({
  group,
  values,
  draft,
  issues,
  disabled,
  phone,
  onChange,
  onReset,
}: {
  group: Group;
  values: Readonly<Record<string, unknown>>;
  draft: Readonly<Record<string, unknown>>;
  issues: Map<string, { severity: string; message: string }>;
  disabled: boolean;
  phone: boolean;
  onChange: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
}) {
  const [open, setOpen] = useState(!phone);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="rounded-card border border-border bg-surface shadow-card"
    >
      <Collapsible.Trigger className="flex w-full items-center justify-between gap-3 p-4 text-left">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-heading text-lg font-semibold text-fg">
            {group.name}
          </span>
          <span className="text-xs text-fg-muted">
            {group.settings.length}{" "}
            {group.settings.length === 1 ? "setting" : "settings"}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-5 shrink-0 text-fg-muted transition-transform duration-150",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="flex flex-col gap-6 border-t border-border p-4 sm:p-5">
          {group.settings.map((setting) => {
            const value =
              setting.key in draft
                ? draft[setting.key]
                : (values[setting.key] ?? null);
            const edited =
              setting.key in draft &&
              !sameJson(
                (draft[setting.key] ?? null) as JsonValue,
                (values[setting.key] ?? null) as JsonValue,
              );
            const issue = issues.get(setting.key);
            return (
              <SettingField
                key={setting.key}
                setting={setting}
                value={value}
                edited={edited}
                issue={issue?.message}
                severity={issue?.severity}
                disabled={disabled}
                onChange={onChange}
                onReset={onReset}
              />
            );
          })}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function ServerSettingsPage() {
  const params = useParams({ strict: false }) as { slug: string };
  const slug = params.slug;
  const settings = useQuery(serverSettingsQuery(slug));
  const server = useQuery(serverQuery(slug));
  const packId = settings.data?.packId;
  const meta = useQuery({
    ...settingsMetaQuery(packId ?? ""),
    enabled: packId !== undefined,
  });
  const phone = !useMediaQuery("(min-width: 640px)");
  const toast = useToast();
  const user = useSessionUser();
  // The role and the server's own word on this caller's grant (P10-A L22):
  // an editor with a read grant gets the same disabled fields as a viewer.
  const canWrite = canWriteServer(user, settings.data?.access);
  const grantOnly = readGrantOnly(user, settings.data?.access);

  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [search, setSearch] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);

  const pack = useMemo(
    () => (meta.data === undefined ? null : packOf(meta.data)),
    [meta.data],
  );
  const effective = useMemo(
    () => ({ ...(settings.data?.values ?? {}), ...draft }),
    [settings.data, draft],
  );
  const browserIssues = useMemo(
    () => (pack === null ? new Map() : issuesOf(pack, effective)),
    [pack, effective],
  );
  // The answer's lint covers the stored values, including the rules marked
  // serverEvaluated that the browser cannot run on masked secrets; merged
  // in, the editor shows them inline. A browser issue of the draft wins for
  // its setting, and a server message about a value the user has since
  // edited is dropped: it spoke about the stored value, not the draft (the
  // save dialog lints the after-state).
  const issues = useMemo(() => {
    const merged = new Map<string, { severity: string; message: string }>();
    const stored = settings.data?.values ?? {};
    for (const entry of settings.data?.lint ?? []) {
      if (entry.settingKey === null) continue;
      const key = entry.settingKey;
      const edited =
        key in draft &&
        !sameJson(
          (draft[key] ?? null) as JsonValue,
          (stored[key] ?? null) as JsonValue,
        );
      if (edited) continue;
      merged.set(key, { severity: entry.severity, message: entry.message });
    }
    for (const [key, issue] of browserIssues) {
      merged.set(key, issue);
    }
    return merged;
  }, [settings.data, draft, browserIssues]);
  const byKey = useMemo(
    () => settingsByKey((meta.data?.settings ?? []) as Setting[]),
    [meta.data],
  );
  // Only the draft's own issues block the save; the server's lint of the
  // stored values informs, and the save dialog reviews the after-state.
  const blocked = useMemo(
    () =>
      [...browserIssues.values()].some((issue) => issue.severity === "error"),
    [browserIssues],
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
  const unknown = useMemo(
    () =>
      Object.keys(settings.data?.values ?? {}).filter(
        (key) => !byKey.has(key) && !(key in draft),
      ),
    [settings.data, byKey, draft],
  );
  // Stable handlers: SettingField is memoised, so a keystroke re-renders the
  // one field it touches, not the whole 400-setting file.
  const onFieldChange = useCallback(
    (key: string, value: unknown) => {
      // A reader's fields are disabled; no edit reaches the draft either.
      if (!canWrite) return;
      setDraft((current) => ({ ...current, [key]: value }));
    },
    [canWrite],
  );
  const onFieldReset = useCallback((key: string) => {
    // Reset discards the edit: the key leaves the draft and the field
    // falls back to the server answer. It never writes the pack default -
    // the marker shows an edit against the server answer, so a default
    // here would queue a wipe of an edited secret the user can no longer
    // see (the server only refuses a secret edit that equals its mask).
    // fromEntries instead of delete: no dynamically computed property
    // removal (eslint no-dynamic-delete).
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

  // The save dialog's text diffs highlight with each file's own language.
  const fileLanguage = (fileId: string) =>
    languageOf(
      settings.data?.files.find((file) => file.fileId === fileId)?.path ?? "",
    );

  if (settings.isPending || server.isPending) {
    return (
      <>
        <PageHeader title="Settings" description="Loading the pack…" />
        <RowsSkeleton rows={5} />
      </>
    );
  }

  if (isServerMissing(settings.error) || isServerMissing(server.error)) {
    return <ServerMissingState />;
  }

  if (settings.isError || server.isError || meta.isError) {
    return (
      <ErrorState
        message="The settings could not be loaded."
        onRetry={() => {
          void settings.refetch();
          void server.refetch();
          void meta.refetch();
        }}
      />
    );
  }

  if (meta.data === undefined || pack === null) {
    return (
      <>
        <PageHeader title="Settings" description="Loading the pack…" />
        <CardSkeleton />
      </>
    );
  }

  // The plan decides whether the server takes edits at all; the role
  // decides whether this user may make them. The server stays the authority.
  const planEditable = settings.data.editable;
  const editable = planEditable && canWrite;
  const needle = search.trim().toLowerCase();
  const groups = groupsOf(
    (meta.data.settings as Setting[]).filter((setting) => {
      if (needle !== "") {
        const label = (setting.label ?? setting.key).toLowerCase();
        if (
          !label.includes(needle) &&
          !setting.key.toLowerCase().includes(needle) &&
          !setting.description.toLowerCase().includes(needle)
        ) {
          return false;
        }
      }
      if (changedOnly) {
        const value = (effective[setting.key] ?? null) as JsonValue;
        return !sameAsDefault(setting, value, setting.default ?? null);
      }
      return true;
    }),
  );
  const emptyPack = (meta.data.settings as Setting[]).length === 0;
  const packLine =
    settings.data.packVersion === meta.data.version
      ? "pack matches the server"
      : `server files of pack ${settings.data.packVersion}`;
  // The files the game reads at start only: a change to one of them is
  // parked as pending while the server runs (contract C5, P6-B).
  const stoppedOnlyFiles = (meta.data.files as PackFile[])
    .filter((file) => file.applyPolicy === "stopped-only")
    .map((file) => file.id);

  return (
    <>
      <PageHeader
        title={`${server.data.name} settings`}
        description={`${meta.data.displayName} ${meta.data.version} · ${packLine}`}
      />
      <ServerTabs slug={slug} current="settings" />
      {canWrite ? null : (
        <ReadOnlyNotice
          role={user?.role ?? "viewer"}
          reads="these settings"
          writes="changes them"
          grant={grantOnly}
          className="mb-4"
        />
      )}
      {planEditable ? null : (
        <div className="mb-4 flex flex-col gap-2">
          <Alert kind="warning">
            This server is read-only on the Free plan: the three editable
            servers are chosen in Settings → Plan.
          </Alert>
          <UpgradeHint
            body={{
              error: "payment_required",
              plan: "free",
              limit: "servers",
              max: 3,
            }}
          />
        </div>
      )}
      <div className="mb-4 flex flex-col gap-3 rounded-card border border-border bg-surface p-3 shadow-card sm:flex-row sm:items-center">
        <div className="flex-1">
          <TextField
            id="setting-search"
            label="Search settings"
            placeholder="Name, key or description"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="sm:w-64">
          <SwitchField
            id="changed-only"
            label="Changed from default"
            checked={changedOnly}
            onCheckedChange={setChangedOnly}
          />
        </div>
      </div>
      {emptyPack ? (
        <ErrorState message="This pack has no typed settings. Edit its files in the raw editor." />
      ) : groups.length === 0 ? (
        <Alert kind="info">
          <span className="flex items-center gap-2">
            <Search className="size-4 shrink-0" aria-hidden="true" />
            No setting matches the search
            {changedOnly ? " and the changed-from-default filter" : ""}.
          </span>
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
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
          ))}
        </div>
      )}
      {unknown.length > 0 ? (
        <section className="mt-4 rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
          <h2 className="mb-1 flex items-center gap-2 font-heading text-lg font-semibold text-fg">
            <FileWarning className="size-5 shrink-0" aria-hidden="true" />
            Not in this pack version
          </h2>
          <p className="mb-4 text-sm text-fg-muted">
            These keys sit in the file but no setting of pack{" "}
            {meta.data.version} describes them. They are kept exactly as they
            are by every save.
          </p>
          <ul className="flex flex-col gap-2">
            {unknown.map((key) => (
              <li
                key={key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border p-2"
              >
                <span className="font-mono text-xs break-all text-fg">
                  {key}
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs break-all text-fg-muted">
                    {JSON.stringify(settings.data.values[key] ?? null)}
                  </span>
                  <Badge kind="neutral" icon={<EyeOff className="size-3.5" />}>
                    Unknown, kept
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {editable && editedCount > 0 ? (
        <div className="sticky bottom-0 z-20 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-card">
          <span className="flex items-center gap-2 text-sm text-fg">
            <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
            {editedCount} {editedCount === 1 ? "setting" : "settings"} changed
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
