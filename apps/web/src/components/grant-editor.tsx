// The per-server grants of an editor or a viewer (dev-work-plan P8-B
// screen 2): one row per server with a three-way choice, none, read or
// write, as a radio group, so the arrow keys move it and each state has a
// word. The rows stack on a phone: the server name on top, the choice under
// it, every target at least 44 px tall. A viewer may read at most, so the
// write choice is shown but disabled for a viewer with the reason.
import { Eye, PencilLine, Server as ServerIcon, X } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { Grant, GrantLevel } from "../api/schema";
import { cn } from "../lib/cn";

export type GrantChoice = GrantLevel | "none";

export interface GrantServer {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

/** The level a user holds on a server, or none. */
export function grantLevelOf(
  grants: readonly Grant[],
  server: string,
): GrantChoice {
  return grants.find((grant) => grant.server === server)?.level ?? "none";
}

/** The grants with one server set to a level (none removes it). */
export function withGrant(
  grants: readonly Grant[],
  server: string,
  level: GrantChoice,
): Grant[] {
  const rest = grants.filter((grant) => grant.server !== server);
  if (level === "none") {
    return rest;
  }
  return [...rest, { server, level }];
}

/** "2 servers, 1 for writing" style summary of a user's grants. */
export function describeGrants(grants: readonly Grant[]): string {
  if (grants.length === 0) {
    return "No server";
  }
  const writes = grants.filter((grant) => grant.level === "write").length;
  const servers = grants.length === 1 ? "1 server" : `${grants.length} servers`;
  if (writes === 0) {
    return `${servers}, read only`;
  }
  return `${servers}, ${writes} for writing`;
}

const CHOICES: readonly {
  value: GrantChoice;
  label: string;
  icon: ReactNode;
}[] = [
  {
    value: "none",
    label: "None",
    icon: <X className="size-4" aria-hidden="true" />,
  },
  {
    value: "read",
    label: "Read",
    icon: <Eye className="size-4" aria-hidden="true" />,
  },
  {
    value: "write",
    label: "Write",
    icon: <PencilLine className="size-4" aria-hidden="true" />,
  },
];

const CHOICE =
  "inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg-muted select-none has-[:checked]:border-primary has-[:checked]:bg-accent-soft has-[:checked]:text-fg has-[:focus-visible]:shadow-[0_0_0_2px_var(--dw-bg),0_0_0_4px_var(--dw-primary)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 sm:min-h-9 sm:flex-none";

export interface GrantEditorProps {
  servers: readonly GrantServer[];
  value: readonly Grant[];
  onChange: (grants: Grant[]) => void;
  /** The role the grants belong to: a viewer reads at most. */
  role: string;
  disabled?: boolean | undefined;
}

export function GrantEditor({
  servers,
  value,
  onChange,
  role,
  disabled = false,
}: GrantEditorProps) {
  const base = useId();
  const readOnlyRole = role === "viewer";
  if (servers.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-muted">
        <ServerIcon className="size-5 shrink-0" aria-hidden="true" />
        No servers yet. Add one on the Fleet page first.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        {readOnlyRole
          ? "A viewer reads the servers chosen here; writing needs the editor role."
          : "An editor reads or writes each server chosen here and never sees the rest."}
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
        {servers.map((server) => {
          const current = grantLevelOf(value, server.id);
          const name = `${base}-${server.id}`;
          return (
            <li
              key={server.id}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span
                  id={`${name}-label`}
                  className="truncate text-sm font-medium text-fg"
                >
                  {server.name}
                </span>
                <span className="truncate text-xs text-fg-muted">
                  {server.displayName}
                </span>
              </div>
              <div
                role="radiogroup"
                aria-labelledby={`${name}-label`}
                className="flex gap-1.5"
              >
                {CHOICES.map((choice) => {
                  const blocked =
                    disabled || (readOnlyRole && choice.value === "write");
                  return (
                    <label
                      key={choice.value}
                      className={cn(CHOICE)}
                      title={
                        readOnlyRole && choice.value === "write"
                          ? "A viewer cannot write"
                          : undefined
                      }
                    >
                      <input
                        type="radio"
                        name={name}
                        value={choice.value}
                        className="sr-only"
                        checked={current === choice.value}
                        disabled={blocked}
                        onChange={() => {
                          onChange(withGrant(value, server.id, choice.value));
                        }}
                      />
                      {choice.icon}
                      {choice.label}
                    </label>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-muted">{describeGrants(value)}.</p>
    </div>
  );
}
