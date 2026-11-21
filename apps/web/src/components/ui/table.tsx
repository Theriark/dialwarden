// A data table with a sticky header. Sorting, filters and density arrive with
// the first long list in P5-A; P1-B lists are short.
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Table({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string | undefined;
  label: string;
}) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-card border border-border bg-surface shadow-card",
        className,
      )}
    >
      <table aria-label={label} className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = "left",
}: {
  children: ReactNode;
  className?: string | undefined;
  align?: "left" | "right" | undefined;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 border-b border-border-strong bg-surface px-4 py-3 text-xs font-medium tracking-wide text-fg-muted uppercase",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = "left",
  mono = false,
}: {
  children: ReactNode;
  className?: string | undefined;
  align?: "left" | "right" | undefined;
  mono?: boolean | undefined;
}) {
  return (
    <td
      className={cn(
        "border-b border-border px-4 py-3 align-middle text-fg",
        align === "right" ? "text-right" : "text-left",
        mono && "font-mono tabular",
        className,
      )}
    >
      {children}
    </td>
  );
}
