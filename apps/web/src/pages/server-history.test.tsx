// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry, HistorySnapshot } from "../api/schema";
import { snapshotsToRestore, TimelineRow } from "./server-history";

afterEach(cleanup);

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    changeSetId: "cs-1",
    at: "2026-11-23T12:00:00Z",
    author: "owner@example.test",
    cause: "app",
    status: "applied",
    chips: [
      {
        kind: "changed",
        fileId: "settings",
        settingKey: "expRate",
        label: "Exp rate",
        from: 1,
        to: 2,
        restartRequired: true,
      },
    ],
    snapshots: [
      {
        id: "snap-1",
        fileId: "settings",
        kind: "before",
        at: "2026-11-23T12:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("TimelineRow", () => {
  it("shows the cause, author, time and the chips of a change", () => {
    render(
      <ol>
        <TimelineRow
          entry={entry()}
          last
          onRestore={() => {
            /* not used here */
          }}
          restoring={false}
        />
      </ol>,
    );
    expect(screen.getByText("Changed in Dialwarden")).toBeTruthy();
    expect(screen.getByText(/owner@example\.test/)).toBeTruthy();
    expect(screen.getByText("Exp rate: 1 → 2")).toBeTruthy();
  });

  it("marks an outside edit and a pending change", () => {
    render(
      <ol>
        <TimelineRow
          entry={entry({ cause: "external", status: "pending" })}
          last
          onRestore={() => {
            /* not used here */
          }}
          restoring={false}
        />
      </ol>,
    );
    expect(screen.getByText("Edited outside Dialwarden")).toBeTruthy();
    expect(screen.getByText("Waiting for the server to stop")).toBeTruthy();
  });

  it("offers one-click restore and names the entry when asked", () => {
    const onRestore = vi.fn();
    render(
      <ol>
        <TimelineRow
          entry={entry()}
          last
          onRestore={onRestore}
          restoring={false}
        />
      </ol>,
    );
    screen.getByRole("button", { name: "Restore this version" }).click();
    expect(onRestore).toHaveBeenCalledWith(entry());
  });

  it("says when an entry holds no stored version", () => {
    render(
      <ol>
        <TimelineRow
          entry={entry({ snapshots: [] })}
          last
          onRestore={() => {
            /* not used here */
          }}
          restoring={false}
        />
      </ol>,
    );
    expect(
      screen.getByText("No stored version to restore for this entry."),
    ).toBeTruthy();
  });
});

describe("snapshotsToRestore", () => {
  const snap = (id: string, fileId: string, kind: string): HistorySnapshot => ({
    id,
    fileId,
    kind,
    at: "2026-11-23T12:00:00Z",
  });

  it("restores the before snapshot of an applied change, never the after", () => {
    const applied = entry({
      snapshots: [
        snap("s-before", "settings", "before"),
        snap("s-after", "settings", "after"),
      ],
    });
    expect(snapshotsToRestore(applied)).toEqual([
      snap("s-before", "settings", "before"),
    ]);
  });

  it("keeps the one snapshot of a first import", () => {
    const imported = entry({
      cause: "import",
      snapshots: [snap("s-import", "settings", "after")],
    });
    expect(snapshotsToRestore(imported)).toEqual([
      snap("s-import", "settings", "after"),
    ]);
  });

  it("restores one snapshot per file of a multi-file change", () => {
    const change = entry({
      snapshots: [
        snap("a-before", "ini", "before"),
        snap("a-after", "ini", "after"),
        snap("b-before", "json", "before"),
        snap("b-after", "json", "after"),
      ],
    });
    expect(snapshotsToRestore(change)).toEqual([
      snap("a-before", "ini", "before"),
      snap("b-before", "json", "before"),
    ]);
  });
});
