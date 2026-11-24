// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaunchSnippetPanel } from "./launch-snippets";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LaunchSnippetPanel", () => {
  it("offers the four snippets and starts on bash", () => {
    render(
      <LaunchSnippetPanel
        fileName="dialwarden-args.txt"
        executable="./valheim_server.x86_64"
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Bash",
      "PowerShell",
      "Docker Compose",
      "systemd",
    ]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Bash snippet").textContent).toBe(
      'set -f; eval "exec ./valheim_server.x86_64 $(cat dialwarden-args.txt)"',
    );
  });

  it("moves between snippets with the arrow keys and shows the $$ forms", () => {
    render(
      <LaunchSnippetPanel
        fileName="dialwarden-args.txt"
        executable="./valheim_server.x86_64"
      />,
    );
    const list = screen.getByRole("tablist", { name: "Snippet language" });
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("tab", { name: "PowerShell" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByLabelText("PowerShell snippet").textContent).toContain(
      "Get-Content dialwarden-args.txt -Raw",
    );
    fireEvent.keyDown(list, { key: "End" });
    expect(screen.getByLabelText("systemd snippet").textContent).toContain(
      "ExecStart=/bin/sh -c 'set -f; eval \"exec ./valheim_server.x86_64 $$(cat dialwarden-args.txt)\"'",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Docker Compose" }));
    expect(
      screen.getByLabelText("Docker Compose snippet").textContent,
    ).toContain("command: sh -c '");
  });

  it("starts on PowerShell for a Windows server", () => {
    render(
      <LaunchSnippetPanel
        fileName="dialwarden-args.txt"
        executable=".\\valheim_server.exe"
        os="windows"
      />,
    );
    expect(
      screen
        .getByRole("tab", { name: "PowerShell" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("copies the shown snippet", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <LaunchSnippetPanel
        fileName="dialwarden-args.txt"
        executable="./valheim_server.x86_64"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'set -f; eval "exec ./valheim_server.x86_64 $(cat dialwarden-args.txt)"',
      );
    });
    await screen.findByRole("button", { name: "Copied" });
  });
});
