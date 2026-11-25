// @vitest-environment jsdom
// The reveal-once dialog (API tokens, invitation and reset links): the
// value is shown with one copy action, Done stays off until the person
// confirms the copy, a click outside never closes it before that, and the
// value is gone once it closes.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, resetAfterEach } from "../test/render";
import { RevealOnce } from "./reveal-once";

afterEach(resetAfterEach);

const REVEALED = {
  title: "Your new API token",
  description: "Backup script, acting as viewer.",
  label: "API token",
  value: "dw_example_value_shown_once",
  note: "Send it as a bearer value.",
};

describe("RevealOnce", () => {
  it("shows the value once with a copy action and Done after the confirmation", async () => {
    const onDone = vi.fn();
    // userEvent.setup() installs a clipboard of its own, read back below.
    const user = userEvent.setup();
    renderWithProviders(<RevealOnce revealed={REVEALED} onDone={onDone} />);
    const dialog = await screen.findByRole("dialog", {
      name: "Your new API token",
    });
    expect(dialog).toBeDefined();
    expect(screen.getByLabelText("API token").textContent).toBe(REVEALED.value);
    expect(screen.getByText("Send it as a bearer value.")).toBeDefined();
    expect(screen.getByText(/only time it is shown/)).toBeDefined();
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(await navigator.clipboard.readText()).toBe(REVEALED.value);

    // Escape before the confirmation leaves the dialog open.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onDone).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("checkbox", { name: "I have copied it" }),
    );
    expect(done).toHaveProperty("disabled", false);
    await user.click(done);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("renders nothing while there is no value", () => {
    renderWithProviders(
      <RevealOnce revealed={null} onDone={() => undefined} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
