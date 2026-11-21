// Designed empty, loading and error states (references/ui-standard.md).
import { CircleX, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string | undefined;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-card border border-border bg-surface px-6 py-12 text-center shadow-card",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-primary">
        {icon}
      </div>
      <h2 className="font-heading text-xl font-semibold text-fg">{title}</h2>
      <p className="max-w-md text-sm text-fg-muted">{description}</p>
      {action !== undefined ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry?: (() => void) | undefined;
  retrying?: boolean | undefined;
  className?: string | undefined;
}

export function ErrorState({
  message,
  onRetry,
  retrying = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 rounded-card border border-error/40 bg-surface px-6 py-10 text-center shadow-card",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-error-soft text-error">
        <CircleX className="size-6" aria-hidden="true" />
      </div>
      <h2 className="font-heading text-xl font-semibold text-fg">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-fg-muted">{message}</p>
      {onRetry !== undefined ? (
        <Button
          onClick={onRetry}
          loading={retrying}
          icon={<RefreshCw className="size-4" aria-hidden="true" />}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}

interface SkeletonProps {
  className?: string | undefined;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-control bg-skeleton", className)}
    />
  );
}

/** A card-shaped loading placeholder with a title line and two body lines. */
export function CardSkeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-card border border-border bg-surface p-6",
        className,
      )}
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/** Table rows while a list loads. */
export function RowsSkeleton({ rows = 3 }: { rows?: number | undefined }) {
  const items = Array.from({ length: rows }, (_, index) => index);
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {items.map((index) => (
        <Skeleton key={index} className="h-11 w-full rounded-card" />
      ))}
    </div>
  );
}
