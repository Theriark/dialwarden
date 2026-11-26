// Notification channels (dev-work-plan P9-C step 4, Paid feature
// notifications): the channels of this instance (in-app, webhook with HMAC,
// Discord, SMTP), their event types, their last delivery, a send test with
// a clear success or error state, and the form that never erases a stored
// secret by accident. Owner and admins; everyone else reads a sentence. On
// Free the list answers 402: the page says the channels are kept and
// renders the C1 upgrade hint.
/* eslint-disable security/detect-object-injection -- the keys are the fixed channel kinds and the C6 event types of constant word tables, never free-form input */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellOff,
  CircleCheck,
  CircleX,
  Pencil,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { codeWords, errorMessage } from "../../api/errors";
import {
  createChannel,
  deleteChannel,
  testChannel,
  updateChannel,
} from "../../api/fleet";
import { channelsQuery, p9keys } from "../../api/queries";
import type {
  ChannelInput,
  ChannelTestResult,
  ChannelView,
} from "../../api/schema";
import { useCanManageUsers } from "../../api/session";
import {
  ChannelForm,
  KIND_WORDS,
  TYPE_WORDS,
} from "../../components/channel-form";
import { UpgradeHint } from "../../components/upgrade-hint";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ConfirmDialog, Dialog } from "../../components/ui/dialog";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
} from "../../components/ui/states";
import { useToast } from "../../components/ui/toast";
import { formatDateTime } from "../../lib/format";

/** One line of what a channel points at, never a secret or a path. */
export function targetWords(channel: ChannelView): string {
  const settings = channel.settings;
  switch (settings.kind) {
    case "webhook":
      return `${settings.host}${settings.hasSigningSecret ? " · signed" : " · unsigned"}`;
    case "discord":
      return settings.host;
    case "smtp":
      return `${settings.host}:${settings.port} (${settings.security === "tls" ? "TLS" : "STARTTLS"}) · from ${settings.from} to ${settings.to.length} ${settings.to.length === 1 ? "address" : "addresses"}`;
    default:
      return "The bell in the top bar";
  }
}

function ChannelCard({
  channel,
  onEdit,
  onDelete,
}: {
  channel: ChannelView;
  onEdit: (channel: ChannelView) => void;
  onDelete: (channel: ChannelView) => void;
}) {
  const { Icon, word } = KIND_WORDS[channel.kind];
  const [result, setResult] = useState<{
    at: string;
    answer: ChannelTestResult;
  } | null>(null);
  const test = useMutation({
    mutationFn: () => testChannel(channel.id),
    onSuccess: (answer) => {
      setResult({ at: new Date().toISOString(), answer });
    },
  });
  return (
    <Card
      title={channel.name}
      description={targetWords(channel)}
      aside={
        <div className="flex flex-wrap gap-2">
          <Badge kind="neutral" icon={<Icon className="size-3.5" />}>
            {word}
          </Badge>
          {channel.enabled ? (
            <Badge kind="success">On</Badge>
          ) : (
            <Badge kind="neutral" icon={<BellOff className="size-3.5" />}>
              Off
            </Badge>
          )}
        </div>
      }
    >
      <ul className="flex flex-wrap gap-1.5" aria-label="Event types">
        {channel.types.map((type) => (
          <li
            key={type}
            className="rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-fg"
          >
            {TYPE_WORDS[type]}
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium text-fg-muted">Last delivery:</dt>
          <dd className="flex flex-wrap items-center gap-1.5 text-fg">
            {channel.lastResult === null ? (
              "none yet"
            ) : (
              <>
                <Badge kind={channel.lastResult === "ok" ? "success" : "error"}>
                  {channel.lastResult === "ok" ? "Delivered" : "Failed"}
                </Badge>
                {formatDateTime(channel.lastDeliveryAt)}
              </>
            )}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium text-fg-muted">Failures:</dt>
          <dd className="text-fg">
            {channel.failures}
            {channel.lastError === null
              ? ""
              : ` · ${codeWords(channel.lastError)}`}
          </dd>
        </div>
      </dl>
      {test.isError ? (
        <Alert kind="error" title="The test could not run">
          {errorMessage(test.error)}
        </Alert>
      ) : result === null ? null : result.answer.ok ? (
        <Alert kind="success" title="Test message delivered">
          Sent {formatDateTime(result.at)}. The receiver got a message of kind
          test.
        </Alert>
      ) : (
        <Alert kind="error" title="Test message not delivered">
          {codeWords(result.answer.error ?? "connection")} (
          {result.answer.error})
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={test.isPending}
          icon={<Send className="size-4" aria-hidden="true" />}
          onClick={() => {
            test.mutate();
          }}
        >
          Send test
        </Button>
        <Button
          icon={<Pencil className="size-4" aria-hidden="true" />}
          onClick={() => {
            onEdit(channel);
          }}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          icon={<Trash2 className="size-4" aria-hidden="true" />}
          onClick={() => {
            onDelete(channel);
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

export function NotificationsPage() {
  const canManage = useCanManageUsers();
  const client = useQueryClient();
  const toast = useToast();
  const channels = useQuery({ ...channelsQuery(), enabled: canManage });
  const [form, setForm] = useState<"closed" | "new" | ChannelView>("closed");
  const [removing, setRemoving] = useState<ChannelView | null>(null);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: p9keys.channels });
  };

  const save = useMutation({
    mutationFn: (input: { body: ChannelInput; edit: ChannelView | null }) =>
      input.edit === null
        ? createChannel(input.body)
        : updateChannel(input.edit.id, input.body),
    onSuccess: (saved, input) => {
      toast.push({
        kind: "success",
        title: input.edit === null ? "Channel created" : "Channel saved",
        description: `${saved.name}: ${saved.enabled ? "delivering" : "off"}.`,
      });
      setForm("closed");
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (channel: ChannelView) => deleteChannel(channel.id),
    onSuccess: () => {
      toast.push({ kind: "success", title: "Channel deleted" });
      setRemoving(null);
      refresh();
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The channel was not deleted",
        description: errorMessage(error),
      });
    },
  });

  if (!canManage) {
    return (
      <Card title="Notifications">
        <Alert kind="info">
          The owner and admins set up the notification channels. Events of the
          servers you may see reach you through the bell in the top bar when an
          in-app channel is on.
        </Alert>
      </Card>
    );
  }

  if (channels.isPending) {
    return (
      <>
        <CardSkeleton />
        <CardSkeleton />
      </>
    );
  }

  if (channels.isError) {
    const payment =
      channels.error instanceof ApiError
        ? channels.error.paymentRequired
        : null;
    if (payment !== null) {
      return (
        <Card
          title="Notifications are off on the Free plan"
          description="Stored channels are kept and send nothing; delivery starts again when a licence key makes the plan Paid."
          aside={
            <Badge kind="neutral" icon={<BellOff className="size-3.5" />}>
              Off
            </Badge>
          }
        >
          <UpgradeHint body={payment} />
          <ul className="grid grid-cols-1 gap-2 text-sm text-fg sm:grid-cols-2">
            {(Object.keys(KIND_WORDS) as (keyof typeof KIND_WORDS)[]).map(
              (kind) => {
                const { Icon, word, help } = KIND_WORDS[kind];
                return (
                  <li key={kind} className="flex items-start gap-2">
                    <Icon
                      className="mt-0.5 size-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="font-medium">{word}:</span> {help}
                    </span>
                  </li>
                );
              },
            )}
          </ul>
        </Card>
      );
    }
    return (
      <ErrorState
        message={errorMessage(channels.error)}
        onRetry={() => {
          void channels.refetch();
        }}
        retrying={channels.isFetching}
      />
    );
  }

  const items = channels.data.items;
  const inAppTaken = items.some((channel) => channel.kind === "in_app");
  const addButton = (
    <Button
      variant="primary"
      icon={<Plus className="size-4" aria-hidden="true" />}
      onClick={() => {
        setForm("new");
      }}
    >
      Add channel
    </Button>
  );

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-xl font-semibold text-fg">
            Notification channels
          </h2>
          <p className="text-sm text-fg-muted">
            Where the fleet's events go: in the app, to a webhook, to Discord or
            by e-mail. Addresses and secrets are stored encrypted and never
            shown again.
          </p>
        </div>
        {addButton}
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={<Send className="size-6" aria-hidden="true" />}
          title="No channel yet"
          description="Add one to hear about applied changes, conflicts, drift, scheduled runs and backups as they happen."
          action={addButton}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              onEdit={(item) => {
                setForm(item);
              }}
              onDelete={setRemoving}
            />
          ))}
        </div>
      )}
      <Card title="Delivery" description="How a message gets there.">
        <ul className="grid grid-cols-1 gap-2 text-sm text-fg sm:grid-cols-2">
          <li className="flex items-start gap-2">
            <CircleCheck
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            Events are sent in order, one at a time per channel; a transient
            failure is retried three times.
          </li>
          <li className="flex items-start gap-2">
            <CircleX
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            A refused address, a TLS failure or a 4xx answer stops at once and
            shows as the last error here, as a code only.
          </li>
        </ul>
      </Card>
      {form === "closed" ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !save.isPending) {
              setForm("closed");
              save.reset();
            }
          }}
          title={form === "new" ? "New channel" : `Edit ${form.name}`}
          description={
            form === "new"
              ? "Where one kind of message goes and which events it carries."
              : "Secrets stay as stored unless you type a new one or remove them."
          }
          className="max-w-3xl"
        >
          <ChannelForm
            initial={form === "new" ? undefined : form}
            inAppTaken={inAppTaken}
            pending={save.isPending}
            error={save.error ?? undefined}
            onSubmit={(body) => {
              save.mutate({ body, edit: form === "new" ? null : form });
            }}
            onCancel={() => {
              setForm("closed");
              save.reset();
            }}
          />
        </Dialog>
      )}
      {removing === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRemoving(null);
            }
          }}
          title={`Delete ${removing.name}?`}
          description={
            removing.kind === "in_app"
              ? "The in-app notifications stored for it go with it."
              : "Nothing is sent to it any more; its stored address and secret are erased."
          }
          confirmLabel="Delete"
          destructive
          loading={remove.isPending}
          onConfirm={() => {
            remove.mutate(removing);
          }}
        />
      )}
    </>
  );
}
