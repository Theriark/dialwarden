// The list editor of a masked list setting (dev-work-plan P6-C step 6): the
// Steam id access lists of a game server (adminlist, bannedlist,
// permittedlist). The stored ids never reach the browser (the settings API
// masks a setting marked secret, contract C3), so the field shows that a
// list is stored and lets the user replace it: one id per row, every row
// masked until Show, a counter, and Keep the stored list to hand the key
// back to the server. A lint of severity warning sits under the field in
// the warning colour as a status (phase-report-07 F-P7-2); an error keeps
// the alert and marks the box invalid.
import {
  CircleX,
  Eye,
  EyeOff,
  ListChecks,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import type { Setting } from "@dialwarden/packs-schema";
import { Button, IconButton } from "../ui/button";
import { cn } from "../../lib/cn";

const CONTROL =
  "h-10 w-full rounded-control border border-border-strong bg-surface px-3 font-mono text-base text-fg placeholder:text-fg-muted disabled:opacity-60 aria-[invalid=true]:border-error";

/** The ids of a typed value; the server's mask (a string) holds none. */
export function idsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

/** The ids typed or pasted into the add box: one per line or comma. */
export function splitIds(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** The last characters of an id stay visible; the rest is masked. */
export function maskId(id: string): string {
  const keep = Math.min(4, id.length);
  const dots = "•".repeat(Math.max(4, id.length - keep));
  return `${dots}${id.slice(id.length - keep)}`;
}

export interface AccessListFieldProps {
  setting: Setting;
  value: unknown;
  edited: boolean;
  /** An error of the lint: the box is invalid and the text is an alert. */
  issue: string | undefined;
  /** A warning of the lint: the value is accepted, the text is a status. */
  warning?: string | undefined;
  disabled: boolean;
  onChange: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
}

export function AccessListField({
  setting,
  value,
  edited,
  issue,
  warning,
  disabled,
  onChange,
  onReset,
}: AccessListFieldProps) {
  const id = `setting-${setting.key}`;
  const helpId = useId();
  const errorId = `${helpId}-error`;
  const warningId = `${helpId}-warning`;
  const describedBy = [
    issue !== undefined ? errorId : null,
    warning !== undefined ? warningId : null,
    helpId,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const [shown, setShown] = useState(false);
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const ids = edited ? idsOf(value) : [];
  const stored = !edited && value !== null && value !== undefined;
  const editing = edited || replacing;
  const label = setting.label ?? setting.key;

  const add = () => {
    const next = splitIds(draft);
    if (next.length === 0) return;
    onChange(setting.key, [...ids, ...next]);
    setDraft("");
  };
  const remove = (index: number) => {
    onChange(
      setting.key,
      ids.filter((_, at) => at !== index),
    );
  };
  const keep = () => {
    setReplacing(false);
    setDraft("");
    onReset(setting.key);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={editing ? id : undefined}
          className="text-sm font-medium text-fg"
        >
          {label}
        </label>
        {editing && ids.length > 0 ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
            aria-pressed={shown}
            onClick={() => {
              setShown((current) => !current);
            }}
          >
            {shown ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
            {shown ? "Hide ids" : "Show ids"}
          </button>
        ) : null}
      </div>
      {editing ? (
        <>
          {ids.length > 0 ? (
            <ul
              aria-label={`${label} ids`}
              className="flex flex-col divide-y divide-border rounded-control border border-border-strong bg-surface"
            >
              {ids.map((item, index) => (
                <li
                  key={`${index}-${item}`}
                  className="flex items-center justify-between gap-2 px-3 py-1.5"
                >
                  <span className="font-mono text-sm text-fg">
                    {shown ? item : maskId(item)}
                  </span>
                  <IconButton
                    label={`Remove id ${index + 1}`}
                    className="size-8"
                    disabled={disabled}
                    onClick={() => {
                      remove(index);
                    }}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-control border border-dashed border-border-strong px-3 py-2 text-sm text-fg-muted">
              Add the first id
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              id={id}
              rows={1}
              className={cn(CONTROL, "flex-1 resize-y py-2")}
              placeholder="Add an id, or paste several"
              autoComplete="off"
              value={draft}
              disabled={disabled}
              aria-invalid={issue !== undefined ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={onKey}
            />
            <Button
              size="lg"
              disabled={disabled || splitIds(draft).length === 0}
              icon={<Plus className="size-4" aria-hidden="true" />}
              onClick={add}
            >
              Add
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-xs text-fg-muted">
              <ListChecks className="size-3.5" aria-hidden="true" />
              {ids.length} {ids.length === 1 ? "id" : "ids"} in the new list
            </span>
            <Button
              variant="ghost"
              className="h-6 px-2 text-xs"
              disabled={disabled}
              onClick={keep}
            >
              Keep the stored list
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border-strong bg-surface px-3 py-2">
          <span className="flex items-center gap-2 text-sm text-fg-muted">
            <EyeOff className="size-4 shrink-0" aria-hidden="true" />
            {stored ? "A list is stored; its ids stay hidden." : "No list yet."}
          </span>
          <Button
            disabled={disabled}
            onClick={() => {
              setReplacing(true);
            }}
          >
            {stored ? "Replace the list" : "Add ids"}
          </Button>
        </div>
      )}
      {issue !== undefined ? (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1.5 text-sm text-error"
        >
          <CircleX className="size-4 shrink-0" aria-hidden="true" />
          {issue}
        </p>
      ) : null}
      {warning !== undefined ? (
        <p
          id={warningId}
          role="status"
          className="flex items-center gap-1.5 text-sm text-warning"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          {warning}
        </p>
      ) : null}
      <p id={helpId} className="text-sm text-fg-muted">
        {setting.description} One id per row; the list is masked in the browser
        and in every export.
      </p>
    </div>
  );
}
