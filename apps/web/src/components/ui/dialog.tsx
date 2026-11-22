// Dialog, Sheet and the confirm dialog on the Radix primitives: focus is
// trapped, Escape closes, focus returns to the opener.
import * as AD from "@radix-ui/react-alert-dialog";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button, IconButton } from "./button";

const OVERLAY = "fixed inset-0 z-40 bg-overlay";
const PANEL =
  "z-50 flex flex-col gap-4 border border-border bg-surface p-6 text-fg shadow-card focus:outline-none";
const CENTERED =
  "fixed top-1/2 left-1/2 max-h-[90dvh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card";
const TITLE = "font-heading text-xl font-semibold";
const DESCRIPTION = "text-sm text-fg-muted";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  children: ReactNode;
  footer?: ReactNode;
  className?: string | undefined;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={OVERLAY} />
        <D.Content className={cn(PANEL, CENTERED, "max-w-lg", className)}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <D.Title className={TITLE}>{title}</D.Title>
              {description !== undefined ? (
                <D.Description className={DESCRIPTION}>
                  {description}
                </D.Description>
              ) : null}
            </div>
            <D.Close asChild>
              <IconButton label="Close">
                <X className="size-5" aria-hidden="true" />
              </IconButton>
            </D.Close>
          </div>
          {children}
          {footer !== undefined ? (
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              {footer}
            </div>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  side: "left" | "bottom";
  children: ReactNode;
}

const LEFT_SHEET = "fixed inset-y-0 left-0 w-72 max-w-[85vw] rounded-r-card";
const BOTTOM_SHEET =
  "fixed inset-x-0 bottom-0 max-h-[80dvh] rounded-t-card pb-[max(1.5rem,env(safe-area-inset-bottom))]";

/** A dialog pinned to the left (navigation) or the bottom (phone menus). */
export function Sheet({
  open,
  onOpenChange,
  title,
  side,
  children,
}: SheetProps) {
  const position = side === "left" ? LEFT_SHEET : BOTTOM_SHEET;
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={OVERLAY} />
        <D.Content className={cn(PANEL, position)}>
          <div className="flex items-center justify-between gap-4">
            <D.Title className="font-heading text-lg font-semibold">
              {title}
            </D.Title>
            <D.Close asChild>
              <IconButton label="Close">
                <X className="size-5" aria-hidden="true" />
              </IconButton>
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean | undefined;
  loading?: boolean | undefined;
  /** Disables the confirm button until the extra form is complete. */
  confirmDisabled?: boolean | undefined;
  onConfirm: () => void;
  children?: ReactNode;
}

/** Every destructive or irreversible action goes through this one. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  loading = false,
  confirmDisabled = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <AD.Root open={open} onOpenChange={onOpenChange}>
      <AD.Portal>
        <AD.Overlay className={OVERLAY} />
        <AD.Content className={cn(PANEL, CENTERED, "max-w-md")}>
          <AD.Title className={TITLE}>{title}</AD.Title>
          <AD.Description className={DESCRIPTION}>{description}</AD.Description>
          {children}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <AD.Cancel asChild>
              <Button variant="ghost" disabled={loading}>
                Cancel
              </Button>
            </AD.Cancel>
            <Button
              variant={destructive ? "destructive" : "primary"}
              loading={loading}
              disabled={confirmDisabled}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AD.Content>
      </AD.Portal>
    </AD.Root>
  );
}
