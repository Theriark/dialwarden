// The typed settings editor (screen 3 of dev-work-plan P5, contract C3):
// the pack's settings grouped, searchable, filterable by changed-from-
// default, validated inline by the shared validate() with the pack's rule
// messages, with restart-required, panel-managed and secret badges, masked
// secret fields, and unknown keys shown as unknown and kept. Saving goes
// through a change set (contract C5) and the save dialog.
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronDown,
  EyeOff,
  FileWarning,
  History,
  Search,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  sameAsDefault,
  sameJson,
  type Setting,
} from "@dialwarden/packs-schema";
import { createChangeSet, type EditInput } from "../api/changes";
import { errorMessage } from "../api/errors";
import {
  p4keys,
  serverQuery,
  serverSettingsQuery,
  settingsMetaQuery,
} from "../api/queries";
import { PageHeader } from "../components/layout/page-header";
import { SettingField } from "../components/editor/setting-field";
import { SaveDialog } from "../components/save-dialog";
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
import { issuesOf, packOf, settingsByKey } from "../lib/pack";
import { cn } from "../lib/cn";
import type { ChangeSet } from "../api/schema";
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
                draft[setting.key] ?? null,
                values[setting.key] ?? null,
              );
            const issue = issues.get(setting.key);
            return (
              <SettingField
                key={setting.key}
                setting={setting}
                value={value}
                edited={edited}
                issue={issue?.message}
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
  const issues = useMemo(
    () => (pack === null ? new Map() : issuesOf(pack, effective)),
    [pack, effective],
  );
  const byKey = useMemo(
    () => settingsByKey((meta.data?.settings ?? []) as Setting[]),
    [meta.data],
  );
  const blocked = useMemo(
    () => [...issues.values()].some((issue) => issue.severity === "error"),
    [issues],
  );
  const editedCount = useMemo(
    () =>
      Object.keys(draft).filter(
        (key) =>
          !sameJson(draft[key] ?? null, settings.data?.values[key] ?? null),
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

  const save = useMutation({
    mutationFn: () => {
      const edits: EditInput[] = Object.keys(draft)
        .filter(
          (key) =>
            !sameJson(draft[key] ?? null, settings.data?.values[key] ?? null),
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

  if (settings.isPending || server.isPending) {
    return (
      <>
        <PageHeader title="Settings" description="Loading the pack…" />
        <RowsSkeleton rows={5} />
      </>
    );
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

  const editable = settings.data.editable;
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
        const value = effective[setting.key] ?? null;
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

  return (
    <>
      <PageHeader
        title={`${server.data.name} settings`}
        description={`${meta.data.displayName} ${meta.data.version} · ${packLine}`}
        actions={
          <>
            <Link
              to="/servers/$slug/history"
              params={{ slug }}
              className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg transition-colors duration-150 hover:bg-accent-soft"
            >
              <History className="size-4" aria-hidden="true" />
              History
            </Link>
            <Link
              to="/servers/$slug/raw"
              params={{ slug }}
              className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg transition-colors duration-150 hover:bg-accent-soft"
            >
              Raw files
            </Link>
          </>
        }
      />
      {editable ? null : (
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
              current: 3,
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
              onChange={(key, value) => {
                setDraft((current) => ({ ...current, [key]: value }));
              }}
              onReset={(key) => {
                setDraft((current) => {
                  const setting = byKey.get(key);
                  const original = settings.data.values[key] ?? null;
                  // A secret never resets to its default unless it was
                  // edited: the server only ever shows its mask, so an
                  // untouched secret has nothing to reset.
                  const edited =
                    key in current && !sameJson(current[key] ?? null, original);
                  if (!edited) {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  }
                  return { ...current, [key]: setting?.default ?? null };
                });
              }}
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
