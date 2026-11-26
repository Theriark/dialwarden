// One typed setting of the editor (screen 3, contract C3): the control that
// fits the setting's type, the inline validation and rule message, the
// restart-required, panel-managed, secret and since-removed badges, and the
// edited-from-original marker with reset. Everything the server cannot write
// (a panel-managed field) renders disabled, never hidden.
import { EyeOff, Lock, RotateCw, TriangleAlert, Zap } from "lucide-react";
import { memo } from "react";
import type { Setting } from "@dialwarden/packs-schema";
import { PasswordField, SelectField, TextField } from "../ui/field";
import { SwitchField } from "../ui/switch";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";
import { AccessListField } from "./access-list-field";

const BADGE =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium";

const BADGES: Record<string, string> = {
  restart: "border-pending/40 bg-pending-soft text-pending",
  panel: "border-border bg-surface text-fg-muted",
  secret: "border-border bg-surface text-fg-muted",
  gone: "border-warning/40 bg-warning-soft text-warning",
  live: "border-info/40 bg-info-soft text-info",
};

function SettingBadges({ setting }: { setting: Setting }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {setting.restartRequired === true ? (
        <span className={cn(BADGE, BADGES.restart)}>
          <RotateCw className="size-3" aria-hidden="true" />
          Restart
        </span>
      ) : null}
      {setting.panelManaged === true ? (
        <span
          className={cn(BADGE, BADGES.panel)}
          title="The hosting panel writes this setting; Dialwarden shows it but does not save it"
        >
          <Lock className="size-3" aria-hidden="true" />
          Panel-managed
        </span>
      ) : null}
      {setting.secret === true ? (
        <span
          className={cn(BADGE, BADGES.secret)}
          title="The value is masked in the browser and in every export"
        >
          <EyeOff className="size-3" aria-hidden="true" />
          Secret
        </span>
      ) : null}
      {setting.liveReloadable === true ? (
        <span
          className={cn(BADGE, BADGES.live)}
          title="The game reads this file again while it runs"
        >
          <Zap className="size-3" aria-hidden="true" />
          Live
        </span>
      ) : null}
      {setting.removedIn !== undefined ? (
        <span
          className={cn(BADGE, BADGES.gone)}
          title="A newer pack version no longer writes this setting"
        >
          <TriangleAlert className="size-3" aria-hidden="true" />
          Gone in {setting.removedIn}
        </span>
      ) : null}
    </span>
  );
}

export interface SettingFieldProps {
  setting: Setting;
  /** The value the editor holds now (server value overlaid with edits). */
  value: unknown;
  /** True when the value differs from what the server last answered. */
  edited: boolean;
  /** The issue of this setting, when validate() has one. */
  issue: string | undefined;
  /**
   * How the issue is shown: an error marks the control invalid and blocks
   * the save; a warning or an info sits under it in the warning colour and
   * blocks nothing (phase-report-07 F-P7-2). Error when not given.
   */
  severity?: string | undefined;
  /**
   * The help text of a secret field, when the screen keeps the stored
   * value differently from the editor (the schedule form asks for the
   * secret again instead of keeping it, P9-C review R2).
   */
  secretHelp?: string | undefined;
  /** Every control disabled: read-only server, plan limit or permission. */
  disabled: boolean;
  onChange: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
}

/** A warning or an info never marks the control invalid; an error does. */
export function soft(severity: string | undefined): boolean {
  return severity === "warning" || severity === "info";
}

function listToText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => String(item)).join(", ");
}

function textToList(text: string): unknown[] {
  if (text.trim() === "") return [];
  return text.split(",").map((item) => item.trim());
}

/**
 * A list as a comma-separated text field: the packs' list settings hold
 * plain words (server tags, admin lists), never structured items.
 */
function ListField({
  setting,
  value,
  issue,
  warning,
  disabled,
  onChange,
}: {
  setting: Setting;
  value: unknown;
  issue: string | undefined;
  warning: string | undefined;
  disabled: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <TextField
      id={`setting-${setting.key}`}
      label={setting.label ?? setting.key}
      help={`${setting.description} Separate items with commas.`}
      error={issue}
      warning={warning}
      disabled={disabled}
      value={listToText(value)}
      onChange={(event) => {
        onChange(setting.key, textToList(event.target.value));
      }}
    />
  );
}

/**
 * Memoised: a keystroke in one field re-renders that field only, so a
 * 400-setting file stays under the P10 budget. The page passes stable
 * handlers (useCallback) and the pack's own setting objects.
 */
export const SettingField = memo(function SettingField({
  setting,
  value,
  edited,
  issue,
  severity,
  secretHelp,
  disabled,
  onChange,
  onReset,
}: SettingFieldProps) {
  const label = setting.label ?? setting.key;
  const locked = disabled || setting.panelManaged === true;
  const id = `setting-${setting.key}`;
  const error = soft(severity) ? undefined : issue;
  const warning = soft(severity) ? issue : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {setting.type === "bool" ? (
        <SwitchField
          id={id}
          label={label}
          description={setting.description}
          checked={value === true}
          disabled={locked}
          onCheckedChange={(next) => {
            onChange(setting.key, next);
          }}
        />
      ) : setting.type === "enum" ? (
        <SelectField
          id={id}
          label={label}
          help={setting.description}
          error={error}
          warning={warning}
          disabled={locked}
          value={String(value ?? "")}
          options={(setting.enum ?? []).map((option) => ({
            value: String(option.value),
            label: option.label,
          }))}
          onChange={(next) => {
            const match = (setting.enum ?? []).find(
              (option) => String(option.value) === next,
            );
            onChange(setting.key, match === undefined ? null : match.value);
          }}
        />
      ) : setting.secret === true && setting.type === "string" ? (
        <PasswordField
          id={id}
          label={label}
          help={
            secretHelp ??
            `${setting.description} Leave empty to keep the stored value.`
          }
          error={error}
          warning={warning}
          disabled={locked}
          value={edited ? String(value ?? "") : ""}
          placeholder={edited ? undefined : "Unchanged"}
          onChange={(event) => {
            // An empty box means what the help text says: keep the stored
            // value. Typing and then clearing hands the key back to the
            // server answer instead of queueing an empty string, which the
            // server would write over the stored secret (it only drops an
            // edit that equals its mask).
            if (event.target.value === "") {
              onReset(setting.key);
              return;
            }
            onChange(setting.key, event.target.value);
          }}
        />
      ) : setting.type === "list" && setting.secret === true ? (
        <AccessListField
          setting={setting}
          value={value}
          edited={edited}
          issue={error}
          warning={warning}
          disabled={locked}
          onChange={onChange}
          onReset={onReset}
        />
      ) : setting.type === "list" ? (
        <ListField
          setting={setting}
          value={value}
          issue={error}
          warning={warning}
          disabled={locked}
          onChange={onChange}
        />
      ) : setting.type === "int" ||
        setting.type === "float" ||
        setting.type === "duration" ? (
        <TextField
          id={id}
          label={label}
          help={
            setting.unit === undefined
              ? setting.description
              : `${setting.description} Unit: ${setting.unit}.`
          }
          error={error}
          warning={warning}
          disabled={locked}
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          min={setting.min}
          max={setting.max}
          step={setting.step}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              onChange(setting.key, null);
              return;
            }
            const parsed = Number(raw);
            onChange(setting.key, Number.isNaN(parsed) ? raw : parsed);
          }}
        />
      ) : setting.type === "struct" ? (
        <TextField
          id={id}
          label={label}
          help={`${setting.description} Groups of fields are edited in the raw editor.`}
          error={error}
          warning={warning}
          disabled
          value={JSON.stringify(value ?? null)}
          onChange={() => {
            /* A struct is never typed by hand in the typed editor. */
          }}
        />
      ) : (
        <TextField
          id={id}
          label={label}
          help={setting.description}
          error={error}
          warning={warning}
          disabled={locked}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(event) => {
            onChange(setting.key, event.target.value);
          }}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SettingBadges setting={setting} />
        {edited ? (
          <span className="flex items-center gap-2">
            <span className="text-xs font-medium text-primary">Edited</span>
            <Button
              variant="ghost"
              className="h-6 px-2 text-xs"
              disabled={disabled}
              onClick={() => {
                onReset(setting.key);
              }}
            >
              Reset
            </Button>
          </span>
        ) : null}
      </div>
      {setting.overrideNote !== undefined ? (
        <p className="text-xs text-fg-muted">{setting.overrideNote}</p>
      ) : null}
    </div>
  );
});
