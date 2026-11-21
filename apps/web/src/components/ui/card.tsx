import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

interface CardProps {
  title?: string | undefined;
  description?: string | undefined;
  /** Right of the title: a badge or an action. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}

export function Card({
  title,
  description,
  aside,
  children,
  className,
}: CardProps) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-card sm:p-6",
        className,
      )}
    >
      {title !== undefined ? (
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-heading text-xl font-semibold text-fg">
              {title}
            </h2>
            {description !== undefined ? (
              <p className="text-sm text-fg-muted">{description}</p>
            ) : null}
          </div>
          {aside}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** A label and value pair inside a card (licence facts, About facts). */
export function Fact({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">
        {label}
      </dt>
      <dd className={cn("text-sm text-fg", mono && "font-mono")}>{children}</dd>
    </div>
  );
}
