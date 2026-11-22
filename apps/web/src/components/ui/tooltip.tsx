import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;

interface TipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left" | undefined;
}

/** A tooltip on a control that already has an accessible name. */
export function Tip({ label, children, side = "top" }: TipProps) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-control border border-border-strong bg-surface px-2 py-1 text-xs text-fg shadow-card"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
