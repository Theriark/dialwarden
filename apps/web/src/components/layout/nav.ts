// The navigation entries (the eight of dev-work-plan P1-B plus the audit
// log of P8) and the phone tab bar.
import {
  Activity,
  CalendarClock,
  FileText,
  Layers,
  LayoutGrid,
  ScrollText,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavPath =
  | "/"
  | "/presets"
  | "/schedules"
  | "/matrix"
  | "/reports"
  | "/activity"
  | "/audit"
  | "/users"
  | "/settings";

export interface NavItem {
  to: NavPath;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Fleet", icon: Server },
  { to: "/presets", label: "Presets", icon: Layers },
  { to: "/schedules", label: "Schedules", icon: CalendarClock },
  { to: "/matrix", label: "Matrix", icon: LayoutGrid },
  { to: "/reports", label: "Reports", icon: FileText },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/audit", label: "Audit", icon: ScrollText },
  { to: "/users", label: "Users", icon: Users },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** The four entries of the phone tab bar; the rest sit behind More. */
export const PHONE_TABS: readonly NavPath[] = [
  "/",
  "/activity",
  "/presets",
  "/settings",
];
