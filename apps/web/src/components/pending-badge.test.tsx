// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { PendingBadge, pendingWord } from "./pending-badge";

afterEach(cleanup);

describe("PendingBadge", () => {
  it("renders nothing for zero", () => {
    const { container } = render(<PendingBadge count={0} />);
    expect(container.textContent).toBe("");
  });

  it("counts the pending changes in words", () => {
    render(<PendingBadge count={1} />);
    expect(screen.getByText("1 pending change")).toBeTruthy();
    expect(pendingWord(3)).toBe("3 pending changes");
  });

  it("links to the server's history when it knows the slug", async () => {
    const rootRoute = createRootRoute({
      component: () => <PendingBadge count={2} slug="home" />,
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
    const link = (await screen.findByRole("link", {
      name: "2 pending changes",
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/servers/home/history");
    expect(link.getAttribute("title")).toContain("stopped next");
  });
});
