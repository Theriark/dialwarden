// @vitest-environment jsdom
// The raw editor's model is its own after mount (live check F13): the text
// prop may lag the model by a keystroke and is never written back; only a
// new textVersion reaches the model, as one minimal edit that stays off
// onChange. The Monaco wrapper is replaced by a fake that keeps a text
// model with the three calls the editor uses, so the sync path runs in
// jsdom without the editor bundle.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/theme-provider";
import { GLYPH_CLASS, LazyEditor, type LintMarker } from "./code-editor";

interface Position {
  lineNumber: number;
  column: number;
}

interface Edit {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
}

const fake = vi.hoisted(() => {
  const state = {
    value: "",
    pushes: [] as Edit[],
    markers: [] as unknown[],
    glyphs: [] as { options: { glyphMarginClassName?: string } }[],
    listeners: [] as (() => void)[],
  };
  const offsetOf = (position: Position): number => {
    const lines = state.value.split("\n");
    let offset = 0;
    for (let line = 1; line < position.lineNumber; line += 1) {
      offset += (lines[line - 1]?.length ?? 0) + 1;
    }
    return offset + position.column - 1;
  };
  const model = {
    getValue: () => state.value,
    getPositionAt(offset: number): Position {
      const head = state.value.slice(0, offset).split("\n");
      return {
        lineNumber: head.length,
        column: (head[head.length - 1]?.length ?? 0) + 1,
      };
    },
    pushEditOperations(_before: unknown, edits: Edit[]) {
      for (const edit of edits) {
        const start = offsetOf({
          lineNumber: edit.range.startLineNumber,
          column: edit.range.startColumn,
        });
        const end = offsetOf({
          lineNumber: edit.range.endLineNumber,
          column: edit.range.endColumn,
        });
        state.pushes.push(edit);
        state.value =
          state.value.slice(0, start) + edit.text + state.value.slice(end);
      }
      for (const listener of state.listeners) listener();
      return null;
    },
  };
  const editor = {
    getModel: () => model,
    getSelections: () => [],
    createDecorationsCollection: () => ({
      set(next: { options: { glyphMarginClassName?: string } }[]) {
        state.glyphs = next;
      },
    }),
    onDidChangeModelContent(listener: () => void) {
      state.listeners.push(listener);
      return {
        dispose() {
          state.listeners = state.listeners.filter((l) => l !== listener);
        },
      };
    },
  };
  const monaco = {
    editor: {
      setModelMarkers(_model: unknown, _owner: string, markers: unknown[]) {
        state.markers = markers;
      },
    },
  };
  /** What the user types: the model changes first, the wrapper reports. */
  const type = (text: string) => {
    state.value += text;
    for (const listener of state.listeners) listener();
  };
  const reset = () => {
    state.value = "";
    state.pushes = [];
    state.markers = [];
    state.glyphs = [];
    state.listeners = [];
  };
  return { state, model, editor, monaco, type, reset };
});

vi.mock("../lib/monaco", () => ({}));

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");
  function Editor(props: {
    defaultValue?: string;
    onChange?: (value: string | undefined) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) {
    const latest = React.useRef(props);
    latest.current = props;
    React.useEffect(() => {
      fake.state.value = latest.current.defaultValue ?? "";
      const subscription = fake.editor.onDidChangeModelContent(() => {
        latest.current.onChange?.(fake.model.getValue());
      });
      latest.current.onMount?.(fake.editor, fake.monaco);
      return () => {
        subscription.dispose();
      };
    }, []);
    return React.createElement("div", { "data-testid": "fake-monaco" });
  }
  return { Editor };
});

beforeEach(() => {
  fake.reset();
});

afterEach(cleanup);

function editor(
  text: string,
  version: string,
  onChange: (value: string) => void,
  lint?: readonly LintMarker[],
) {
  return (
    <ThemeProvider>
      <LazyEditor
        text={text}
        textVersion={version}
        language="ini"
        onChange={onChange}
        lint={lint}
      />
    </ThemeProvider>
  );
}

describe("LazyEditor", () => {
  it("leaves the model alone when only the text prop moves, even behind the keys", async () => {
    const onChange = vi.fn();
    const view = render(editor("a=1\n", "settings:1", onChange));
    await screen.findByTestId("fake-monaco");
    expect(fake.state.value).toBe("a=1\n");

    act(() => {
      fake.type("b=2\n");
    });
    expect(onChange).toHaveBeenLastCalledWith("a=1\nb=2\n");

    // The parent echoes the edit back, then an older render lags behind:
    // neither is a new document, so the model never moves.
    view.rerender(editor("a=1\nb=2\n", "settings:1", onChange));
    view.rerender(editor("a=1\n", "settings:1", onChange));
    expect(fake.state.pushes).toEqual([]);
    expect(fake.state.value).toBe("a=1\nb=2\n");
  });

  it("takes a new version as one minimal edit and keeps it off onChange", async () => {
    const onChange = vi.fn();
    const view = render(editor("a=1\nb=2\nc=3\n", "settings:1", onChange));
    await screen.findByTestId("fake-monaco");

    view.rerender(editor("a=1\nb=22\nc=3\n", "settings:2", onChange));
    expect(fake.state.value).toBe("a=1\nb=22\nc=3\n");
    expect(fake.state.pushes).toEqual([
      {
        range: {
          startLineNumber: 2,
          startColumn: 4,
          endLineNumber: 2,
          endColumn: 4,
        },
        text: "2",
      },
    ]);
    expect(onChange).not.toHaveBeenCalled();

    // The same text under a new version (a reload that found no change)
    // is no edit at all.
    view.rerender(editor("a=1\nb=22\nc=3\n", "settings:3", onChange));
    expect(fake.state.pushes).toHaveLength(1);
  });

  it("switches to another file as one replace", async () => {
    const onChange = vi.fn();
    const view = render(editor("[Game]\nx=1\n", "game:1", onChange));
    await screen.findByTestId("fake-monaco");

    view.rerender(editor("[Engine]\ny=2\n", "engine:1", onChange));
    expect(fake.state.value).toBe("[Engine]\ny=2\n");
    expect(fake.state.pushes).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws a glyph and a marker on every error and warning line", async () => {
    const lint: LintMarker[] = [
      { line: 2, severity: "error", message: "No key value pair." },
      { line: 3, severity: "warning", message: "Unknown key." },
      { line: 4, severity: "info", message: "Just so you know." },
    ];
    const view = render(editor("a=1\nb\nc=3\nd=4\n", "settings:1", vi.fn()));
    await screen.findByTestId("fake-monaco");
    view.rerender(editor("a=1\nb\nc=3\nd=4\n", "settings:1", vi.fn(), lint));
    expect(fake.state.markers).toHaveLength(3);
    expect(
      fake.state.glyphs.map((glyph) => glyph.options.glyphMarginClassName),
    ).toEqual([GLYPH_CLASS.error, GLYPH_CLASS.warning]);
  });
});
