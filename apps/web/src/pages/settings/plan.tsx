// The Free plan selection (screen 8 of dev-work-plan P5): the owner picks the
// three servers the Free plan edits; every other server renders read-only in
// the fleet and the editors. On Paid every server is editable, so the page
// only confirms that.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Gamepad2, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { chooseEditableServers } from "../../api/changes";
import { errorMessage } from "../../api/errors";
import {
  editableServersQuery,
  entitlementQuery,
  keys,
  serversQuery,
} from "../../api/queries";
import type { Server } from "../../api/schema";
import { useIsOwner } from "../../api/session";
import { UpgradeHint } from "../../components/upgrade-hint";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { CardSkeleton, ErrorState } from "../../components/ui/states";
import { useToast } from "../../components/ui/toast";

const CHECKBOX =
  "size-5 shrink-0 accent-[var(--dw-primary)] disabled:opacity-60";

function ServerRow({
  server,
  checked,
  disabled,
  reason,
  onToggle,
}: {
  server: Server;
  checked: boolean;
  disabled: boolean;
  reason: string;
  onToggle: (id: string) => void;
}) {
  const id = `plan-server-${server.id}`;
  return (
    <li className="flex items-center justify-between gap-4 rounded-control border border-border bg-surface p-3">
      <div className="flex min-w-0 items-center gap-3">
        <input
          id={id}
          type="checkbox"
          className={CHECKBOX}
          checked={checked}
          disabled={disabled}
          onChange={() => {
            onToggle(server.id);
          }}
        />
        <label
          htmlFor={id}
          className="flex min-w-0 cursor-pointer flex-col gap-0.5 text-sm font-medium text-fg"
        >
          <span className="truncate">{server.name}</span>
          <span className="truncate text-xs font-normal text-fg-muted">
            {server.displayName} · {server.os}
          </span>
        </label>
      </div>
      {checked ? (
        <Badge kind="success" icon={<CircleCheck className="size-3.5" />}>
          Editable
        </Badge>
      ) : (
        <Badge kind="neutral" icon={<Lock className="size-3.5" />}>
          {reason}
        </Badge>
      )}
    </li>
  );
}

export function PlanPage() {
  const editable = useQuery(editableServersQuery());
  const servers = useQuery(serversQuery());
  const entitlement = useQuery(entitlementQuery());
  const isOwner = useIsOwner();
  const client = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    // The effective list, not the stored choice: without a choice the three
    // most recently edited servers are editable, and the owner toggles on
    // top of what they see.
    if (editable.data !== undefined) {
      setSelected(editable.data.servers);
    }
  }, [editable.data]);

  const save = useMutation({
    mutationFn: (ids: string[]) => chooseEditableServers(ids),
    onSuccess: (data) => {
      client.setQueryData(keys.editable, data);
      void client.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The choice was not saved",
        description: errorMessage(error),
      });
    },
  });

  const toggle = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((item) => item !== id)
      : [...selected, id];
    setSelected(next);
    save.mutate(next);
  };

  if (editable.isPending || servers.isPending) {
    return (
      <>
        <h1 className="mb-6 font-heading text-2xl font-semibold text-fg">
          Plan
        </h1>
        <CardSkeleton />
      </>
    );
  }

  if (editable.isError || servers.isError) {
    return (
      <ErrorState
        message="The plan details could not be loaded."
        onRetry={() => {
          void editable.refetch();
          void servers.refetch();
        }}
      />
    );
  }

  const max = editable.data.max;
  const items = servers.data.items;
  const editableIds = new Set(editable.data.servers);
  const automatic = editable.data.chosen.length === 0;
  const paid = entitlement.data?.plan === "paid";
  const atLimit = selected.length >= max;

  return (
    <>
      <h1 className="mb-6 font-heading text-2xl font-semibold text-fg">Plan</h1>
      <div className="flex flex-col gap-6">
        <Card
          title={
            paid ? "Every server is editable" : "Choose your three servers"
          }
          description={
            paid
              ? "The Paid plan edits every server, with no limit."
              : "The Free plan edits three servers of your choice. Every other server is read-only: its settings can be read and its history checked, but nothing can be saved."
          }
        >
          {items.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Gamepad2 className="size-5 shrink-0" aria-hidden="true" />
              No servers yet. Add one on the Fleet page first.
            </p>
          ) : paid ? (
            <ul className="flex flex-col gap-2">
              {items.map((server) => (
                <li
                  key={server.id}
                  className="flex items-center justify-between gap-4 rounded-control border border-border bg-surface p-3"
                >
                  <span className="flex min-w-0 flex-col gap-0.5 text-sm font-medium text-fg">
                    <span className="truncate">{server.name}</span>
                    <span className="truncate text-xs font-normal text-fg-muted">
                      {server.displayName} · {server.os}
                    </span>
                  </span>
                  <Badge
                    kind="success"
                    icon={<CircleCheck className="size-3.5" />}
                  >
                    Editable
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <>
              {automatic ? (
                <Alert kind="info">
                  Without a choice, the three most recently edited servers are
                  editable. Pick your own to lock the choice.
                </Alert>
              ) : null}
              <ul className="flex flex-col gap-2">
                {items.map((server) => (
                  <ServerRow
                    key={server.id}
                    server={server}
                    checked={selected.includes(server.id)}
                    disabled={
                      !isOwner ||
                      save.isPending ||
                      (atLimit && !selected.includes(server.id))
                    }
                    reason="Read-only on Free"
                    onToggle={toggle}
                  />
                ))}
              </ul>
              {isOwner ? (
                <p className="text-xs text-fg-muted">
                  {selected.length} of {max} chosen.
                  {atLimit
                    ? " Unselect one to choose another."
                    : " Unselecting all three returns to the most recently edited servers."}
                </p>
              ) : null}
              {!isOwner ? (
                <Alert kind="info">Only the owner can change the choice.</Alert>
              ) : null}
            </>
          )}
        </Card>
        {paid ? null : (
          <UpgradeHint
            body={{
              error: "payment_required",
              plan: "free",
              limit: "servers",
              current: editableIds.size,
              max,
            }}
          />
        )}
      </div>
    </>
  );
}
