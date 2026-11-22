import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string | undefined;
  actions?: ReactNode;
}

/** Every routed page starts with one (design-direction-1 part 1.2). */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold text-fg">{title}</h1>
        {description !== undefined ? (
          <p className="text-sm text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
