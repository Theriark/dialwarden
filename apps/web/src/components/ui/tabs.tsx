// Tabs on plain buttons with the tabs keyboard pattern (arrow keys, Home and
// End move the selection; the tab list is one tab stop). No Radix Tabs in
// the lockfile of 27.0.0, so this is the house component for the snippet
// panel and the Activity filters.
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
}

interface TabsProps {
  /** The accessible name of the tab list. */
  label: string;
  items: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** The content of the selected tab. */
  panel: (id: string) => ReactNode;
  className?: string | undefined;
}

const TAB =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-control border border-transparent px-3 text-sm font-medium whitespace-nowrap text-fg-muted transition-colors duration-150 hover:bg-accent-soft hover:text-fg aria-selected:border-border-strong aria-selected:bg-surface aria-selected:text-fg";

export function Tabs({
  label,
  items,
  value,
  onChange,
  panel,
  className,
}: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const base = `tabs-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.id === value);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") {
      next = (index - 1 + items.length) % items.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    const target = items.at(next);
    if (target === undefined) return;
    onChange(target.id);
    const button = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-tab="${target.id}"]`,
    );
    button?.focus();
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        className="flex gap-1 overflow-x-auto rounded-card border border-border bg-bg p-1"
        onKeyDown={move}
      >
        {items.map((item) => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${base}-tab-${item.id}`}
              data-tab={item.id}
              aria-selected={selected}
              aria-controls={`${base}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              className={TAB}
              onClick={() => {
                onChange(item.id);
              }}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel-${value}`}
        aria-labelledby={`${base}-tab-${value}`}
        tabIndex={0}
        className="rounded-control focus:outline-none"
      >
        {panel(value)}
      </div>
    </div>
  );
}
