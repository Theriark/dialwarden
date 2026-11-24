// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Setting } from "@dialwarden/packs-schema";
import { AccessListField, maskId, splitIds } from "./access-list-field";

afterEach(cleanup);

const SETTING: Setting = {
  key: "adminlist",
  label: "Admins",
  file: "adminlist",
  locator: { kind: "textlist" } as Setting["locator"],
  type: "list",
  secret: true,
  description: "Steam ids of the players who may administer the server.",
};

const ID_A = "76561198000000001";
const ID_B = "76561198000000002";

describe("AccessListField", () => {
  it("shows that a list is stored and offers to replace it", () => {
    const onChange = vi.fn();
    render(
      <AccessListField
        setting={SETTING}
        value="********"
        edited={false}
        issue={undefined}
        disabled={false}
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );
    expect(
      screen.getByText("A list is stored; its ids stay hidden."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace the list" }));
    expect(screen.getByText("Add the first id")).toBeTruthy();
    const box = screen.getByLabelText("Admins");
    expect(box.tagName).toBe("TEXTAREA");
    fireEvent.change(box, { target: { value: `${ID_A}\n${ID_B}` } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onChange).toHaveBeenCalledWith("adminlist", [ID_A, ID_B]);
  });

  it("masks the rows until Show, removes one and keeps the stored list", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <AccessListField
        setting={SETTING}
        value={[ID_A, ID_B]}
        edited
        issue={undefined}
        disabled={false}
        onChange={onChange}
        onReset={onReset}
      />,
    );
    expect(screen.getByText("2 ids in the new list")).toBeTruthy();
    expect(screen.getByText(maskId(ID_A))).toBeTruthy();
    expect(screen.queryByText(ID_A)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show ids" }));
    expect(screen.getByText(ID_A)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove id 1" }));
    expect(onChange).toHaveBeenCalledWith("adminlist", [ID_B]);
    fireEvent.click(
      screen.getByRole("button", { name: "Keep the stored list" }),
    );
    expect(onReset).toHaveBeenCalledWith("adminlist");
  });

  it("splits pasted ids and masks all but the last four characters", () => {
    expect(splitIds(` ${ID_A}, ${ID_B}\n\n`)).toEqual([ID_A, ID_B]);
    expect(maskId(ID_A)).toBe("•••••••••••••0001");
    expect(maskId("ab")).toBe("••••ab");
  });
});
