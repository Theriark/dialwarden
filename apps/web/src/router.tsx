// Code-based TanStack Router routes (no generated route tree, so typecheck
// needs no build step). The signed-in area is the pathless "app" layout: its
// beforeLoad sends an anonymous visitor to /setup while no owner exists, and
// to /login otherwise, with the requested page as the redirect parameter.
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { sessionQuery, setupQuery } from "./api/queries";
import { AppShell } from "./components/layout/app-shell";
import { SettingsLayout } from "./components/layout/settings-layout";
import { AboutPage } from "./pages/about";
import { ActivityPage } from "./pages/activity";
import { AuditPage } from "./pages/audit";
import { MatrixPage, ReportsPage, SchedulesPage } from "./pages/coming-soon";
import { InvitePage } from "./pages/invite";
import { PresetsPage } from "./pages/presets";
import { LoginPage, type LoginSearch } from "./pages/login";
import { TwoFactorPage } from "./pages/login-2fa";
import { NotFoundPage } from "./pages/not-found";
import { FleetPage } from "./pages/fleet";
import { ResetPage } from "./pages/reset";
import { NewServerPage } from "./pages/server-new";
import { ServerHistoryPage } from "./pages/server-history";
import { ServerHooksPage } from "./pages/server-hooks";
import { ServerLaunchPage } from "./pages/server-launch";
import { ServerRawPage } from "./pages/server-raw";
import { ServerSettingsPage } from "./pages/server-settings";
import { SetupPage } from "./pages/setup";
import { ApiAccessPage } from "./pages/settings/api-access";
import { BackupPage } from "./pages/settings/backup";
import { LicencePage } from "./pages/settings/licence";
import { PlanPage } from "./pages/settings/plan";
import { PrivacyPage } from "./pages/settings/privacy";
import { ProfilePage } from "./pages/settings/profile";
import { SsoPage } from "./pages/settings/sso";
import { UsersPage } from "./pages/users";

export interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  return <Outlet />;
}

function EmptyPage() {
  return null;
}

function loginSearch(search: Record<string, unknown>): LoginSearch {
  const target = search["redirect"];
  return typeof target === "string" ? { redirect: target } : {};
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  staticData: { title: "Setup" },
  beforeLoad: async ({ context }) => {
    const setup = await context.queryClient.fetchQuery(setupQuery());
    if (!setup.required) {
      throw redirect({ to: "/login" });
    }
  },
  component: SetupPage,
});

async function requireSignedOut(context: RouterContext): Promise<void> {
  const setup = await context.queryClient.fetchQuery(setupQuery());
  if (setup.required) {
    throw redirect({ to: "/setup" });
  }
  const session = await context.queryClient.fetchQuery(sessionQuery());
  if (session !== null) {
    throw redirect({ to: "/" });
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  staticData: { title: "Sign in" },
  validateSearch: loginSearch,
  beforeLoad: ({ context }) => requireSignedOut(context),
  component: LoginRoute,
});

function LoginRoute() {
  const search = loginRoute.useSearch();
  return <LoginPage search={search} />;
}

const twoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/2fa",
  staticData: { title: "Second step" },
  validateSearch: loginSearch,
  beforeLoad: ({ context }) => requireSignedOut(context),
  component: TwoFactorRoute,
});

function TwoFactorRoute() {
  const search = twoFactorRoute.useSearch();
  return <TwoFactorPage search={search} />;
}

// The invitation and reset links are public: the value is the proof, in
// the fragment. A signed-in visitor is sent to the fleet like on /login.
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite",
  staticData: { title: "Invitation" },
  beforeLoad: ({ context }) => requireSignedOut(context),
  component: InvitePage,
});

const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset",
  staticData: { title: "Password reset" },
  beforeLoad: ({ context }) => requireSignedOut(context),
  component: ResetPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery());
    if (session === null) {
      const setup = await context.queryClient.fetchQuery(setupQuery());
      if (setup.required) {
        throw redirect({ to: "/setup" });
      }
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: AppShell,
});

const fleetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  staticData: { title: "Fleet" },
  component: FleetPage,
});

const presetsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/presets",
  staticData: { title: "Presets" },
  component: PresetsPage,
});

const newServerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/servers/new",
  staticData: { title: "Add server" },
  component: NewServerPage,
});

const serverRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/servers/$slug",
});

const serverSettingsRoute = createRoute({
  getParentRoute: () => serverRoute,
  path: "/settings",
  staticData: { title: "Settings" },
  component: ServerSettingsPage,
});

const serverRawRoute = createRoute({
  getParentRoute: () => serverRoute,
  path: "/raw",
  staticData: { title: "Raw files" },
  component: ServerRawPage,
});

const serverHistoryRoute = createRoute({
  getParentRoute: () => serverRoute,
  path: "/history",
  staticData: { title: "History" },
  component: ServerHistoryPage,
});

const serverHooksRoute = createRoute({
  getParentRoute: () => serverRoute,
  path: "/hooks",
  staticData: { title: "Hooks" },
  component: ServerHooksPage,
});

const serverLaunchRoute = createRoute({
  getParentRoute: () => serverRoute,
  path: "/launch",
  staticData: { title: "Launch" },
  component: ServerLaunchPage,
});

const schedulesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/schedules",
  staticData: { title: "Schedules" },
  component: SchedulesPage,
});

const matrixRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/matrix",
  staticData: { title: "Matrix" },
  component: MatrixPage,
});

const reportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/reports",
  staticData: { title: "Reports" },
  component: ReportsPage,
});

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity",
  staticData: { title: "Activity" },
  component: ActivityPage,
});

const usersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/users",
  staticData: { title: "Users" },
  component: UsersPage,
});

const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/audit",
  staticData: { title: "Audit log" },
  component: AuditPage,
});

const aboutRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/about",
  staticData: { title: "About" },
  component: AboutPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  staticData: { title: "Settings" },
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/profile" });
  },
  component: EmptyPage,
});

const planRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/plan",
  staticData: { title: "Plan" },
  component: PlanPage,
});

const profileRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/profile",
  staticData: { title: "Profile" },
  component: ProfilePage,
});

const licenceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/licence",
  staticData: { title: "Licence" },
  component: LicencePage,
});

const backupRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/backup",
  staticData: { title: "Backup" },
  component: BackupPage,
});

const ssoRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/sso",
  staticData: { title: "Single sign-on" },
  component: SsoPage,
});

const privacyRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/privacy",
  staticData: { title: "Privacy" },
  component: PrivacyPage,
});

const tokensRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/tokens",
  staticData: { title: "API tokens" },
  component: ApiAccessPage,
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  twoFactorRoute,
  inviteRoute,
  resetRoute,
  appRoute.addChildren([
    fleetRoute,
    presetsRoute,
    newServerRoute,
    serverRoute.addChildren([
      serverSettingsRoute,
      serverRawRoute,
      serverHistoryRoute,
      serverHooksRoute,
      serverLaunchRoute,
    ]),
    schedulesRoute,
    matrixRoute,
    reportsRoute,
    activityRoute,
    usersRoute,
    auditRoute,
    aboutRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      profileRoute,
      licenceRoute,
      planRoute,
      backupRoute,
      ssoRoute,
      privacyRoute,
      tokensRoute,
    ]),
  ]),
]);

export function createAppRouter(
  queryClient: QueryClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    ...(history === undefined ? {} : { history }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
  interface StaticDataRouteOption {
    title?: string;
  }
}
