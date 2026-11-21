// Providers around the router: TanStack Query, the theme, tooltips, toasts.
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  type DefaultOptions,
} from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "./api/client";
import { forgetSession, isSessionEnded } from "./api/session";
import { ToastProvider } from "./components/ui/toast";
import { TooltipProvider } from "./components/ui/tooltip";
import { createAppRouter } from "./router";
import { ThemeProvider } from "./theme/theme-provider";

/**
 * The query client of the app. Whenever a query or a mutation answers that the
 * server session ended, the local session is dropped and the shell sends the
 * user to sign in again. The session query itself treats 401 as signed out,
 * so it never reaches these handlers.
 */
export function createQueryClient(
  queries: DefaultOptions["queries"] = {},
): QueryClient {
  const ended = (error: unknown) => {
    if (isSessionEnded(error)) {
      forgetSession(client);
    }
  };
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: ended }),
    mutationCache: new MutationCache({ onError: ended }),
    defaultOptions: {
      queries: {
        // A 4xx answer does not change on retry; a network blip may.
        retry: (count, error) => {
          if (error instanceof ApiError && error.status >= 400) {
            return error.status >= 500 && count < 2;
          }
          return count < 2;
        },
        refetchOnWindowFocus: false,
        ...queries,
      },
    },
  });
  return client;
}

export function App() {
  const [queryClient] = useState(() => createQueryClient());
  const [router] = useState(() => createAppRouter(queryClient));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
