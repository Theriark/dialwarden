// The Monaco editors of the raw editor (screen 4) and the save dialog
// (screen 5), lazy-loaded so the typed editor, the tests and the first
// paint never pull the editor bundle. The theme follows the app theme, and
// the raw editor's lint reaches the Monaco gutter as markers.
import { lazy, Suspense } from "react";
import { useTheme } from "../theme/theme-provider";
import { Skeleton } from "./ui/states";

const Monaco = lazy(async () => {
  await import("../lib/monaco");
  const editor = await import("@monaco-editor/react");
  return { default: editor.Editor };
});

const MonacoDiff = lazy(async () => {
  await import("../lib/monaco");
  const editor = await import("@monaco-editor/react");
  return { default: editor.DiffEditor };
});

const FALLBACK = (
  <div className="h-64 overflow-hidden rounded-control border border-border">
    <Skeleton className="h-full w-full rounded-none" />
  </div>
);

/** One lint finding of the raw file, shown in the Monaco gutter. */
export interface LintMarker {
  readonly line: number;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
}

const MONACO_SEVERITY = { error: 8, warning: 4, info: 2 } as const;

function markersOf(lint: readonly LintMarker[]) {
  return lint
    .filter((marker) => marker.line !== null && marker.line > 0)
    .map((marker) => ({
      startLineNumber: marker.line,
      endLineNumber: marker.line,
      startColumn: 1,
      endColumn: 1,
      message: marker.message,
      severity: MONACO_SEVERITY[marker.severity],
      source: "Dialwarden lint",
    }));
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
            const model = editor.getModel();
            if (model !== null && lint !== undefined) {
              monaco.editor.setModelMarkers(
                model,
                "dialwarden",
                markersOf(lint),
              );
            }
          }}
        />
      </Suspense>
    </div>
  );
}

export function LazyDiffEditor({
  before,
  after,
  language = "ini",
}: {
  before: string;
  after: string;
  language?: string;
}) {
  const { resolved } = useTheme();
  return (
    <div className="overflow-hidden rounded-control border border-border">
      <Suspense fallback={FALLBACK}>
        <MonacoDiff
          original={before}
          modified={after}
          language={language}
          theme={resolved === "dark" ? "dw-dark" : "dw-light"}
          height="40vh"
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 13,
          }}
        />
      </Suspense>
    </div>
  );
}
