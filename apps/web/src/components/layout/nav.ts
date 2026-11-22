// The eight navigation entries (dev-work-plan P1-B) and the phone tab bar.
import {
  Activity,
  CalendarClock,
  FileText,
  Layers,
  LayoutGrid,
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
