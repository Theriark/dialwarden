// Session helpers shared by the sign-in, setup and shell code.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, setCsrf } from "./client";
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

/** The signed-in user, or null outside a session. */
export function useSessionUser(): User | null {
  const { data } = useQuery(sessionQuery());
  return data?.user ?? null;
}

export function useIsOwner(): boolean {
  const user = useSessionUser();
  return user?.role === "owner";
}

/** The second sign-in step challenge, kept in memory only (never in the URL). */
let pendingChallenge: string | null = null;

export function setPendingChallenge(value: string | null): void {
  pendingChallenge = value;
}

export function takePendingChallenge(): string | null {
  return pendingChallenge;
}

/**
 * A redirect target after sign-in: same-origin paths only, so the search
 * parameter can never send the browser somewhere else.
 */
export function safeRedirect(target: string | undefined): string {
  if (target === undefined || !target.startsWith("/")) {
    return "/";
  }
  if (target.startsWith("//") || target.startsWith("/\\")) {
    return "/";
  }
  return target;
}
