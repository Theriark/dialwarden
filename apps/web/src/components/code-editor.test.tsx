// @vitest-environment jsdom
// The lazy diff editor of the save dialog (live check F2, test check D1 of
// THE-2558): the editor bundle is replaced by a load the test settles by
// hand, the way monaco-editor rejects without a window once jsdom is torn
// down. A rejection must never go unhandled, mounted or not.
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render";
import { LazyDiffEditor } from "./code-editor";

const bundle = vi.hoisted(() => {
  const pending: ((reason: Error) => void)[] = [];
  return {
    /** One load per import, open until fail() settles every one of them. */
    load() {
      return new Promise<never>((_, reject) => {
        pending.push(reject);
      });
    },
    fail() {
      for (const reject of pending.splice(0)) {
        reject(new Error("window is not defined"));
      }
    },
    get waiting() {
      return pending.length;
    },
  };
});

vi.mock("../lib/monaco", () => bundle.load());
vi.mock("monaco-editor", () => bundle.load());

afterEach(cleanup);

function renderDiff() {
  return renderWithProviders(
    <LazyDiffEditor before="ExpRate=1" after="ExpRate=2" />,
  );
}

async function loadStarted() {
  await waitFor(() => {
    expect(bundle.waiting).toBeGreaterThan(0);
  });
}

describe("LazyDiffEditor", () => {
  it("says so instead of the skeleton when the editor fails to load", async () => {
    renderDiff();
    await loadStarted();
    bundle.fail();
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("editor failed to load");
  });

  it("ignores a load that settles after the dialog closed", async () => {
    const view = renderDiff();
    await loadStarted();
    view.unmount();
    bundle.fail();
    // Let the rejection settle: an unhandled one fails this file.
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
