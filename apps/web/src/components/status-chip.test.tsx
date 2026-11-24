// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import type { ServerStatus } from "../api/schema";
import { StatusChip, statusWord, unknownReason } from "./status-chip";

afterEach(cleanup);

function status(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    state: "running",
    players: 3,
    source: "a2s",
    at: "2026-11-24T18:00:00Z",
    pending: 0,
    ...overrides,
  };
}

describe("StatusChip", () => {
  it("says running with the player count", () => {
    render(<StatusChip status={status()} />);
    expect(screen.getByText("Running · 3 players")).toBeTruthy();
    expect(statusWord(status({ players: 1 }))).toBe("Running · 1 player");
    expect(statusWord(status({ players: null }))).toBe("Running");
  });

  it("says stopped", () => {
    render(<StatusChip status={status({ state: "stopped", players: null })} />);
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("explains an unknown state in the title, never as an error", () => {
    const { container } = render(
      <StatusChip
        status={status({ state: "unknown", players: null, source: null })}
      />,
    );
    expect(screen.getByText("Unknown")).toBeTruthy();
    const titled = container.querySelector("[title]");
    expect(titled?.getAttribute("title")).toContain("No probe is configured");
    expect(
      unknownReason(status({ state: "unknown", source: "dockerProxy" })),
    ).toBe("The dockerProxy probe did not answer.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a busy placeholder while the probe runs", () => {
    const { container } = render(<StatusChip loading />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByText("Unknown")).toBeNull();
  });

  it("shows unknown with the failure in the title when the route failed", () => {
    const { container } = render(
      <StatusChip error={new ApiError(502, { error: "control_error" })} />,
    );
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain(
      "could not be checked",
    );
  });

  it("adds the simulated badge for a demo server", () => {
    render(<StatusChip status={status()} simulated />);
    expect(screen.getByText("Simulated")).toBeTruthy();
    expect(screen.getByText("Running · 3 players")).toBeTruthy();
  });
});
