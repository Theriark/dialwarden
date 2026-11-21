// The app shell (design-direction-1 part 1.1): a 56 px top bar with the
// horizontal logo, the theme and user menus, the Development licence banner,
// the navigation column (expanded or an icon rail), a navigation sheet on
// tablets and a bottom tab bar with a More sheet on phones.
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useMatches, useRouter } from "@tanstack/react-router";
import {
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { entitlementQuery } from "../../api/queries";
import { signOut, useSessionUser } from "../../api/session";
import { cn } from "../../lib/cn";
import { initials } from "../../lib/format";
import { readStored, writeStored } from "../../lib/storage";
import { useMediaQuery } from "../../lib/use-media-query";
import { useTheme } from "../../theme/theme-provider";
import { isThemePreference, type ThemePreference } from "../../theme/theme";
import { pageTitle } from "../../title";
import { Logo } from "../brand/logo";
import { DevLicenceBanner } from "../dev-licence-banner";
import { IconButton } from "../ui/button";
import { Sheet } from "../ui/dialog";
import { Tip } from "../ui/tooltip";
import { NAV_ITEMS, PHONE_TABS, type NavItem } from "./nav";

const NAV_KEY = "dw.nav";
const MENU_CONTENT =
  "z-50 min-w-44 rounded-card border border-border-strong bg-surface p-1 text-sm text-fg shadow-card";
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-control px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent-soft";
const NAV_LINK =
  "flex h-10 items-center gap-3 border-l-[3px] border-transparent pr-3 pl-4 text-sm font-medium text-fg-muted hover:bg-accent-soft hover:text-fg";
const NAV_ACTIVE = "border-primary bg-accent-soft text-fg";

function usePageTitle(): string | undefined {
  const matches = useMatches();
  let title: string | undefined;
  for (const match of matches) {
    if (typeof match.staticData.title === "string") {
      title = match.staticData.title;
    }
  }
  useEffect(() => {
    document.title = pageTitle(title);
  }, [title]);
  return title;
}

function themeIcon(preference: ThemePreference): LucideIcon {
  if (preference === "dark") {
    return Moon;
  }
  if (preference === "light") {
    return Sun;
  }
  return Monitor;
}

function ThemeMenu() {
  const { preference, setPreference } = useTheme();
  const Icon = themeIcon(preference);
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton label="Theme">
          <Icon className="size-5" aria-hidden="true" />
        </IconButton>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className={MENU_CONTENT}>
          <Menu.RadioGroup
            value={preference}
            onValueChange={(value) => {
              if (isThemePreference(value)) {
                setPreference(value);
              }
            }}
          >
            <Menu.RadioItem value="light" className={MENU_ITEM}>
              <Sun className="size-4" aria-hidden="true" />
              Light
            </Menu.RadioItem>
            <Menu.RadioItem value="dark" className={MENU_ITEM}>
              <Moon className="size-4" aria-hidden="true" />
              Dark
            </Menu.RadioItem>
            <Menu.RadioItem value="system" className={MENU_ITEM}>
              <Monitor className="size-4" aria-hidden="true" />
              System
            </Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function UserMenu() {
  const user = useSessionUser();
  const client = useQueryClient();
  const router = useRouter();
  if (user === null) {
    return null;
  }
  const leave = async () => {
    await signOut(client);
    await router.navigate({ to: "/login" });
  };
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          type="button"
          className="flex h-9 items-center gap-2 rounded-control px-1.5 text-sm hover:bg-accent-soft"
          aria-label={`Account menu for ${user.name}`}
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-fg">
            {initials(user.name)}
          </span>
          <span className="hidden max-w-32 truncate text-fg md:inline">
            {user.name}
          </span>
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className={MENU_CONTENT}>
          <Menu.Label className="px-2 py-1.5">
            <span className="block truncate font-medium text-fg">
              {user.name}
            </span>
            <span className="block truncate text-xs text-fg-muted">
              {user.email}
            </span>
            <span className="block text-xs text-fg-muted capitalize">
              {user.role}
            </span>
          </Menu.Label>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item asChild className={MENU_ITEM}>
            <Link to="/settings/profile">
              <UserRound className="size-4" aria-hidden="true" />
              Profile
            </Link>
          </Menu.Item>
          <Menu.Item
            className={MENU_ITEM}
            onSelect={() => {
              void leave();
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function NavLink({
  item,
  rail,
  onNavigate,
}: {
  item: NavItem;
  rail: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const Icon = item.icon;
  const link = (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === "/" }}
      className={cn(NAV_LINK, rail && "justify-center pr-0 pl-0")}
      activeProps={{ className: NAV_ACTIVE }}
      onClick={onNavigate}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      {rail ? <span className="sr-only">{item.label}</span> : item.label}
    </Link>
  );
  if (rail) {
    return (
      <Tip label={item.label} side="right">
        <span className="block">{link}</span>
      </Tip>
    );
  }
  return link;
}

function NavList({
  rail,
  onNavigate,
}: {
  rail: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => (
        <li key={item.to}>
          <NavLink item={item} rail={rail} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
}

function readNavPreference(): boolean {
  return readStored(NAV_KEY) === "rail";
}

function PhoneTabs() {
  const [moreOpen, setMoreOpen] = useState(false);
  const tabs = NAV_ITEMS.filter((item) => PHONE_TABS.includes(item.to));
  const rest = NAV_ITEMS.filter((item) => !PHONE_TABS.includes(item.to));
  const tabClass =
    "flex flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-fg-muted";
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 flex h-14 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {tabs.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            className={tabClass}
            activeProps={{ className: "text-primary" }}
          >
            <Icon className="size-5" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
      <button
        type="button"
        className={cn(tabClass, moreOpen && "text-primary")}
        onClick={() => {
          setMoreOpen(true);
        }}
        aria-haspopup="dialog"
      >
        <MoreHorizontal className="size-5" aria-hidden="true" />
        More
      </button>
      <Sheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title="More"
        side="bottom"
      >
        <ul className="flex flex-col gap-0.5">
          {rest.map((item) => (
            <li key={item.to}>
              <NavLink
                item={item}
                rail={false}
                onNavigate={() => {
                  setMoreOpen(false);
                }}
              />
            </li>
          ))}
        </ul>
      </Sheet>
    </nav>
  );
}

export function AppShell() {
  const title = usePageTitle();
  const wide = useMediaQuery("(min-width: 1024px)");
  const phone = !useMediaQuery("(min-width: 640px)");
  const [railPreferred, setRailPreferred] = useState(readNavPreference);
  const [sheetOpen, setSheetOpen] = useState(false);
  const entitlement = useQuery(entitlementQuery());
  const rail = !wide || railPreferred;

  const toggleRail = () => {
    const next = !railPreferred;
    setRailPreferred(next);
    writeStored(NAV_KEY, next ? "rail" : "expanded");
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {phone ? (
            <>
              <Link to="/" aria-label="Fleet">
                <Logo variant="mark" />
              </Link>
              <span className="truncate font-heading text-xl font-semibold">
                {title ?? "Dialwarden"}
              </span>
            </>
          ) : (
            <>
              {!wide ? (
                <IconButton
                  label="Open navigation"
                  onClick={() => {
                    setSheetOpen(true);
                  }}
                >
                  <MenuIcon className="size-5" aria-hidden="true" />
                </IconButton>
              ) : null}
              <Link to="/" className="flex items-center">
                <Logo variant="horizontal" />
              </Link>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <ThemeMenu />
          <UserMenu />
        </div>
      </header>
      <DevLicenceBanner entitlement={entitlement.data} />
      <div className="flex flex-1">
        {phone ? null : (
          <aside
            className={cn(
              "sticky top-14 flex h-[calc(100dvh-3.5rem)] shrink-0 flex-col justify-between border-r border-border bg-surface py-3",
              rail ? "w-16" : "w-58",
            )}
          >
            <nav aria-label="Main">
              <NavList rail={rail} />
            </nav>
            {wide ? (
              <div className={cn("px-2", rail && "flex justify-center")}>
                <IconButton
                  label={rail ? "Expand navigation" : "Collapse navigation"}
                  onClick={toggleRail}
                >
                  {rail ? (
                    <PanelLeftOpen className="size-5" aria-hidden="true" />
                  ) : (
                    <PanelLeftClose className="size-5" aria-hidden="true" />
                  )}
                </IconButton>
              </div>
            ) : null}
          </aside>
        )}
        <main
          className={cn(
            "min-w-0 flex-1 px-4 pt-6 sm:px-6",
            phone ? "pb-24" : "pb-10",
          )}
        >
          <div className="mx-auto w-full max-w-[1280px]">
            <Outlet />
          </div>
        </main>
      </div>
      {phone ? <PhoneTabs /> : null}
      {!phone && !wide ? (
        <Sheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          title="Navigation"
          side="left"
        >
          <nav aria-label="Main">
            <NavList
              rail={false}
              onNavigate={() => {
                setSheetOpen(false);
              }}
            />
          </nav>
        </Sheet>
      ) : null}
    </div>
  );
}
