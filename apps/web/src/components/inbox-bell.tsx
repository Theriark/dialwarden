// The in-app notifications (dev-work-plan P9-C step 4): the bell in the top
// bar with the unread count, and the list behind it. The rows are the ones
// the in-app channel stored for the servers this person may see; the read
// marker is the person's own. On Free the route answers 402 and the bell is
// not shown at all (the Free fallback of this screen is its absence; the
// Notifications settings page carries the upgrade hint).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, FlaskConical, MailOpen } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { markInboxRead } from "../api/fleet";
import { inboxQuery, p9keys } from "../api/queries";
import type { InboxItem, InboxPage } from "../api/schema";
import { formatDateTime } from "../lib/format";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

function Row({ item }: { item: InboxItem }) {
  return (
    <li className="flex flex-col gap-1 px-1 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {item.type === "test" ? (
          <Badge kind="info" icon={<FlaskConical className="size-3.5" />}>
            Test
          </Badge>
        ) : null}
        <span className="text-sm font-medium text-fg">{item.title}</span>
      </div>
      {item.lines.map((line, index) => (
        <span key={`${item.id}-${index}`} className="text-xs text-fg-muted">
          {line}
        </span>
      ))}
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
        <time dateTime={item.at}>{formatDateTime(item.at)}</time>
        {item.serverId === null ? null : (
          <Link
            to="/servers/$slug/history"
            params={{ slug: item.serverId }}
            className="font-medium text-primary hover:underline"
          >
            Open the server's history
          </Link>
        )}
      </div>
    </li>
  );
}

export function InboxBell() {
  const client = useQueryClient();
  const inbox = useQuery({ ...inboxQuery(), refetchInterval: 60_000 });
  const [open, setOpen] = useState(false);
  const read = useMutation({
    mutationFn: (upTo: number) => markInboxRead(upTo),
    onSuccess: (answer) => {
      client.setQueryData(p9keys.inbox, (current: InboxPage | undefined) =>
        current === undefined ? current : { ...current, unread: answer.unread },
      );
    },
  });

  if (inbox.data === undefined) {
    return null;
  }
  const unread = inbox.data.unread;
  const items = inbox.data.items;
  const newest = items.reduce((max, item) => Math.max(max, item.id), 0);
  const label =
    unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        className="relative inline-flex size-9 items-center justify-center rounded-control border border-transparent text-fg-muted transition-colors duration-150 hover:bg-accent-soft hover:text-fg"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Bell className="size-5" aria-hidden="true" />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-fg"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Notifications"
        description={
          unread > 0
            ? `${unread} unread of the newest ${items.length}.`
            : items.length === 0
              ? "Nothing yet."
              : `The newest ${items.length}; everything read.`
        }
        footer={
          <Button
            icon={<MailOpen className="size-4" aria-hidden="true" />}
            loading={read.isPending}
            disabled={unread === 0}
            onClick={() => {
              read.mutate(newest);
            }}
          >
            Mark all as read
          </Button>
        }
      >
        {read.isError ? (
          <Alert kind="error">{errorMessage(read.error)}</Alert>
        ) : null}
        {items.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Events of the servers you may see appear here once an in-app channel
            is on.
          </p>
        ) : (
          <ul className="flex max-h-[60dvh] flex-col divide-y divide-border overflow-y-auto">
            {items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
