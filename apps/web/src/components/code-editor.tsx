// The Monaco editors of the raw editor (screen 4) and the save dialog
// (screen 5), lazy-loaded so the typed editor, the tests and the first
// paint never pull the editor bundle. The theme follows the app theme, and
// the raw editor's lint reaches the Monaco gutter as markers and glyphs.
import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import type * as MonacoTypes from "monaco-editor";
import { minimalEdit } from "../lib/editor-sync";
import { useTheme } from "../theme/theme-provider";
import { Skeleton } from "./ui/states";

const Monaco = lazy(async () => {
  await import("../lib/monaco");
  const editor = await import("@monaco-editor/react");
  return { default: editor.Editor };
});

const FALLBACK = (
  <div className="h-64 overflow-hidden rounded-control border border-border">
    <Skeleton className="h-full w-full rounded-none" />
  </div>
);

/** One lint finding of the raw file, shown in the Monaco gutter. */
export interface LintMarker {
  readonly line: number;
  readonly endLine?: number | undefined;
  readonly column?: number | undefined;
  readonly endColumn?: number | undefined;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
}

const MONACO_SEVERITY = { error: 8, warning: 4, info: 2 } as const;

function markersOf(lint: readonly LintMarker[]) {
  return lint
    .filter((marker) => marker.line > 0)
    .map((marker) => {
      const start = marker.column ?? 1;
      return {
        startLineNumber: marker.line,
        endLineNumber: marker.endLine ?? marker.line,
        startColumn: start,
        endColumn: Math.max(marker.endColumn ?? start + 1, start + 1),
        message: marker.message,
        severity: MONACO_SEVERITY[marker.severity],
        source: "Dialwarden lint",
      };
    });
}

/** The glyph margin classes of app.css, one per severity that gets an icon. */
export const GLYPH_CLASS = {
  error: "dw-lint-glyph-error",
  warning: "dw-lint-glyph-warning",
} as const;

/**
 * The gutter glyphs of the lint (live check F3a): an icon in the glyph
 * margin on every error and warning line, with the message on hover.
 */
export function glyphsOf(
  lint: readonly LintMarker[],
): MonacoTypes.editor.IModelDeltaDecoration[] {
  return lint
    .filter((marker) => marker.line > 0 && marker.severity !== "info")
    .map((marker) => ({
      range: {
        startLineNumber: marker.line,
        startColumn: 1,
        endLineNumber: marker.line,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        glyphMarginClassName:
          marker.severity === "error" ? GLYPH_CLASS.error : GLYPH_CLASS.warning,
        glyphMarginHoverMessage: { value: marker.message },
      },
    }));
}

/**
 * Replaces the model's text with an external text as one minimal edit on
 * the undo stack (live check F13). The caret keeps its place unless the
 * replaced part holds it; a text the model already shows is no edit.
 */
export function pushText(
  editor: MonacoTypes.editor.IStandaloneCodeEditor,
  text: string,
): boolean {
  const model = editor.getModel();
  if (model === null) {
    return false;
  }
  const edit = minimalEdit(model.getValue(), text);
  if (edit === null) {
    return false;
  }
  const start = model.getPositionAt(edit.start);
  const end = model.getPositionAt(edit.end);
  model.pushEditOperations(
    editor.getSelections(),
    [
      {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        text: edit.text,
      },
    ],
    () => null,
  );
  return true;
}

/**
 * The raw editor. The Monaco model is the editor's own after mount: typing
 * never waits for a React render, so a burst of keys lands where the caret
 * is (live check F13). The page learns every edit through onChange and
 * reaches the model only on a real external change, by changing
 * textVersion: a file switch, a reload after a save, a discard.
 */
export function LazyEditor({
  text,
  textVersion,
  language,
  onChange,
  lint,
  readOnly,
  height,
}: {
  /** The document's text: read when the editor mounts and on textVersion. */
  text: string;
  /** Changes when text is a new document, never on the user's own edits. */
  textVersion: string;
  language: string;
  onChange?: (value: string) => void;
  lint?: readonly LintMarker[];
  readOnly?: boolean;
  height?: string;
}) {
  const { resolved } = useTheme();
  const editorRef = useRef<MonacoTypes.editor.IStandaloneCodeEditor | null>(
    null,
  );
  const setMarkersRef = useRef<((lint: readonly LintMarker[]) => void) | null>(
    null,
  );
  const shownVersion = useRef<string | null>(null);
  // True while this component edits the model itself: those edits are not
  // the user's and never reach onChange.
  const syncing = useRef(false);

  // The lint must reach the gutter whenever it changes, not only when the
  // editor first mounts: the raw editor keeps one instance across files and
  // saves.
  useEffect(() => {
    setMarkersRef.current?.(lint ?? []);
  }, [lint]);

  // An external text reaches the mounted editor only on a new version; the
  // text prop alone may lag the model by a keystroke and is left alone.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || shownVersion.current === textVersion) {
      return;
    }
    shownVersion.current = textVersion;
    syncing.current = true;
    try {
      pushText(editor, text);
    } finally {
      syncing.current = false;
    }
  }, [text, textVersion]);

  return (
    <div className="overflow-hidden rounded-control border border-border">
      <Suspense fallback={FALLBACK}>
        <Monaco
          defaultValue={text}
          language={language}
          theme={resolved === "dark" ? "dw-dark" : "dw-light"}
          height={height ?? "70vh"}
          options={{
            readOnly: readOnly === true,
            glyphMargin: true,
            minimap: { enabled: false },
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 13,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: "on",
          }}
          onChange={(next) => {
            if (
              !syncing.current &&
              onChange !== undefined &&
              typeof next === "string"
            ) {
              onChange(next);
            }
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            shownVersion.current = textVersion;
            const glyphs = editor.createDecorationsCollection();
            const setMarkers = (next: readonly LintMarker[]) => {
              const model = editor.getModel();
              if (model !== null) {
                monaco.editor.setModelMarkers(
                  model,
                  "dialwarden",
                  markersOf(next),
                );
                glyphs.set(glyphsOf(next));
              }
            };
            setMarkersRef.current = setMarkers;
            if (lint !== undefined) {
              setMarkers(lint);
            }
          }}
        />
      </Suspense>
    </div>
  );
}

/** The diff editor is loading, shows, or could not load at all. */
type DiffState = "loading" | "ready" | "failed";

/**
 * The read-only diff of the save dialog (screen 5). The diff editor is
 * created straight on the Monaco API and disposed before its two text
 * models, so closing the dialog never logs the TextModel-disposed error
 * the react wrapper's dispose order caused (live check F2). A load that
 * fails, or settles after the dialog closed, is caught: a closed dialog
 * needs nothing, an open one says so instead of the skeleton.
 */
export const LazyDiffEditor = memo(function LazyDiffEditor({
  before,
  after,
  language = "ini",
}: {
  before: string;
  after: string;
  language?: string;
}) {
  const { resolved } = useTheme();
  const host = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<DiffState>("loading");
  const diffRef = useRef<MonacoTypes.editor.IDiffEditor | null>(null);
  const modelsRef = useRef<readonly MonacoTypes.editor.ITextModel[] | null>(
    null,
  );
  useEffect(() => {
    let disposed = false;
    Promise.all([import("../lib/monaco"), import("monaco-editor")])
      .then(([, monaco]) => {
        if (disposed || host.current === null) return;
        const original = monaco.editor.createModel(before, language);
        const modified = monaco.editor.createModel(after, language);
        const diff = monaco.editor.createDiffEditor(host.current, {
          readOnly: true,
          renderSideBySide: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          fontSize: 13,
          theme: resolved === "dark" ? "dw-dark" : "dw-light",
        });
        diff.setModel({ original, modified });
        diffRef.current = diff;
        modelsRef.current = [original, modified];
        setState("ready");
      })
      .catch(() => {
        // The bundle did not load, or it settled once the dialog was gone
        // (the jsdom teardown of the component tests): never an unhandled
        // rejection, and no state update on an unmounted editor.
        if (!disposed) setState("failed");
      });
    return () => {
      disposed = true;
      // Dispose the diff editor before its text models: the other way
      // round, Monaco logs the console error of live check F2.
      diffRef.current?.dispose();
      for (const model of modelsRef.current ?? []) {
        model.dispose();
      }
    };
  }, [before, after, language, resolved]);
  return (
    <div className="relative overflow-hidden rounded-control border border-border">
      <div ref={host} className="h-[40vh]" />
      {state === "ready" ? null : (
        <div className="absolute inset-0">
          {state === "failed" ? (
            <p role="alert" className="p-4 text-sm text-fg-muted">
              The diff could not be shown because the editor failed to load.
            </p>
          ) : (
            <Skeleton className="h-full w-full rounded-none" />
          )}
        </div>
      )}
    </div>
  );
});
