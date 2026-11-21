// Screens that later phases build render a designed empty state, never a
// blank page and never a dead button (dev-work-plan P1-B).
import {
  Activity,
  CalendarClock,
  FileText,
  Layers,
  LayoutGrid,
  Server,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "../components/layout/page-header";
import { EmptyState } from "../components/ui/states";

interface ComingSoonProps {
  title: string;
  description: string;
  icon: ReactNode;
  phase: string;
}

export function ComingSoon({
  title,
  description,
  icon,
  phase,
}: ComingSoonProps) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={icon}
        title="Coming in a later phase"
        description={`${title} arrives with ${phase} of this build. Nothing to set up here yet.`}
      />
    </>
  );
}

const ICON = "size-6";

export function FleetPage() {
  return (
    <ComingSoon
      title="Fleet"
      description="Your game servers, their settings and their state."
      icon={<Server className={ICON} aria-hidden="true" />}
      phase="phase P5"
    />
  );
}

export function PresetsPage() {
  return (
    <ComingSoon
      title="Presets"
      description="Saved settings you can apply to a server."
      icon={<Layers className={ICON} aria-hidden="true" />}
      phase="phase P5"
    />
  );
}

export function SchedulesPage() {
  return (
    <ComingSoon
      title="Schedules"
      description="Changes that run at a set time and revert on their own."
      icon={<CalendarClock className={ICON} aria-hidden="true" />}
      phase="phase P9"
    />
  );
}

export function MatrixPage() {
  return (
    <ComingSoon
      title="Matrix"
      description="Settings of every server of one game, side by side."
      icon={<LayoutGrid className={ICON} aria-hidden="true" />}
      phase="phase P9"
    />
  );
}

export function ReportsPage() {
  return (
    <ComingSoon
      title="Reports"
      description="Change reports you can print, copy or post."
      icon={<FileText className={ICON} aria-hidden="true" />}
      phase="phase P9"
    />
  );
}

export function ActivityPage() {
  return (
    <ComingSoon
      title="Activity"
      description="Everything that happened across the fleet."
      icon={<Activity className={ICON} aria-hidden="true" />}
      phase="phase P6"
    />
  );
}

export function UsersPage() {
  return (
    <ComingSoon
      title="Users"
      description="Teammates, roles and per-server grants."
      icon={<Users className={ICON} aria-hidden="true" />}
      phase="phase P8"
    />
  );
}
