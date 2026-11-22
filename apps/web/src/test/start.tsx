// The whole app on a memory history, for tests that cross routes (setup,
// sign-in, the second step, the shell).
import type { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { createAppRouter, type AppRouter } from "../router";
import { renderWithProviders, testQueryClient } from "./render";

export function startRouter(
  path: string,
  client: QueryClient = testQueryClient(),
): { router: AppRouter; client: QueryClient } {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(client, history);
  renderWithProviders(<RouterProvider router={router} />, client);
  return { router, client };
}
