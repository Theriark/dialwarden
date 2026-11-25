// @vitest-environment jsdom
// The grant editor: one radio group per server with none, read and write,
// the write choice blocked for a viewer, and the grants it hands back.
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Grant } from "../api/schema";
import { renderWithProviders, resetAfterEach } from "../test/render";
import {
  describeGrants,
  GrantEditor,
  grantLevelOf,
  withGrant,
} from "./grant-editor";

afterEach(resetAfterEach);

const SERVERS = [
  { id: "home", name: "Home", displayName: "Valheim" },
  { id: "pal", name: "Palworld Home", displayName: "Palworld" },
];

describe("GrantEditor", () => {
  it("computes levels, replacements and the summary", () => {
    const grants: Grant[] = [{ server: "home", level: "write" }];
    expect(grantLevelOf(grants, "home")).toBe("write");
    expect(grantLevelOf(grants, "pal")).toBe("none");
    expect(withGrant(grants, "pal", "read")).toEqual([
      { server: "home", level: "write" },
      { server: "pal", level: "read" },
    ]);
    expect(withGrant(grants, "home", "none")).toEqual([]);
    expect(describeGrants([])).toBe("No server");
    expect(describeGrants([{ server: "home", level: "read" }])).toBe(
      "1 server, read only",
    );
    expect(describeGrants(grants)).toBe("1 server, 1 for writing");
  });

  it("renders a radio group per server and reports a choice", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <GrantEditor
        servers={SERVERS}
        value={[{ server: "home", level: "read" }]}
        onChange={onChange}
        role="editor"
      />,
    );
    const groups = screen.getAllByRole("radiogroup");
    expect(groups.length).toBe(2);
    const home = screen.getByRole("radiogroup", { name: "Home" });
    expect(within(home).getByRole("radio", { name: "Read" })).toHaveProperty(
      "checked",
      true,
    );
    fireEvent.click(within(home).getByRole("radio", { name: "Write" }));
    expect(onChange).toHaveBeenCalledWith([{ server: "home", level: "write" }]);
    expect(screen.getByText("1 server, read only.")).toBeDefined();
  });

  it("blocks the write choice for a viewer and explains why", () => {
    renderWithProviders(
      <GrantEditor
        servers={SERVERS}
        value={[]}
        onChange={() => undefined}
        role="viewer"
      />,
    );
    const pal = screen.getByRole("radiogroup", { name: "Palworld Home" });
    const write = within(pal).getByRole("radio", { name: "Write" });
    expect(write).toHaveProperty("disabled", true);
    expect(within(pal).getByRole("radio", { name: "Read" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(
      screen.getByText(/A viewer reads the servers chosen here/),
    ).toBeDefined();
  });

  it("asks for a server first when the fleet is empty", () => {
    renderWithProviders(
      <GrantEditor
        servers={[]}
        value={[]}
        onChange={() => undefined}
        role="editor"
      />,
    );
    expect(screen.getByText(/No servers yet/)).toBeDefined();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
