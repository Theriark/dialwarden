// Inline status messages with an icon and text: every error state and every
// banner uses one. role alert for errors, status for the rest.
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type AlertKind = "error" | "warning" | "success" | "info";

interface AlertProps {
  kind: AlertKind;
  title?: string | undefined;
  children?: ReactNode;
  /** A button or link shown under the text. */
  action?: ReactNode;
  className?: string | undefined;
}

function kindClass(kind: AlertKind): string {
  switch (kind) {
    case "error":
      return "border-error/40 bg-error-soft text-error";
    case "warning":
      return "border-warning/40 bg-warning-soft text-warning";
    case "success":
      return "border-success/40 bg-success-soft text-success";
    default:
      return "border-info/40 bg-info-soft text-info";
  }
}

function kindIcon(kind: AlertKind): ReactNode {
  const className = "mt-0.5 size-5 shrink-0";
  switch (kind) {
    case "error":
      return <CircleX className={className} aria-hidden="true" />;
    case "warning":
      return <TriangleAlert className={className} aria-hidden="true" />;
    case "success":
      return <CircleCheck className={className} aria-hidden="true" />;
    default:
      return <Info className={className} aria-hidden="true" />;
  }
}

export function Alert({
  kind,
  title,
  children,
  action,
  className,
}: AlertProps) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-card border p-4 text-sm",
        kindClass(kind),
        className,
      )}
    >
      {kindIcon(kind)}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title !== undefined ? <p className="font-semibold">{title}</p> : null}
        {children !== undefined ? (
          <div className="text-fg">{children}</div>
        ) : null}
        {action !== undefined ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}
