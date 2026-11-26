// @vitest-environment jsdom
// The history timeline: the row, the one-click restore and, since the P8
// live check (F1, F3), who may restore what - a viewer reads, an editor
// restores plain files, a shell-read file needs an admin - and the state of
// a server address that is not in the caller's fleet.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry, HistorySnapshot, SignedIn } from "../api/schema";
import { entitlement, OWNER } from "../test/fixtures";
import {
  resetAfterEach,
  stubFetch,
  stubViewport,
  type Handler,
} from "../test/render";
import { startRouter } from "../test/start";
import {
  ADMIN_ONLY_REASON,
  restoreAccessOf,
  shellFileIds,
  snapshotsToRestore,
  TimelineRow,
} from "./server-history";

afterEach(resetAfterEach);

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
    expect(screen.getByText("Nothing to restore for this entry")).toBeTruthy();
  });

  it("shows no restore control to a reader", () => {
    render(
      <ol>
        <TimelineRow
          entry={entry()}
          last
          onRestore={() => {
            /* not used here */
          }}
          restoring={false}
          access="read-only"
        />
      </ol>,
    );
    expect(
      screen.queryByRole("button", { name: "Restore this version" }),
    ).toBeNull();
    expect(screen.getByText("Changed in Dialwarden")).toBeTruthy();
  });

  it("keeps the control off with the reason when a version needs an admin", () => {
    const onRestore = vi.fn();
    render(
      <ol>
        <TimelineRow
          entry={entry()}
          last
          onRestore={onRestore}
          restoring={false}
          access="admin-only"
        />
      </ol>,
    );
    const button = screen.getByRole("button", {
      name: "Restore this version",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe("cs-1-restore-reason");
    expect(screen.getByText(ADMIN_ONLY_REASON).id).toBe("cs-1-restore-reason");
    button.click();
    expect(onRestore).not.toHaveBeenCalled();
  });
});

describe("restoreAccessOf", () => {
  const launchEntry = entry({
    snapshots: [
      { id: "l-before", fileId: "launch", kind: "before", at: "2026-11-23" },
      { id: "l-after", fileId: "launch", kind: "after", at: "2026-11-23" },
    ],
  });
  const shell = shellFileIds([
    {
      id: "settings",
      paths: { linux: ["Settings.ini"] },
      adapter: "ini",
      encoding: "utf-8",
      applyPolicy: "anytime",
    },
    {
      id: "launch",
      paths: { linux: ["start.sh"] },
      adapter: "launch",
      encoding: "utf-8",
      applyPolicy: "stopped-only",
    },
  ]);

  it("names the shell-read files of a pack by their adapter", () => {
    expect([...shell]).toEqual(["launch"]);
  });

  it("lets a viewer, an unknown role and nobody read only", () => {
    expect(restoreAccessOf("viewer", entry(), shell)).toBe("read-only");
    expect(restoreAccessOf("guest", entry(), shell)).toBe("read-only");
    expect(restoreAccessOf(null, entry(), shell)).toBe("read-only");
  });

  it("lets an editor restore a plain file but not a shell-read one", () => {
    expect(restoreAccessOf("editor", entry(), shell)).toBe("allowed");
    expect(restoreAccessOf("editor", launchEntry, shell)).toBe("admin-only");
    // Unknown pack files (meta not loaded): the server's check answers.
    expect(restoreAccessOf("editor", launchEntry, new Set())).toBe("allowed");
  });

  it("lets the owner and an admin restore every file", () => {
    expect(restoreAccessOf("owner", launchEntry, shell)).toBe("allowed");
    expect(restoreAccessOf("admin", launchEntry, shell)).toBe("allowed");
  });

  it("reads only when the server says the grant is read, whatever the role (L22)", () => {
    expect(restoreAccessOf("editor", entry(), shell, "read")).toBe("read-only");
    expect(restoreAccessOf("editor", entry(), shell, "write")).toBe("allowed");
    expect(restoreAccessOf("owner", entry(), shell, "write")).toBe("allowed");
  });
});

const SERVER = {
  id: "home",
  name: "Home",
  packId: "testpack",
  displayName: "Test Pack",
  os: "linux",
  connector: { kind: "local", root: "/srv/home" },
  hasPassword: false,
  demo: false,
  editable: true,
  access: "write",
  createdAt: "2026-11-23T00:00:00Z",
  updatedAt: "2026-11-23T00:00:00Z",
  lastEditedAt: null,
};

const META = {
  id: "testpack",
  version: "1.0",
  displayName: "Test Pack",
  steamAppId: 1,
  os: ["linux"],
  files: [
    {
      id: "settings",
      paths: { linux: ["Settings.ini"] },
      adapter: "ini",
      encoding: "utf-8",
      applyPolicy: "anytime",
    },
    {
      id: "launch",
      paths: { linux: ["start.sh"] },
      adapter: "launch",
      encoding: "utf-8",
      applyPolicy: "stopped-only",
    },
  ],
  settings: [],
  rules: [],
  presets: [],
  hooksSupported: [],
  sources: [],
};

const HISTORY = {
  entries: [
    entry(),
    entry({
      changeSetId: "cs-2",
      at: "2026-11-22T12:00:00Z",
      chips: [
        {
          kind: "changed",
          fileId: "launch",
          settingKey: "Launch.Port",
          label: "Port",
          from: 8211,
          to: 8212,
          restartRequired: true,
        },
      ],
      snapshots: [
        {
          id: "snap-launch",
          fileId: "launch",
          kind: "before",
          at: "2026-11-22T12:00:00Z",
        },
      ],
    }),
  ],
  visibleLimit: null,
  hiddenCount: 0,
};

function session(role: string): SignedIn {
  return { ...OWNER, user: { ...OWNER.user, role } };
}

function stubWorld(who: SignedIn, extra?: Handler) {
  return stubFetch((route, init) => {
    const special = extra?.(route, init);
    if (special !== undefined) {
      return special;
    }
    const [method, path] = route;
    if (method === "GET" && path === "/api/v1/setup") {
      return { status: 200, body: { required: false } };
    }
    if (method === "GET" && path === "/api/v1/auth/session") {
      return { status: 200, body: who };
    }
    if (method === "GET" && path === "/api/v1/entitlement") {
      return { status: 200, body: entitlement({ plan: "paid" }) };
    }
    if (method === "GET" && path === "/api/v1/servers/home") {
      return { status: 200, body: SERVER };
    }
    if (method === "GET" && path === "/api/v1/servers/home/history") {
      return { status: 200, body: HISTORY };
    }
    if (method === "GET" && path === "/api/v1/servers/home/pending") {
      return { status: 200, body: { items: [] } };
    }
    if (method === "GET" && path === "/api/v1/servers/home/hooks") {
      return {
        status: 200,
        body: {
          packId: "testpack",
          hooksSupported: [],
          hook: null,
          probes: [],
          available: { save: null, stop: null, start: null, restart: null },
          updatedAt: null,
          updatedBy: null,
        },
      };
    }
    if (method === "GET" && path === "/api/v1/servers/home/status") {
      return {
        status: 200,
        body: {
          state: "unknown",
          players: null,
          source: null,
          at: "2026-11-24T18:00:00Z",
          pending: 0,
        },
      };
    }
    if (method === "GET" && path === "/api/v1/games/testpack/settings-meta") {
      return { status: 200, body: META };
    }
    return undefined;
  });
}

describe("ServerHistoryPage", () => {
  it("shows a viewer the timeline with the read-only sentence and no restore control (F1)", async () => {
    stubViewport(1280);
    const sent: string[] = [];
    stubWorld(session("viewer"), ([method, path]) => {
      if (method === "POST") {
        sent.push(path);
      }
      return undefined;
    });
    startRouter("/servers/home/history");
    await screen.findByText("Home history");
    expect(
      screen.getByText(
        /You are signed in as viewer: you read this history\. The owner, an admin or an editor with write access restores a version\./,
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Changed in Dialwarden").length).toBe(2);
    expect(
      screen.queryByRole("button", { name: "Restore this version" }),
    ).toBeNull();
    expect(sent).toEqual([]);
  });

  it("gives an editor the restore of a plain file and keeps the launch file for an admin (F1)", async () => {
    stubViewport(1280);
    stubWorld(session("editor"));
    startRouter("/servers/home/history");
    await screen.findByText("Home history");
    expect(screen.queryByText(/You are signed in as/)).toBeNull();
    // The launch row is known once the pack meta answered.
    await screen.findByText(ADMIN_ONLY_REASON);
    const buttons = screen.getAllByRole("button", {
      name: "Restore this version",
    }) as HTMLButtonElement[];
    expect(buttons.map((button) => button.disabled)).toEqual([false, true]);
  });

  it("shows an editor with a read grant no restore control and names the grant (L22)", async () => {
    stubViewport(1280);
    stubWorld(session("editor"), ([method, path]) => {
      if (method === "GET" && path === "/api/v1/servers/home") {
        return { status: 200, body: { ...SERVER, access: "read" } };
      }
      return undefined;
    });
    startRouter("/servers/home/history");
    await screen.findByText("Home history");
    expect(
      screen.getByText(
        /You are signed in as editor with read access to this server: you read this history\. A write grant from the owner or an admin restores a version\./,
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Changed in Dialwarden").length).toBe(2);
    expect(
      screen.queryByRole("button", { name: "Restore this version" }),
    ).toBeNull();
  });

  it("lets the owner restore every version", async () => {
    stubViewport(1280);
    stubWorld(OWNER);
    startRouter("/servers/home/history");
    await screen.findByText("Home history");
    const buttons = (await screen.findAllByRole("button", {
      name: "Restore this version",
    })) as HTMLButtonElement[];
    expect(buttons.map((button) => button.disabled)).toEqual([false, false]);
    expect(screen.queryByText(ADMIN_ONLY_REASON)).toBeNull();
  });

  it("shows the not-in-your-fleet state for a 404 server, without Retry (F3)", async () => {
    stubViewport(1280);
    const missing = { status: 404, body: { error: "server_not_found" } };
    stubWorld(session("editor"), ([method, path]) => {
      if (method === "GET" && path === "/api/v1/servers/other") {
        return missing;
      }
      if (method === "GET" && path === "/api/v1/servers/other/history") {
        return missing;
      }
      return undefined;
    });
    startRouter("/servers/other/history");
    await screen.findByText("This server is not in your fleet");
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Go to the fleet" })
        .getAttribute("href"),
    ).toBe("/");
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
      snapshots: [snap("s-import", "settings", "import")],
    });
    expect(snapshotsToRestore(imported)).toEqual([
      snap("s-import", "settings", "import"),
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
