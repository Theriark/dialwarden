// Settings pages share one left sub-navigation at 768 and up, and a select at
// the top of the page on phones (design-direction-1 part 1.2).
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { PageHeader } from "./page-header";

type SettingsPath =
  | "/settings/profile"
  | "/settings/tokens"
  | "/settings/licence"
  | "/settings/plan"
  | "/settings/sso"
  | "/settings/privacy"
  | "/settings/backup";

const SECTIONS: readonly { to: SettingsPath; label: string }[] = [
  { to: "/settings/profile", label: "Profile" },
  { to: "/settings/tokens", label: "API tokens" },
  { to: "/settings/licence", label: "Licence" },
  { to: "/settings/plan", label: "Plan" },
  { to: "/settings/sso", label: "Single sign-on" },
  { to: "/settings/privacy", label: "Privacy" },
  { to: "/settings/backup", label: "Backup" },
];

const SECTION_LINK =
  "flex h-10 items-center rounded-control px-3 text-sm font-medium text-fg-muted hover:bg-accent-soft hover:text-fg";

function isSettingsPath(value: string): value is SettingsPath {
  return SECTIONS.some((section) => section.to === value);
}

export function SettingsLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const current = isSettingsPath(pathname) ? pathname : "/settings/profile";
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your account and tokens, the licence and plan of this instance, single sign-on, privacy and backups."
      />
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <nav aria-label="Settings sections" className="md:w-52 md:shrink-0">
          <label className="flex flex-col gap-1.5 md:hidden">
            <span className="text-sm font-medium text-fg">Section</span>
            <select
              className="h-10 rounded-control border border-border-strong bg-surface px-3 text-base text-fg"
              value={current}
              onChange={(event) => {
                const next = event.target.value;
                if (isSettingsPath(next)) {
                  void navigate({ to: next });
                }
              }}
            >
              {SECTIONS.map((section) => (
                <option key={section.to} value={section.to}>
                  {section.label}
                </option>
              ))}
            </select>
          </label>
          <ul className="hidden flex-col gap-0.5 md:flex">
            {SECTIONS.map((section) => (
              <li key={section.to}>
                <Link
                  to={section.to}
                  className={SECTION_LINK}
                  activeProps={{ className: "bg-accent-soft text-fg" }}
                >
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <Outlet />
        </div>
      </div>
    </>
  );
}
