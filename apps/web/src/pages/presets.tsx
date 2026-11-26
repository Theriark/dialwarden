// Presets (screen 7 of dev-work-plan P5): saved values you can apply to one
// server with a diff. Created from a server's current settings or from a
// selection of them; applied through a change set of cause preset, shown in
// the same save dialog. The Free plan holds three; the fourth answers 402 and
// renders the upgrade hint. The presets endpoints are not part of P4: this
// page is built against the contract Delivery hands the small Backend task,
// and while the server answers 404 it shows its designed state.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Plus, Server as ServerIcon, Trash2 } from "lucide-react";
import { useState } from "react";
import { applyPreset, createPreset, deletePreset } from "../api/changes";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import {
  p4keys,
  presetsQuery,
  serverSettingsQuery,
  serversQuery,
  settingsMetaQuery,
} from "../api/queries";
import type {
  ChangeSet,
  PaymentRequiredBody,
  Server,
  UserPreset,
} from "../api/schema";
import { useIsOwner, useSessionUser } from "../api/session";
import { BulkApplyWizard } from "../components/bulk-apply-wizard";
import { PageHeader } from "../components/layout/page-header";
import { SaveDialog } from "../components/save-dialog";
import { UpgradeHint } from "../components/upgrade-hint";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/dialog";
import { SelectField, TextField } from "../components/ui/field";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { useToast } from "../components/ui/toast";
import { formatDate } from "../lib/format";
import type { PackFile, Setting } from "@dialwarden/packs-schema";

/**
 * The roles that may apply a preset to many servers at once (the bulk
 * routes need the editor role or more; each server is then checked against
 * the caller's grants by the server).
 */
export const BULK_ROLES: readonly string[] = ["owner", "admin", "editor"];

function PresetCard({
  preset,
  servers,
  canBulk,
  onApply,
  onBulk,
  onDelete,
  deleting,
}: {
  preset: UserPreset;
  servers: readonly { id: string; name: string; packId: string }[];
  canBulk: boolean;
  onApply: (preset: UserPreset, server: string) => void;
  onBulk: (preset: UserPreset) => void;
  onDelete: (preset: UserPreset) => void;
  deleting: boolean;
}) {
  const [server, setServer] = useState("");
  const packServers = servers.filter((item) => item.packId === preset.packId);
  return (
    <Card
      title={preset.name}
      description={preset.description}
      aside={
        <Badge kind="neutral" icon={<Layers className="size-3.5" />}>
          {Object.keys(preset.values).length} values
        </Badge>
      }
    >
      <p className="text-xs text-fg-muted">
        Created {formatDate(preset.createdAt)}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {packServers.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No server of this pack to apply it to.
          </p>
        ) : (
          <>
            <div className="w-full sm:w-64">
              <SelectField
                id={`apply-${preset.id}`}
                label="Apply to"
                placeholder="Choose a server"
                value={server}
                options={packServers.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
                onChange={setServer}
              />
            </div>
            <Button
              variant="primary"
              disabled={server === ""}
              onClick={() => {
                onApply(preset, server);
              }}
            >
              Apply with diff
            </Button>
            {canBulk ? (
              <Button
                icon={<ServerIcon className="size-4" aria-hidden="true" />}
                onClick={() => {
                  onBulk(preset);
                }}
              >
                Apply to many servers
              </Button>
            ) : null}
          </>
        )}
        <Button
          variant="ghost"
          loading={deleting}
          icon={<Trash2 className="size-4" aria-hidden="true" />}
          onClick={() => {
            onDelete(preset);
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

export function PresetsPage() {
  const isOwner = useIsOwner();
  const user = useSessionUser();
  const canBulk = user !== null && BULK_ROLES.includes(user.role);
  const client = useQueryClient();
  const toast = useToast();
  const presets = useQuery(presetsQuery());
  const servers = useQuery(serversQuery());

  const [createOpen, setCreateOpen] = useState(false);
  const [bulkPreset, setBulkPreset] = useState<UserPreset | null>(null);
  const [presetServer, setPresetServer] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetDescription, setPresetDescription] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [removing, setRemoving] = useState<UserPreset | null>(null);
  const [payment, setPayment] = useState<PaymentRequiredBody | null>(null);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);

  const settings = useQuery({
    ...serverSettingsQuery(presetServer),
    enabled: presetServer !== "",
  });
  const meta = useQuery({
    ...settingsMetaQuery(settings.data?.packId ?? ""),
    enabled: settings.data !== undefined,
  });
  // The pack of the server a preset is applied to: the save dialog labels a
  // change to a file the game reads at start only (the create form's meta
  // above follows the server chosen for a new preset, not this one).
  const appliedPackId = servers.data?.items.find(
    (server) => server.id === changeSet?.serverId,
  )?.packId;
  const appliedMeta = useQuery({
    ...settingsMetaQuery(appliedPackId ?? ""),
    enabled: appliedPackId !== undefined,
  });
  const stoppedOnlyFiles = ((appliedMeta.data?.files ?? []) as PackFile[])
    .filter((file) => file.applyPolicy === "stopped-only")
    .map((file) => file.id);

  const create = useMutation({
    mutationFn: () => {
      const values =
        selection.length > 0
          ? Object.fromEntries(
              Object.entries(settings.data?.values ?? {}).filter(([key]) =>
                selection.includes(key),
              ),
            )
          : (settings.data?.values ?? {});
      return createPreset({
        name: presetName.trim(),
        description: presetDescription.trim(),
        packId: settings.data?.packId ?? "",
        values,
      });
    },
    onError: (error) => {
      setPayment(error instanceof ApiError ? error.paymentRequired : null);
      toast.push({
        kind: "error",
        title: "The preset was not created",
        description: errorMessage(error),
      });
    },
    onSuccess: () => {
      setPayment(null);
      toast.push({ kind: "success", title: "Preset created" });
      setCreateOpen(false);
      setPresetName("");
      setPresetDescription("");
      setSelection([]);
      void client.invalidateQueries({ queryKey: p4keys.presets });
    },
  });

  const apply = useMutation({
    mutationFn: (input: { preset: UserPreset; server: string }) =>
      applyPreset(input.preset.id, input.server),
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The preset was not applied",
        description: errorMessage(error),
      });
    },
    onSuccess: (created) => {
      setChangeSet(created);
    },
  });

  const remove = useMutation({
    mutationFn: (preset: UserPreset) => deletePreset(preset.id),
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The preset was not deleted",
        description: errorMessage(error),
      });
    },
    onSuccess: () => {
      toast.push({ kind: "success", title: "Preset deleted" });
      setRemoving(null);
      void client.invalidateQueries({ queryKey: p4keys.presets });
    },
  });

  const items = servers.data?.items ?? [];
  const ownerServers = items.map((server) => ({
    id: server.id,
    name: server.name,
    packId: server.packId,
  }));
  const settingsList = (meta.data?.settings ?? []) as Setting[];

  const createBody = (
    <div className="flex flex-col gap-4">
      <SelectField
        id="preset-server"
        label="From server"
        help="The preset takes the current values of this server."
        placeholder="Choose a server"
        value={presetServer}
        options={ownerServers.map((item) => ({
          value: item.id,
          label: item.name,
        }))}
        onChange={(next) => {
          setPresetServer(next);
          setSelection([]);
        }}
      />
      <TextField
        id="preset-name"
        label="Name"
        value={presetName}
        onChange={(event) => {
          setPresetName(event.target.value);
        }}
      />
      <TextField
        id="preset-description"
        label="Description"
        help="What this preset is for, in your words."
        value={presetDescription}
        onChange={(event) => {
          setPresetDescription(event.target.value);
        }}
      />
      {settings.isPending || presetServer === "" ? null : (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-fg">
            Values to save
          </legend>
          <span className="text-xs text-fg-muted">
            Leave every box unchecked to save all current values, or pick a
            selection.
          </span>
          <div className="max-h-56 overflow-auto rounded-control border border-border p-2">
            {settingsList.map((setting) => (
              <label
                key={setting.key}
                className="flex items-center gap-2 rounded-control px-2 py-1 text-sm"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--dw-primary)]"
                  checked={selection.includes(setting.key)}
                  onChange={() => {
                    setSelection((current) =>
                      current.includes(setting.key)
                        ? current.filter((key) => key !== setting.key)
                        : [...current, setting.key],
                    );
                  }}
                />
                <span className="truncate">{setting.label ?? setting.key}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {payment === null ? null : <UpgradeHint body={payment} />}
    </div>
  );

  if (presets.isPending) {
    return (
      <>
        <PageHeader title="Presets" description="Loading presets…" />
        <RowsSkeleton rows={3} />
      </>
    );
  }

  if (presets.isError) {
    const missing =
      presets.error instanceof Object &&
      "status" in presets.error &&
      presets.error.status === 404;
    return (
      <>
        <PageHeader
          title="Presets"
          description="Saved settings you can apply to a server with a diff."
        />
        {missing ? (
          <EmptyState
            icon={<Layers className="size-6" aria-hidden="true" />}
            title="Presets are not on this build yet"
            description="The presets API ships with the next server update; the screen is ready for it. Reported to Delivery with the result of this phase."
          />
        ) : (
          <ErrorState
            message="The presets could not be loaded."
            onRetry={() => {
              void presets.refetch();
            }}
          />
        )}
      </>
    );
  }

  const list = presets.data.items;

  return (
    <>
      <PageHeader
        title="Presets"
        description="Saved settings you can apply to a server with a diff."
        actions={
          isOwner ? (
            <Button
              variant="primary"
              icon={<Plus className="size-4" aria-hidden="true" />}
              onClick={() => {
                setCreateOpen(true);
              }}
              disabled={ownerServers.length === 0}
            >
              Create preset
            </Button>
          ) : undefined
        }
      />
      {list.length === 0 ? (
        <EmptyState
          icon={<Layers className="size-6" aria-hidden="true" />}
          title="No presets yet"
          description={
            isOwner
              ? "Create one from a server's current settings, or from a selection of them, and apply it to any server of the same game."
              : "The owner can create presets from a server's current settings."
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              servers={ownerServers}
              canBulk={canBulk}
              onApply={(item, server) => {
                apply.mutate({ preset: item, server });
              }}
              onBulk={setBulkPreset}
              onDelete={setRemoving}
              deleting={remove.isPending}
            />
          ))}
        </div>
      )}
      {bulkPreset === null ? null : (
        <BulkApplyWizard
          preset={bulkPreset}
          servers={items.filter(
            (server: Server) => server.packId === bulkPreset.packId,
          )}
          onClose={() => {
            setBulkPreset(null);
          }}
        />
      )}
      {createOpen ? (
        <ConfirmDialog
          open={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open);
          }}
          title="Create a preset"
          description="From a server's current values or a selection of them."
          confirmLabel="Create"
          confirmDisabled={
            presetServer === "" ||
            presetName.trim() === "" ||
            settings.data === undefined
          }
          loading={create.isPending}
          onConfirm={() => {
            create.mutate();
          }}
        >
          {createBody}
        </ConfirmDialog>
      ) : null}
      {removing === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRemoving(null);
            }
          }}
          title={`Delete ${removing.name}?`}
          description="The preset stops being offered; servers that already applied it keep their values."
          confirmLabel="Delete"
          destructive
          loading={remove.isPending}
          onConfirm={() => {
            remove.mutate(removing);
          }}
        />
      )}
      {changeSet === null ? null : (
        <SaveDialog
          slug={changeSet.serverId}
          changeSet={changeSet}
          stoppedOnlyFiles={stoppedOnlyFiles}
          onClose={() => {
            setChangeSet(null);
          }}
          onApplied={() => {
            setChangeSet(null);
          }}
        />
      )}
    </>
  );
}
