// The Monaco editors of the raw editor (screen 4) and the save dialog
// (screen 5), lazy-loaded so the typed editor, the tests and the first
// paint never pull the editor bundle. The theme follows the app theme, and
// the raw editor's lint reaches the Monaco gutter as markers.
import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { useTheme } from "theme/theme-provider";
import { Skeleton } from "ui/states";

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

export function LazyEditor({
  value,
  language,
  onChange,
  lint,
  readOnly,
  height,
}: {
  value: string;
  language: string;
  onChange?: (value: string) => void;
  lint?: readonly LintMarker[];
  readOnly?: boolean;
  height?: string;
}) {
  const { resolved } = useTheme();
  const setMarkersRef = useRef<((lint: readonly LintMarker[]) => void) | null>(
    null,
  );

  // The lint must reach the gutter whenever it changes, not only when the
  // editor first mounts: the raw editor keeps one instance across files and
  // saves.
  useEffect(() => {
    setMarkersRef.current?.(lint ?? []);
  }, [lint]);

  return (
    <div className="overflow-hidden rounded-control border border-border">
      <Suspense fallback={FALLBACK}>
        <Monaco
          value={value}
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
            if (onChange !== undefined && typeof next === "string") {
              onChange(next);
            }
          }}
          onMount={(editor, monaco) => {
            const setMarkers = (next: readonly LintMarker[]) => {
              const model = editor.getModel();
              if (model !== null) {
                monaco.editor.setModelMarkers(
                  model,
                  "dialwarden",
                  markersOf(next),
                );
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

/**
 * The read-only diff of the save dialog (screen 5). The diff editor is
 * created straight on the Monaco API and disposed before its two text
 * models, so closing the dialog never logs the TextModel-disposed error
 * the react wrapper's dispose order caused (live check F2).
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
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    let diff: Monaco.editor.IDiffEditor | undefined;
    let original: Monaco.editor.ITextModel | undefined;
    let modified: Monaco.editor.ITextModel | undefined;
    void import("../lib/monaco").then((monaco) => {
      if (disposed || host.current === null) return;
      original = monaco.editor.createModel(before, language);
      modified = monaco.editor.createModel(after, language);
      diff = monaco.editor.createDiffEditor(host.current, {
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
      setReady(true);
    });
    return () => {
      disposed = true;
      // Dispose the diff editor before its text models: the other way
      // round, Monaco logs the console error of live check F2.
      diff?.dispose();
      original?.dispose();
      modified?.dispose();
    };
  }, [before, after, language, resolved]);
  return (
    <div className="relative overflow-hidden rounded-control border border-border">
      <div ref={host} className="h-[40vh]" />
      {ready ? null : (
        <div className="absolute inset-0">
          <Skeleton className="h-full w-full rounded-none" />
        </div>
      )}
    </div>
  );
});
