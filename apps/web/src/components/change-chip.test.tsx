// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Chip } from "../api/schema";
import { ChangeChip, chipText, formatChipValue } from "./change-chip";

afterEach(cleanup);

function chip(overrides: Partial<Chip> = {}): Chip {
  return {
    kind: "changed",
    fileId: "ini",
    settingKey: "expRate",
    label: "Exp rate",
    from: 1.0,
    to: 2.0,
    restartRequired: false,
    ...overrides,
  };
}

describe("ChangeChip", () => {
  it("shows the label and both values of a change", () => {
    render(
      <ul>
        <ChangeChip chip={chip()} />
      </ul>,
    );
    expect(screen.getByText("Exp rate: 1 → 2")).toBeTruthy();
  });

  it("marks a change that needs a restart for screen readers and by icon", () => {
    render(
      <ul>
        <ChangeChip chip={chip({ restartRequired: true })} />
      </ul>,
    );
    expect(screen.getByText("Restart required")).toBeTruthy();
  });

  it("says only the new value of an added setting", () => {
    const text = chipText(chip({ kind: "added", from: null, to: 3 }));
    expect(text).toBe("Exp rate: set to 3");
  });

  it("says the old value of a removed setting", () => {
    const text = chipText(chip({ kind: "removed", to: null, from: 3 }));
    expect(text).toBe("Exp rate: removed (was 3)");
  });

  it("keeps a masked secret value hidden", () => {
    const text = chipText(
      chip({ kind: "masked", from: "•••••", to: "••••••" }),
    );
    expect(text).toBe("Exp rate: ••••• → ••••••");
  });

  it("names a file the server saw edited outside Dialwarden", () => {
    render(
      <ul>
        <ChangeChip
          chip={chip({
            kind: "external",
            settingKey: null,
            label: "PalWorldSettings.ini",
            from: null,
            to: "4 lines changed",
          })}
        />
      </ul>,
    );
    expect(
      screen.getByText(
        "PalWorldSettings.ini 4 lines changed (edited outside Dialwarden)",
      ),
    ).toBeTruthy();
  });

  it("counts the lines of an import", () => {
    const text = chipText(
      chip({ kind: "import", settingKey: null, label: "ini", to: "41 lines" }),
    );
    expect(text).toBe("ini 41 lines (imported)");
  });

  it("truncates long values but keeps them in the title", () => {
    const long = "x".repeat(80);
    render(
      <ul>
        <ChangeChip chip={chip({ from: long, to: 1 })} />
      </ul>,
    );
    const item = screen.getByTitle(/x{3}/);
    expect(item.getAttribute("title")).toContain(long);
    expect(item.textContent).toContain(long);
  });
});

describe("formatChipValue", () => {
  it("words booleans and null", () => {
    expect(formatChipValue(true)).toBe("on");
    expect(formatChipValue(false)).toBe("off");
    expect(formatChipValue(null)).toBe("not set");
    expect(formatChipValue(undefined)).toBe("not set");
  });

  it("keeps numbers and strings readable", () => {
    expect(formatChipValue(2.5)).toBe("2.5");
    expect(formatChipValue("Hard")).toBe("Hard");
    expect(formatChipValue("")).toBe('""');
  });
});
