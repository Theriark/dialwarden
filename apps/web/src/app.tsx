// Providers around the router: TanStack Query, the theme, tooltips, toasts.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "./api/client";
import { ToastProvider } from "./components/ui/toast";
import { TooltipProvider } from "./components/ui/tooltip";
import { createAppRouter } from "./router";
import { ThemeProvider } from "./theme/theme-provider";

export function createQueryClient(): QueryClient {
  return new QueryClient({
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
      },
    },
  });
}

export function App() {
  const [queryClient] = useState(createQueryClient);
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
