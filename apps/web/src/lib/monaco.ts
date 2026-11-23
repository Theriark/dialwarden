// Monaco, bundled from the local package: no CDN and no outside host (the
// P1-A decision), and the workers are Vite worker files served from the app
// origin, so the Content-Security-Policy (script-src 'self', worker-src
// 'self') holds. The two themes use the brand tokens of tokens.css.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    return label === "json" ? new jsonWorker() : new editorWorker();
  },
};

monaco.editor.defineTheme("dw-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#141b2d",
    "editorLineNumber.foreground": "#8a97ad",
    "editorGutter.background": "#ffffff",
    "editor.lineHighlightBackground": "#e4efea",
  },
});

monaco.editor.defineTheme("dw-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e2740",
    "editor.foreground": "#eef2f7",
    "editorLineNumber.foreground": "#8a97ad",
    "editorGutter.background": "#1e2740",
    "editor.lineHighlightBackground": "#233e49",
  },
});

loader.config({ monaco });
