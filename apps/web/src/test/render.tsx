// Test helpers: a page inside the same providers the app uses, with a fresh
// QueryClient per test and a stubbed fetch that answers by path.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { setCsrf } from "../api/client";
import { keys } from "../api/queries";
import type { SignedIn } from "../api/schema";
import { ToastProvider } from "../components/ui/toast";
import { TooltipProvider } from "../components/ui/tooltip";
import { ThemeProvider } from "../theme/theme-provider";

export const OWNER: SignedIn = {
  status: "ok",
  csrfToken: "csrf-test",
  user: {
    id: "u1",
    email: "owner@example.test",
    name: "Owner Person",
    role: "owner",
    totpEnabled: false,
  },
};

// gcTime stays Infinity: with 0, the session seeded by withSession has no
// observer yet and is collected before a component that mounts later (after
// another query resolves) reads it, so the page sees nobody signed in.
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

export function withSession(client: QueryClient, session = OWNER): void {
  setCsrf(session.csrfToken);
  client.setQueryData(keys.session, session);
}

export function renderWithProviders(
  ui: ReactNode,
  client = testQueryClient(),
): RenderResult & { client: QueryClient } {
  const result = render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>{ui}</ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

export type Route = [method: string, path: string];
export type Answer = { status: number; body?: unknown };
export type Handler = (route: Route, init: RequestInit) => Answer | undefined;

/** Stubs fetch with a handler; unknown paths answer 404. */
export function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const answer = handler([method, path], init ?? {}) ?? {
      status: 404,
      body: { error: "not_found" },
    };
    const text = answer.body === undefined ? "" : JSON.stringify(answer.body);
    return new Response(text === "" ? null : text, {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
