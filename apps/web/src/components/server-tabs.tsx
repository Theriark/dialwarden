// The second-level tab strip of the server pages (design-direction-1 part
// 1.2): Settings, Raw, History, Hooks and Launch, each a route. Raw is owner
// only, so everyone else does not see it. The status chip and the pending
// badge of the server sit on the right of the strip.
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  FileTerminal,
  History,
  Plug,
  Rocket,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { serverQuery, serverStatusQuery } from "../api/queries";
import { useIsOwner } from "../api/session";
import { cn } from "../lib/cn";
import { PendingBadge } from "./pending-badge";
import { StatusChip } from "./status-chip";

export type ServerSection = "settings" | "raw" | "history" | "hooks" | "launch";

interface Tab {
  readonly id: ServerSection;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly ownerOnly?: boolean;
}

const TABS: readonly Tab[] = [
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
  { id: "raw", label: "Raw files", icon: FileTerminal, ownerOnly: true },
  { id: "history", label: "History", icon: History },
  { id: "hooks", label: "Hooks", icon: Plug },
  { id: "launch", label: "Launch", icon: Rocket },
];

const LINK =
  "flex h-10 shrink-0 items-center gap-2 border-b-[3px] border-transparent px-3 text-sm font-medium whitespace-nowrap text-fg-muted transition-colors duration-150 hover:bg-accent-soft hover:text-fg";
const ACTIVE = "border-primary text-fg";

export function ServerTabs({
  slug,
  current,
}: {
  slug: string;
  current: ServerSection;
}) {
  const isOwner = useIsOwner();
  const server = useQuery(serverQuery(slug));
  const status = useQuery(serverStatusQuery(slug));
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border">
      <nav aria-label="Server sections" className="-mb-px overflow-x-auto">
        <ul className="flex">
          {TABS.filter((tab) => tab.ownerOnly !== true || isOwner).map(
            (tab) => {
              const Icon = tab.icon;
              const active = tab.id === current;
              return (
                <li key={tab.id}>
                  <Link
                    to={`/servers/$slug/${tab.id}`}
                    params={{ slug }}
                    aria-current={active ? "page" : undefined}
                    className={cn(LINK, active && ACTIVE)}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {tab.label}
                  </Link>
                </li>
              );
            },
          )}
        </ul>
      </nav>
      <div className="flex items-center gap-2 pb-2">
        <StatusChip
          status={status.data}
          loading={status.isPending}
          error={status.error ?? undefined}
          simulated={server.data?.demo === true}
        />
        <PendingBadge count={status.data?.pending ?? 0} slug={slug} />
      </div>
    </div>
  );
}
