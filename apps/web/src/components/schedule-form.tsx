// The schedule form (dev-work-plan P9-C step 2): one server, a name, a run
// time or a cron pattern in a time zone, an optional revert, the hook mode
// of contract C5 and the settings to change, picked from the pack and typed
// with the same SettingField the editor uses, with the shared validate()
// over the server's current values. The chips preview what the run writes.
// The API makes and removes schedules (no edit in place), so editing one
// means replacing it: the page does the create then the delete.
// A secret setting is never copied: the API answers a stored secret edit as
// the mask and drops a mask it is sent, so the form asks for the secret
// again (replace) or starts it empty (new) and refuses to send a mask.
/* eslint-disable security/detect-object-injection -- the keys are the pack's setting keys and the server's own JSON answer, never free-form input */
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Plus, Repeat, Undo2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import {
  sameJson,
  SECRET_MASK,
  type JsonValue,
  type Setting,
} from "@dialwarden/packs-schema";
import type { RunHooks } from "../api/changes";
import { fieldErrors, errorMessage } from "../api/errors";
import { serverSettingsQuery, settingsMetaQuery } from "../api/queries";
import type { Chip, Schedule, ScheduleInput, Server } from "../api/schema";
import {
  parseCron,
  cronMinGapMinutes,
  cronRunsPerDay,
  cronTimesOfDay,
} from "../lib/cron";
import { describeSchedule } from "../lib/format";
import { issuesOf, packOf, settingsByKey } from "../lib/pack";
import {
  browserTimeZone,
  isTimeZone,
  isoOfLocalInput,
  localInputValue,
  timeZoneOptions,
} from "../lib/time";
import { ChangeChip } from "./change-chip";
import { SettingField } from "./editor/setting-field";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { SelectField, TextField } from "./ui/field";

export const MAX_REVERT_MINUTES = 7 * 24 * 60;

/** The inline words of a secret setting whose value would not be stored. */
export const SECRET_RETYPE =
  "Type the secret: a stored secret is never copied into a schedule.";

/** True when a secret edit holds nothing the API would keep: the mask or nothing. */
export function secretMissing(value: unknown): boolean {
  return value === SECRET_MASK || value === "" || value === null;
}

/**
 * The value a setting starts from in the form: the server's current value,
 * else the pack default; a secret starts empty, because the settings read
 * holds only its mask, which the API would drop.
 */
export function startValueOf(
  setting: Setting,
  current: Readonly<Record<string, unknown>>,
): unknown {
  if (setting.secret === true) return "";
  return current[setting.key] ?? setting.default ?? null;
}

/**
 * Whether an edit has moved from its start value (P9 live check L4: the
 * marker said Edited before anything was typed). A secret counts as edited
 * once it holds something the API would keep.
 */
export function editMoved(
  setting: Setting,
  value: unknown,
  current: Readonly<Record<string, unknown>>,
): boolean {
  if (setting.secret === true) return !secretMissing(value);
  return !sameJson(
    (value ?? null) as JsonValue,
    (startValueOf(setting, current) ?? null) as JsonValue,
  );
}

export interface ScheduleFormState {
  readonly server: string;
  readonly name: string;
  readonly mode: "once" | "cron";
  readonly runAtLocal: string;
  readonly cron: string;
  readonly timezone: string;
  readonly revertAtLocal: string;
  readonly revertAfter: string;
  readonly runHooks: RunHooks;
  /** The edits in the order they were added. */
  readonly edits: readonly { settingKey: string; value: unknown }[];
}

export function emptyScheduleState(): ScheduleFormState {
  return {
    server: "",
    name: "",
    mode: "once",
    runAtLocal: "",
    cron: "",
    timezone: browserTimeZone(),
    revertAtLocal: "",
    revertAfter: "",
    runHooks: "none",
    edits: [],
  };
}

/** The form state of a stored schedule, for the replace flow. */
export function stateOfSchedule(schedule: Schedule): ScheduleFormState {
  return {
    server: schedule.serverId,
    name: schedule.name,
    mode: schedule.kind,
    runAtLocal:
      schedule.runAt === null
        ? ""
        : localInputValue(schedule.runAt, schedule.timezone),
    cron: schedule.cron ?? "",
    timezone: schedule.timezone,
    revertAtLocal:
      schedule.revertAt === null
        ? ""
        : localInputValue(schedule.revertAt, schedule.timezone),
    revertAfter:
      schedule.revertAfterMinutes === null
        ? ""
        : String(schedule.revertAfterMinutes),
    runHooks: schedule.runHooks,
    edits: schedule.edits.map((edit) => ({
      settingKey: edit.settingKey,
      value: edit.value,
    })),
  };
}

/**
 * The problems of the form in plain words by field, before anything is
 * sent: the same rules the server checks (both or neither of a run time and
 * a pattern, a run in the past, a revert before the run, an unknown zone, a
 * pattern more often than every 5 minutes), so the dialog says them inline.
 * An edit that still holds the server's secret mask is refused here too:
 * the API would drop it without a word.
 */
export function validateScheduleForm(
  state: ScheduleFormState,
  now = new Date(),
): Map<string, string> {
  const out = new Map<string, string>();
  if (state.server === "") {
    out.set("server", "Choose the server the schedule writes to.");
  }
  if (state.name.trim() === "") {
    out.set("name", "Give the schedule a name.");
  }
  const zoneOk = isTimeZone(state.timezone);
  if (!zoneOk) {
    out.set("timezone", "The time zone is not known.");
  }
  // The time checks still run with an unknown zone, read as UTC.
  const zone = zoneOk ? state.timezone : "UTC";
  if (state.mode === "once") {
    const runAt = isoOfLocalInput(state.runAtLocal, zone);
    if (runAt === null) {
      out.set("runAt", "Pick the date and time of the run.");
    } else if (Date.parse(runAt) <= now.getTime()) {
      out.set("runAt", "The run time is in the past.");
    }
    if (state.revertAtLocal !== "") {
      const revertAt = isoOfLocalInput(state.revertAtLocal, zone);
      if (revertAt === null) {
        out.set("revertAt", "The revert time is not complete.");
      } else if (runAt !== null && Date.parse(revertAt) <= Date.parse(runAt)) {
        out.set("revertAt", "The revert must come after the run.");
      }
    }
  } else {
    const fields = parseCron(state.cron);
    if (state.cron.trim() === "") {
      out.set("cron", "Enter a cron pattern, such as 0 4 * * *.");
    } else if (fields === null) {
      out.set("cron", "The pattern is not a five-field cron pattern.");
    } else if (cronMinGapMinutes(fields) < 5) {
      // The server's rule is the gap between two runs, not a count a day.
      out.set("cron", "A schedule runs at most every 5 minutes.");
    }
    if (state.revertAfter.trim() !== "") {
      const minutes = Number(state.revertAfter);
      if (
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > MAX_REVERT_MINUTES
      ) {
        out.set(
          "revertAfterMinutes",
          `The revert delay is 1 to ${MAX_REVERT_MINUTES} minutes (one week).`,
        );
      }
    }
  }
  if (state.edits.length === 0) {
    out.set("edits", "Add at least one setting to change.");
  }
  const masked = state.edits
    .filter((edit) => edit.value === SECRET_MASK)
    .map((edit) => edit.settingKey);
  if (masked.length > 0) {
    out.set(
      "edits",
      `Type the secret of ${masked.join(", ")} again: a stored secret is never copied into a new schedule.`,
    );
  }
  return out;
}

/** The body of POST /api/v1/schedules from a valid form state. */
export function inputOfState(state: ScheduleFormState): ScheduleInput {
  const base = {
    server: state.server,
    name: state.name.trim(),
    edits: state.edits,
    runHooks: state.runHooks,
    timezone: state.timezone,
  };
  if (state.mode === "once") {
    const runAt = isoOfLocalInput(state.runAtLocal, state.timezone) ?? "";
    const revertAt =
      state.revertAtLocal === ""
        ? null
        : isoOfLocalInput(state.revertAtLocal, state.timezone);
    return {
      ...base,
      runAt,
      ...(revertAt === null ? {} : { revertAt }),
    };
  }
  const minutes = Number(state.revertAfter);
  return {
    ...base,
    cron: state.cron.trim(),
    ...(state.revertAfter.trim() === "" ? {} : { revertAfterMinutes: minutes }),
  };
}

const HOOK_WORDS: readonly { value: RunHooks; label: string }[] = [
  { value: "none", label: "Save only" },
  { value: "restart", label: "Save and restart" },
  { value: "stop-start", label: "Stop, save and start" },
];

const MODE =
  "flex cursor-pointer gap-3 rounded-control border border-border-strong bg-surface p-3 has-[:checked]:border-primary has-[:checked]:bg-accent-soft";

export interface ScheduleFormProps {
  /** The servers the person may see; the server checks the write grant. */
  servers: readonly Server[];
  /** The stored schedule being replaced, or none for a new one. */
  initial?: Schedule | undefined;
  pending: boolean;
  /** The error of the last save, for the inline field words. */
  error?: unknown;
  onSubmit: (input: ScheduleInput) => void;
  onCancel: () => void;
}

export function ScheduleForm({
  servers,
  initial,
  pending,
  error,
  onSubmit,
  onCancel,
}: ScheduleFormProps) {
  const [state, setState] = useState<ScheduleFormState>(() =>
    initial === undefined ? emptyScheduleState() : stateOfSchedule(initial),
  );
  const [touched, setTouched] = useState(false);
  const [adding, setAdding] = useState("");
  const patch = (next: Partial<ScheduleFormState>) => {
    setState((current) => ({ ...current, ...next }));
  };

  const settings = useQuery({
    ...serverSettingsQuery(state.server),
    enabled: state.server !== "",
  });
  const packId = settings.data?.packId;
  const meta = useQuery({
    ...settingsMetaQuery(packId ?? ""),
    enabled: packId !== undefined,
  });
  const pack = useMemo(
    () => (meta.data === undefined ? null : packOf(meta.data)),
    [meta.data],
  );
  const byKey = useMemo(
    () => settingsByKey((meta.data?.settings ?? []) as Setting[]),
    [meta.data],
  );
  const current = settings.data?.values ?? {};
  const draft = useMemo(
    () =>
      Object.fromEntries(
        state.edits.map((edit) => [edit.settingKey, edit.value]),
      ),
    [state.edits],
  );
  const issues = useMemo(() => {
    if (pack === null) {
      return new Map<string, { severity: string; message: string }>();
    }
    const all = issuesOf(pack, { ...current, ...draft });
    const mine = new Map<string, { severity: string; message: string }>();
    for (const edit of state.edits) {
      const issue = all.get(edit.settingKey);
      if (issue !== undefined) {
        mine.set(edit.settingKey, issue);
      }
      // A secret the API would drop (its mask, or nothing typed yet) is an
      // error on the field: the schedule must carry the real value.
      if (
        byKey.get(edit.settingKey)?.secret === true &&
        secretMissing(edit.value)
      ) {
        mine.set(edit.settingKey, {
          severity: "error",
          message: SECRET_RETYPE,
        });
      }
    }
    return mine;
  }, [pack, byKey, current, draft, state.edits]);

  const problems = useMemo(
    () => (touched ? validateScheduleForm(state) : new Map<string, string>()),
    [state, touched],
  );
  const serverProblems = fieldErrors(error);
  const problemOf = (field: string): string | undefined =>
    problems.get(field) ?? serverProblems.get(field);
  const blocked = [...issues.values()].some(
    (issue) => issue.severity === "error",
  );

  const chips: Chip[] = state.edits.map((edit) => {
    const setting = byKey.get(edit.settingKey);
    const from = current[edit.settingKey];
    // A secret never reaches a chip: the server's own chips mask it too.
    const secret = setting?.secret === true;
    return {
      kind: secret ? "masked" : from === undefined ? "added" : "changed",
      fileId: setting?.file ?? "",
      settingKey: edit.settingKey,
      label: setting?.label ?? edit.settingKey,
      from: from ?? null,
      to: secret ? SECRET_MASK : edit.value,
      restartRequired: setting?.restartRequired === true,
    };
  });

  const addable = ((meta.data?.settings ?? []) as Setting[]).filter(
    (setting) =>
      setting.panelManaged !== true &&
      setting.type !== "struct" &&
      !state.edits.some((edit) => edit.settingKey === setting.key),
  );

  const addSetting = (key: string) => {
    const setting = byKey.get(key);
    if (setting === undefined) {
      return;
    }
    const value = startValueOf(setting, current);
    patch({ edits: [...state.edits, { settingKey: key, value }] });
    setAdding("");
  };

  const removeSetting = (key: string) => {
    patch({
      edits: state.edits.filter((item) => item.settingKey !== key),
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (validateScheduleForm(state).size > 0 || blocked) {
      return;
    }
    onSubmit(inputOfState(state));
  };

  const cronFields = state.mode === "cron" ? parseCron(state.cron) : null;
  const cronPreview =
    cronFields === null
      ? null
      : `${describeSchedule(state.cron.trim(), state.timezone)} · ${cronTimesOfDay(cronFields, 4).join(", ")}${
          cronRunsPerDay(cronFields) > 4
            ? ` and ${cronRunsPerDay(cronFields) - 4} more times a day`
            : ""
        }`;

  const generalError =
    error !== undefined && error !== null && serverProblems.size === 0
      ? errorMessage(error)
      : null;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={submit}
      noValidate
      aria-label={initial === undefined ? "New schedule" : "Replace schedule"}
    >
      {generalError !== null ? (
        <Alert kind="error">{generalError}</Alert>
      ) : null}
      {initial === undefined ? null : (
        <Alert kind="info">
          Saving makes a new schedule with these values and removes the old one;
          a revert still due on the old one is dropped with it.
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField
          id="schedule-server"
          label="Server"
          placeholder="Choose a server"
          value={state.server}
          disabled={pending || initial !== undefined}
          error={problemOf("server")}
          options={servers.map((server) => ({
            value: server.id,
            label: `${server.name} (${server.displayName})`,
          }))}
          onChange={(next) => {
            patch({ server: next, edits: [] });
          }}
        />
        <TextField
          id="schedule-name"
          label="Name"
          placeholder="Weekend double rates"
          value={state.name}
          disabled={pending}
          error={problemOf("name")}
          maxLength={80}
          onChange={(event) => {
            patch({ name: event.target.value });
          }}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-fg">When</legend>
        <label className={MODE}>
          <input
            type="radio"
            name="schedule-mode"
            value="once"
            className="mt-1 accent-primary"
            checked={state.mode === "once"}
            disabled={pending}
            onChange={() => {
              patch({ mode: "once" });
            }}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <CalendarClock className="size-4" aria-hidden="true" />
              Once, at a set time
            </span>
            <span className="text-sm text-fg-muted">
              Runs one time, with an optional revert at a later time.
            </span>
          </span>
        </label>
        <label className={MODE}>
          <input
            type="radio"
            name="schedule-mode"
            value="cron"
            className="mt-1 accent-primary"
            checked={state.mode === "cron"}
            disabled={pending}
            onChange={() => {
              patch({ mode: "cron" });
            }}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <Repeat className="size-4" aria-hidden="true" />
              Repeat on a cron pattern
            </span>
            <span className="text-sm text-fg-muted">
              Runs on every occurrence, at most every 5 minutes, with an
              optional revert a number of minutes after each run.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {state.mode === "once" ? (
          <TextField
            id="schedule-run-at"
            label="Run at"
            type="datetime-local"
            value={state.runAtLocal}
            disabled={pending}
            error={problemOf("runAt")}
            help="In the time zone chosen on the right."
            onChange={(event) => {
              patch({ runAtLocal: event.target.value });
            }}
          />
        ) : (
          <TextField
            id="schedule-cron"
            label="Cron pattern"
            placeholder="0 4 * * *"
            spellCheck={false}
            value={state.cron}
            disabled={pending}
            error={problemOf("cron")}
            help={
              cronPreview ??
              "Minute, hour, day of month, month, day of week; names and steps allowed."
            }
            onChange={(event) => {
              patch({ cron: event.target.value });
            }}
          />
        )}
        <SelectField
          id="schedule-timezone"
          label="Time zone"
          value={state.timezone}
          disabled={pending}
          error={problemOf("timezone")}
          options={timeZoneOptions().map((zone) => ({
            value: zone,
            label: zone,
          }))}
          onChange={(next) => {
            patch({ timezone: next });
          }}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {state.mode === "once" ? (
          <TextField
            id="schedule-revert-at"
            label="Revert at (optional)"
            type="datetime-local"
            value={state.revertAtLocal}
            disabled={pending}
            error={problemOf("revertAt")}
            help="Writes back the values the files held before the run."
            onChange={(event) => {
              patch({ revertAtLocal: event.target.value });
            }}
          />
        ) : (
          <TextField
            id="schedule-revert-after"
            label="Revert after (minutes, optional)"
            type="number"
            min={1}
            max={MAX_REVERT_MINUTES}
            value={state.revertAfter}
            disabled={pending}
            error={problemOf("revertAfterMinutes")}
            help="After each run, writes back the values the run found."
            onChange={(event) => {
              patch({ revertAfter: event.target.value });
            }}
          />
        )}
        <SelectField
          id="schedule-hooks"
          label="After the run"
          value={state.runHooks}
          disabled={pending}
          options={HOOK_WORDS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          onChange={(next) => {
            if (
              next === "none" ||
              next === "restart" ||
              next === "stop-start"
            ) {
              patch({ runHooks: next });
            }
          }}
          help="Save only writes the files; the restart modes run the server's hooks like the save dialog."
        />
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-fg">
          Settings to change
        </legend>
        {state.server === "" ? (
          <p className="text-sm text-fg-muted">
            Choose a server first: its pack lists the settings.
          </p>
        ) : settings.isError ? (
          <Alert kind="warning">
            The server's settings could not be read:{" "}
            {errorMessage(settings.error)}
          </Alert>
        ) : meta.data === undefined ? (
          <p className="text-sm text-fg-muted">Loading the pack…</p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <SelectField
                  id="schedule-add-setting"
                  label="Add a setting"
                  placeholder="Choose a setting"
                  value={adding}
                  disabled={pending || addable.length === 0}
                  options={addable.map((setting) => ({
                    value: setting.key,
                    label: `${setting.label ?? setting.key}${
                      setting.group === undefined ? "" : ` (${setting.group})`
                    }`,
                  }))}
                  onChange={setAdding}
                />
              </div>
              <Button
                className="sm:mb-0"
                disabled={adding === "" || pending}
                icon={<Plus className="size-4" aria-hidden="true" />}
                onClick={() => {
                  addSetting(adding);
                }}
              >
                Add
              </Button>
            </div>
            {problemOf("edits") !== undefined ? (
              <p role="alert" className="text-sm text-error">
                {problemOf("edits")}
              </p>
            ) : null}
            {state.edits.length === 0 ? null : (
              <ul className="flex flex-col gap-4 rounded-control border border-border p-3">
                {state.edits.map((edit) => {
                  const setting = byKey.get(edit.settingKey);
                  if (setting === undefined) {
                    return (
                      <li
                        key={edit.settingKey}
                        className="flex flex-wrap items-center justify-between gap-2 text-sm"
                      >
                        <span className="font-mono text-xs text-fg">
                          {edit.settingKey}: {JSON.stringify(edit.value)}
                        </span>
                        <Button
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            removeSetting(edit.settingKey);
                          }}
                        >
                          Remove
                        </Button>
                      </li>
                    );
                  }
                  return (
                    <li key={edit.settingKey} className="flex flex-col gap-1.5">
                      <SettingField
                        setting={setting}
                        // The server's mask is not a value: the box starts
                        // empty and the issue below it asks for the secret.
                        value={edit.value === SECRET_MASK ? "" : edit.value}
                        edited={editMoved(setting, edit.value, current)}
                        issue={issues.get(edit.settingKey)?.message}
                        severity={issues.get(edit.settingKey)?.severity}
                        secretHelp={`${setting.description} Type the secret this run writes; the stored one is never copied into a schedule.`}
                        disabled={pending}
                        onChange={(key, value) => {
                          patch({
                            edits: state.edits.map((item) =>
                              item.settingKey === key
                                ? { settingKey: key, value }
                                : item,
                            ),
                          });
                        }}
                        // Reset puts the start value back; the row stays
                        // (Remove below takes it out of the schedule).
                        onReset={(key) => {
                          patch({
                            edits: state.edits.map((item) =>
                              item.settingKey === key
                                ? {
                                    settingKey: key,
                                    value: startValueOf(setting, current),
                                  }
                                : item,
                            ),
                          });
                        }}
                      />
                      <div className="flex justify-end">
                        {/* The setting's name is read after the visible
                            words, not put in an aria-label: a label holding
                            it would make the button a second match for the
                            field's own label. */}
                        <Button
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={pending}
                          onClick={() => {
                            removeSetting(edit.settingKey);
                          }}
                        >
                          Remove from the schedule
                          <span className="sr-only">
                            : {setting.label ?? setting.key}
                          </span>
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {chips.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium tracking-wide text-fg-muted uppercase">
                  Each run writes
                </span>
                <ul className="flex flex-wrap gap-1.5">
                  {chips.map((chip) => (
                    <ChangeChip
                      key={chip.settingKey ?? chip.label}
                      chip={chip}
                    />
                  ))}
                </ul>
                {state.mode === "once" && state.revertAtLocal !== "" ? (
                  <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                    <Undo2 className="size-3.5" aria-hidden="true" />
                    The revert puts the values the files held before the run
                    back.
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={blocked}
          title={blocked ? "Fix the setting errors first" : undefined}
        >
          {initial === undefined ? "Create schedule" : "Replace schedule"}
        </Button>
      </div>
    </form>
  );
}
