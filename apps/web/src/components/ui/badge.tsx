// Status badges: always an icon plus text on a 10 percent tint of the status
// colour over the surface, never colour alone (design-direction-1 part 2.3).
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Info,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type BadgeKind =
  | "error"
  | "warning"
  | "pending"
  | "success"
  | "info"
  | "neutral";

interface BadgeProps {
  kind: BadgeKind;
  children: ReactNode;
  className?: string | undefined;
  /** Replaces the status icon (for example a lock or a key). */
  icon?: ReactNode;
}

function kindClass(kind: BadgeKind): string {
  switch (kind) {
    case "error":
      return "border-error/40 bg-error-soft text-error";
    case "warning":
      return "border-warning/40 bg-warning-soft text-warning";
    case "pending":
      return "border-pending/40 bg-pending-soft text-pending";
    case "success":
      return "border-success/40 bg-success-soft text-success";
    case "info":
      return "border-info/40 bg-info-soft text-info";
    default:
      return "border-border-strong bg-surface text-neutral";
  }
}

function kindIcon(kind: BadgeKind): ReactNode {
  const className = "size-3.5 shrink-0";
  switch (kind) {
    case "error":
      return <CircleX className={className} aria-hidden="true" />;
    case "warning":
      return <TriangleAlert className={className} aria-hidden="true" />;
    case "pending":
      return <Clock className={className} aria-hidden="true" />;
    case "success":
      return <CircleCheck className={className} aria-hidden="true" />;
    case "info":
      return <Info className={className} aria-hidden="true" />;
    default:
      return <CircleMinus className={className} aria-hidden="true" />;
  }
}

export function Badge({ kind, children, className, icon }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        kindClass(kind),
        className,
      )}
    >
      {icon ?? kindIcon(kind)}
      {children}
    </span>
  );
}
