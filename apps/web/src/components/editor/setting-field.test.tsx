// @vitest-environment jsdom
// The editor fields (screen 3) and the 400-setting performance smoke of
// dev-work-plan P5: the controls that fit each type, the badges, the inline
// validation, the secret masking, and the group accordion staying responsive.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { Setting } from "@dialwarden/packs-schema";
import { GroupSection } from "../../pages/server-settings";
import { SettingField } from "./setting-field";

afterEach(cleanup);

const LOCATOR = { kind: "ini", section: null, key: "k" } as const;

function setting(overrides: Partial<Setting> = {}): Setting {
  return {
    key: "expRate",
    label: "Exp rate",
    file: "settings",
    locator: LOCATOR,
    type: "float",
    description: "How fast the experience grows.",
    ...overrides,
  };
}

describe("SettingField", () => {
  it("renders a number field with the unit and the validation message", () => {
    render(
      <SettingField
        setting={setting({ unit: "×", min: 0, max: 5, step: 0.5 })}
        value={9}
        edited
        issue="Must be at most 5 ×."
        disabled={false}
        onChange={() => {
          /* not used here */
        }}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    const input = screen.getByLabelText("Exp rate") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.value).toBe("9");
    expect(screen.getByText(/Unit: ×\./)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Must be at most 5 ×.",
    );
  });

  // phase-report-07 F-P7-2: a warning is told in the warning colour as a
  // status; the control stays valid. An error keeps the alert.
  it("renders a warning-severity issue as a status in the warning style", () => {
    render(
      <SettingField
        setting={setting({ removedIn: "3.0" })}
        value={2}
        edited={false}
        issue="Gone in 3.0: the game ignores it."
        severity="warning"
        disabled={false}
        onChange={() => {
          /* not used here */
        }}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    const note = screen.getByText("Gone in 3.0: the game ignores it.");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.className).toContain("text-warning");
    expect(screen.queryByRole("alert")).toBeNull();
    const input = screen.getByLabelText("Exp rate") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe(
      "setting-expRate-warning setting-expRate-help",
    );
  });

  // P10-B2 review L2: the masked list field (adminlist and the like) tells a
  // warning the same way as every other field, and keeps the alert for an
  // error.
  it("renders a warning on a secret list setting in the warning style", () => {
    render(
      <SettingField
        setting={setting({
          key: "adminlist",
          label: "Admins",
          type: "list",
          secret: true,
        })}
        value="********"
        edited={false}
        issue="Gone in 3.0: the game ignores it."
        severity="warning"
        disabled={false}
        onChange={() => {
          /* not used here */
        }}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    const note = screen.getByText("Gone in 3.0: the game ignores it.");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.className).toContain("text-warning");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Replace the list" }));
    const box = screen.getByLabelText("Admins") as HTMLTextAreaElement;
    expect(box.getAttribute("aria-invalid")).toBeNull();
    expect(box.getAttribute("aria-describedby")).toContain(note.id);
  });

  it("keeps the alert for an error on a secret list setting", () => {
    render(
      <SettingField
        setting={setting({
          key: "adminlist",
          label: "Admins",
          type: "list",
          secret: true,
        })}
        value={["1"]}
        edited={true}
        issue="One id is too short."
        disabled={false}
        onChange={() => {
          /* not used here */
        }}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    const note = screen.getByRole("alert");
    expect(note.textContent).toContain("One id is too short.");
    expect(note.className).toContain("text-error");
    expect(screen.queryByRole("status")).toBeNull();
    const box = screen.getByLabelText("Admins") as HTMLTextAreaElement;
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toContain(note.id);
  });

  it("lets a screen word a secret field's help in its own way", () => {
    render(
      <SettingField
        setting={setting({
          key: "adminPassword",
          label: "Admin password",
          type: "string",
          secret: true,
        })}
        value=""
        edited={false}
        issue={undefined}
        secretHelp="Type the secret this run writes."
        disabled={false}
        onChange={() => {
          /* not used here */
        }}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    expect(screen.getByText("Type the secret this run writes.")).toBeTruthy();
    expect(screen.queryByText(/Leave empty to keep/)).toBeNull();
  });

  it("shows the edited marker and Reset hands the key back", () => {
    const onReset = vi.fn();
    render(
      <SettingField
        setting={setting({ default: 1 })}
        value={2}
        edited
        issue={undefined}
        disabled={false}
        onChange={() => {
          /* not used here */
        }}
        onReset={onReset}
      />,
    );
    expect(screen.getByText("Edited")).toBeTruthy();
    screen.getByRole("button", { name: "Reset" }).click();
    expect(onReset).toHaveBeenCalledWith("expRate");
  });

  it("masks a secret and keeps the stored value unless typed", () => {
    const onChange = vi.fn();
    render(
      <SettingField
        setting={setting({
          key: "adminPassword",
          label: "Admin password",
          type: "string",
          secret: true,
          default: null,
        })}
        value="••••••"
        edited={false}
        issue={undefined}
        disabled={false}
        onChange={onChange}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    const input = screen.getByLabelText("Admin password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(screen.getByText("Secret")).toBeTruthy();
    expect(
      screen.getByText(/Leave empty to keep the stored value/),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "new-secret" } });
    expect(onChange).toHaveBeenCalledWith("adminPassword", "new-secret");
  });

  // Typing into a secret and clearing it again must not queue an empty
  // string: the server would write it over the stored secret (the code
  // review finding M6 of THE-2526).
  it("hands a cleared secret back instead of saving an empty string", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <SettingField
        setting={setting({
          key: "adminPassword",
          label: "Admin password",
          type: "string",
          secret: true,
          default: null,
        })}
        value="n"
        edited
        issue={undefined}
        disabled={false}
        onChange={onChange}
        onReset={onReset}
      />,
    );
    const input = screen.getByLabelText("Admin password") as HTMLInputElement;
    expect(input.value).toBe("n");
    fireEvent.change(input, { target: { value: "" } });
    expect(onReset).toHaveBeenCalledWith("adminPassword");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables a panel-managed setting and keeps it visible", () => {
    render(
      <SettingField
        setting={setting({ panelManaged: true })}
        value={2}
        edited={false}
        issue={undefined}
        disabled={false}
        onChange={() => {
          /* not used here */
        }}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    const input = screen.getByLabelText("Exp rate") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText("Panel-managed")).toBeTruthy();
  });

  it("carries the restart badge and the gone-in warning", () => {
    render(
      <SettingField
        setting={setting({ restartRequired: true, removedIn: "28.0.0" })}
        value={2}
        edited={false}
        issue={undefined}
        disabled={false}
        onChange={() => {
          /* not used here */
        }}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    expect(screen.getByText("Restart")).toBeTruthy();
    expect(screen.getByText("Gone in 28.0.0")).toBeTruthy();
  });
});

describe("GroupSection", () => {
  const group = {
    name: "Rates",
    settings: [setting(), setting({ key: "palCapture", label: "Pal capture" })],
  };

  it("collapses and expands on phones and shows every field open on desktop", () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <GroupSection
        group={group}
        values={{ expRate: 1, palCapture: 1 }}
        draft={{}}
        issues={new Map()}
        disabled={false}
        phone
        onChange={onChange}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    expect(screen.queryByLabelText("Exp rate")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Rates/ }));
    expect(screen.getByLabelText("Exp rate")).toBeTruthy();
    unmount();

    render(
      <GroupSection
        group={group}
        values={{ expRate: 1, palCapture: 1 }}
        draft={{}}
        issues={new Map()}
        disabled={false}
        phone={false}
        onChange={onChange}
        onReset={() => {
          /* not used here */
        }}
      />,
    );
    expect(screen.getByLabelText("Exp rate")).toBeTruthy();
    expect(screen.getByText("2 settings")).toBeTruthy();
  });

  // The first render of 400 fields in jsdom is slow and not what is measured;
  // the keystroke is. The field is memoised, so one keystroke re-renders one
  // field, and the lookup goes by id because getByLabelText walks every label.
  it("stays responsive with 400 settings (the P10 target is 200 ms)", () => {
    const many: Setting[] = Array.from({ length: 400 }, (_, index) =>
      setting({
        key: `rate${index}`,
        label: `Rate ${index}`,
        type: "int",
        min: 0,
        max: 100,
      }),
    );
    const values: Record<string, unknown> = {};
    for (const item of many) {
      values[item.key] = 1;
    }
    // The harness holds the draft the way the page does, so the keystroke
    // re-renders all 400 fields like it does in the real editor.
    function Harness() {
      const [draft, setDraft] = useState<Record<string, unknown>>({});
      return (
        <GroupSection
          group={{ name: "Big", settings: many }}
          values={values}
          draft={draft}
          issues={new Map()}
          disabled={false}
          phone={false}
          onChange={(key, value) => {
            setDraft((current) => ({ ...current, [key]: value }));
          }}
          onReset={() => {
            /* not used here */
          }}
        />
      );
    }
    const { container } = render(<Harness />);
    const input = container.querySelector("#setting-rate217");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("the field of rate217 is missing");
    }
    fireEvent.change(input, { target: { value: "4" } });
    const start = performance.now();
    fireEvent.change(input, { target: { value: "42" } });
    const took = performance.now() - start;
    expect(input.value).toBe("42");
    expect(took).toBeLessThan(200);
  }, 120_000);
});
