// Test helpers: a page inside the same providers the app uses, with a fresh
// QueryClient per test, a stubbed fetch that answers by path, a viewport stub
// for the three widths, and one reset for everything a test may leave behind.
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { setCsrf } from "../api/client";
import { keys } from "../api/queries";
import { setPendingChallenge } from "../api/session";
import { createQueryClient } from "../app";
import { ToastProvider } from "../components/ui/toast";
import { TooltipProvider } from "../components/ui/tooltip";
import { DARK_QUERY } from "../theme/theme";
import { ThemeProvider } from "../theme/theme-provider";
import { OWNER } from "./fixtures";

export { OWNER };

// jsdom lacks what the router (scroll restoration), the Radix popovers
// (ResizeObserver through floating-ui) and the menus (scrollIntoView) call.
if (typeof window !== "undefined") {
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  if (typeof window.ResizeObserver !== "function") {
    class QuietResizeObserver {
      observe(): void {
        return undefined;
      }
      unobserve(): void {
        return undefined;
      }
      disconnect(): void {
        return undefined;
      }
    }
    window.ResizeObserver =
      QuietResizeObserver as unknown as typeof ResizeObserver;
  }
}

/**
 * The app's own client (same error handling), without retries and with an
 * endless gcTime: with 0, the session seeded by withSession has no observer
 * yet and is collected before a component that mounts later (after another
 * query resolves) reads it, so the page sees nobody signed in.
 */
export function testQueryClient(): QueryClient {
  return createQueryClient({ retry: false, gcTime: Infinity });
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
export type Answer = { status: number; body?: unknown; headers?: HeadersInit };
export type Handler = (
  route: Route,
  init: RequestInit,
) => Answer | Promise<Answer> | undefined;

/** Stubs fetch with a handler; unknown paths answer 404. */
export function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const answer = (await handler([method, path], init ?? {})) ?? {
      status: 404,
      body: { error: "not_found" },
    };
    const text = answer.body === undefined ? "" : JSON.stringify(answer.body);
    const headers = new Headers(answer.headers ?? {});
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new Response(text === "" ? null : text, {
      status: answer.status,
      headers,
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The JSON body a stubbed fetch received. */
export function bodyOf(init: RequestInit): unknown {
  return typeof init.body === "string" ? JSON.parse(init.body) : null;
}

export function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

/** A promise a test settles by hand, to hold an answer while pending. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mediaList(query: string, matches: boolean): MediaQueryList {
  const noop = () => undefined;
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  };
}

/**
 * Pretends the window is this wide (the shell asks for min-width 640 and
 * 1024) and whether the operating system prefers dark. Without this stub
 * jsdom has no matchMedia and the shell renders its phone layout.
 */
export function stubViewport(width: number, dark = false): void {
  const matches = (query: string): boolean => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    if (min !== null) {
      return width >= Number(min[1] ?? "0");
    }
    return query === DARK_QUERY ? dark : false;
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => mediaList(query, matches(query)),
  });
}

/** Everything a test may leave behind, for one afterEach per file. */
export function resetAfterEach(): void {
  cleanup();
  vi.unstubAllGlobals();
  setCsrf(null);
  setPendingChallenge(null);
  Reflect.deleteProperty(window, "matchMedia");
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
}

/** The card (section) whose heading reads title, for queries within it. */
export function cardOf(container: HTMLElement, title: string): HTMLElement {
  const headings = Array.from(container.querySelectorAll("h2"));
  const heading = headings.find((h) => h.textContent === title);
  const card = heading?.closest("section");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`no card titled ${title}`);
  }
  return card;
}
