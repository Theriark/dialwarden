// The launch source snippet panel (dev-work-plan P6-C step 5): the one-line
// snippets that wire the app-managed dialwarden-args.txt into a start
// command, for bash, PowerShell, Docker Compose and systemd, each with a copy
// button. The text comes from the shared launchSnippets() of packs-schema,
// so the browser shows exactly what the server documents.
/* eslint-disable security/detect-object-injection -- the keys are the four snippet kinds of this file, never free-form input */
import { launchSnippets, type Os } from "@dialwarden/packs-schema";
import { useState } from "react";
import { CodeBlock } from "./ui/code-block";
import { Tabs, type TabItem } from "./ui/tabs";

export type SnippetKind = "bash" | "powershell" | "compose" | "systemd";

const ITEMS: readonly (TabItem & { readonly id: SnippetKind })[] = [
  { id: "bash", label: "Bash" },
  { id: "powershell", label: "PowerShell" },
  { id: "compose", label: "Docker Compose" },
  { id: "systemd", label: "systemd" },
];

const HELP: Readonly<Record<SnippetKind, string>> = {
  bash: "Put this line in the start script that runs the game. The eval keeps quoted words together, so a server name with spaces reaches the game as one argument.",
  powershell:
    "Run this from the server folder on Windows. The file is passed to the game as its raw command line, so double quotes are kept.",
  compose:
    "Use this as the command of the game container. Compose reads $ itself, so the line writes it as $$.",
  systemd:
    "Use this as the ExecStart of the game's service unit; systemd reads $ itself, so the line writes it as $$.",
};

function isSnippetKind(value: string): value is SnippetKind {
  return ITEMS.some((item) => item.id === value);
}

export interface LaunchSnippetPanelProps {
  /** The args file name, as the pack declares it (dialwarden-args.txt). */
  fileName: string;
  /** The game executable the snippet starts. */
  executable: string;
  /** Picks the first tab: PowerShell for a Windows server. */
  os?: Os | undefined;
}

export function LaunchSnippetPanel({
  fileName,
  executable,
  os,
}: LaunchSnippetPanelProps) {
  const [kind, setKind] = useState<SnippetKind>(
    os === "windows" ? "powershell" : "bash",
  );
  const snippets = launchSnippets(fileName, executable);
  return (
    <Tabs
      label="Snippet language"
      items={ITEMS}
      value={kind}
      onChange={(next) => {
        if (isSnippetKind(next)) {
          setKind(next);
        }
      }}
      panel={(id) => {
        const chosen = isSnippetKind(id) ? id : "bash";
        const label = ITEMS.find((item) => item.id === chosen)?.label ?? "";
        return (
          <div className="flex flex-col gap-2">
            <CodeBlock value={snippets[chosen]} label={`${label} snippet`} />
            <p className="text-sm text-fg-muted">{HELP[chosen]}</p>
          </div>
        );
      }}
    />
  );
}
