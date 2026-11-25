// A value shown once: a new API token, an invitation link or a reset link.
// The value sits in a monospace block with one copy action, a sentence says
// it will not be shown again, and the dialog closes only through Done once
// the person has confirmed the copy, so a stray click outside never loses
// it (the recovery codes pattern of the profile page).
import { useState } from "react";
import { Button } from "./ui/button";
import { CodeBlock, CopyButton } from "./ui/code-block";
import { Dialog } from "./ui/dialog";

export interface Revealed {
  /** The dialog title, such as "Your new API token". */
  readonly title: string;
  readonly description: string;
  /** The accessible name of the value block. */
  readonly label: string;
  readonly value: string;
  /** A line under the value, such as the expiry. */
  readonly note?: string | undefined;
}

interface RevealOnceProps {
  revealed: Revealed | null;
  onDone: () => void;
}

export function RevealOnce({ revealed, onDone }: RevealOnceProps) {
  const [copied, setCopied] = useState(false);
  const close = () => {
    setCopied(false);
    onDone();
  };
  return (
    <Dialog
      open={revealed !== null}
      onOpenChange={(next) => {
        // Only Done closes it: the value is gone once the dialog is.
        if (!next && copied) {
          close();
        }
      }}
      title={revealed?.title ?? ""}
      description={revealed?.description ?? ""}
      footer={
        <Button variant="primary" disabled={!copied} onClick={close}>
          Done
        </Button>
      }
    >
      {revealed !== null ? (
        <div className="flex flex-col gap-3">
          <CodeBlock
            value={revealed.value}
            label={revealed.label}
            copy={false}
          />
          {revealed.note !== undefined ? (
            <p className="text-sm text-fg-muted">{revealed.note}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CopyButton value={revealed.value} label="Copy" />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={copied}
                onChange={(event) => {
                  setCopied(event.target.checked);
                }}
              />
              I have copied it
            </label>
          </div>
          <p className="text-xs text-fg-muted">
            This is the only time it is shown. Dialwarden keeps a hash, never
            the value.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
