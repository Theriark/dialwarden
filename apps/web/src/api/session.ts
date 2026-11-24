// Session helpers shared by the sign-in, setup and shell code.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, setCsrf } from "./client";
import { keys, sessionQuery } from "./queries";
import type { SignedIn, User } from "./schema";

/** Remembers a fresh sign-in or setup answer as the current session. */
export function rememberSession(client: QueryClient, session: SignedIn): void {
  setCsrf(session.csrfToken);
  client.setQueryData(keys.session, session);
  void client.invalidateQueries({ queryKey: keys.entitlement });
}

export async function signOut(client: QueryClient): Promise<void> {
  try {
    await api<undefined>("/api/v1/auth/logout", { method: "POST" });
  } catch {
    // The cookie may already be gone; the local state is cleared anyway.
  } finally {
    setCsrf(null);
    client.setQueryData(keys.session, null);
    client.removeQueries({ queryKey: keys.entitlement });
    client.removeQueries({ queryKey: keys.status });
    client.removeQueries({ queryKey: keys.backups });
  }
}

/** True for the answer that says the server session ended. */
export function isSessionEnded(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    error.code === "unauthenticated"
  );
}

/**
 * Drops the local session once the server says it ended. The query client
 * calls this for every query and mutation (app.tsx); the shell then sends the
 * user to sign-in again with the current page as the redirect.
 */
export function forgetSession(client: QueryClient): void {
  setCsrf(null);
  client.setQueryData(keys.session, null);
}

/** The signed-in user, or null outside a session. */
export function useSessionUser(): User | null {
  const { data } = useQuery(sessionQuery());
  return data?.user ?? null;
}

export function useIsOwner(): boolean {
  const user = useSessionUser();
  return user?.role === "owner";
}

/** The roles that may set or change a server's hooks (routes/hooks.ts). */
export const HOOK_CONFIG_ROLES: readonly string[] = ["owner", "admin"];

/** The roles that may run a hook action; a viewer only looks. */
export const HOOK_RUN_ROLES: readonly string[] = ["owner", "admin", "editor"];

export function useCanConfigureHooks(): boolean {
  const user = useSessionUser();
  return user !== null && HOOK_CONFIG_ROLES.includes(user.role);
}

export function useCanRunHooks(): boolean {
  const user = useSessionUser();
  return user !== null && HOOK_RUN_ROLES.includes(user.role);
}

/**
 * The second sign-in step challenge, kept in memory only (never in the URL).
 * Reading never clears it, because the page reads it in a state initialiser
 * that StrictMode calls twice; the page clears it when the step ends, expires
 * or is restarted.
 */
let pendingChallenge: string | null = null;

export function setPendingChallenge(value: string | null): void {
  pendingChallenge = value;
}

export function readPendingChallenge(): string | null {
  return pendingChallenge;
}

/**
 * A redirect target after sign-in: a same-origin path only, so the search
 * parameter can never send the browser somewhere else. The browser's own URL
 * parser decides, so characters it drops (tabs, newlines) or treats as a
 * separator (a backslash) cannot turn a path into another origin.
 */
export function safeRedirect(target: string | undefined): string {
  if (target === undefined || !target.startsWith("/")) {
    return "/";
  }
  const origin = window.location.origin;
  let url: URL;
  try {
    url = new URL(target, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin) {
    return "/";
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
