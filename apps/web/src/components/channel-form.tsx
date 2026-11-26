// The notification channel form (dev-work-plan P9-C step 4): the name, the
// switch, the kind (fixed once made), the event types it receives and the
// settings of its kind. Secrets are never read back: the stored webhook
// address shows masked and is kept unless a new one is typed; a signing
// secret or an SMTP password is kept when its field stays empty and removed
// only through the explicit box, so clearing a field never erases a secret.
/* eslint-disable security/detect-object-injection -- the keys are the fixed channel kinds and the C6 event types of constant word tables, never free-form input */
import {
  Bell,
  Mail,
  MessageSquare,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, fieldErrors } from "../api/errors";
import {
  ACTIVITY_TYPES,
  type ActivityType,
  type ChannelInput,
  type ChannelKind,
  type ChannelSettingsInput,
  type ChannelView,
  type SmtpSecurity,
} from "../api/schema";
import { cn } from "../lib/cn";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import {
  PasswordField,
  SelectField,
  TextAreaField,
  TextField,
} from "./ui/field";
import { SwitchField } from "./ui/switch";

export const KIND_WORDS: Record<
  ChannelKind,
  { Icon: LucideIcon; word: string; help: string }
> = {
  in_app: {
    Icon: Bell,
    word: "In-app",
    help: "The bell in the top bar; each person sees the servers they may see.",
  },
  webhook: {
    Icon: Webhook,
    word: "Webhook",
    help: "A JSON POST to your own receiver, signed with HMAC when a secret is set.",
  },
  discord: {
    Icon: MessageSquare,
    word: "Discord",
    help: "A message in a Discord channel through its webhook address.",
  },
  smtp: {
    Icon: Mail,
    word: "E-mail",
    help: "A plain-text e-mail through your SMTP server, STARTTLS or TLS.",
  },
};

export const TYPE_WORDS: Record<ActivityType, string> = {
  "change.applied": "Change applied",
  "change.pending": "Change saved as pending",
  "change.conflict": "Save ended in a conflict",
  "hook.run": "Hook ran or failed",
  "drift.detected": "Drift found",
  "schedule.run": "Scheduled change ran",
  "schedule.reverted": "Scheduled change reverted",
  "backup.done": "Backup done",
  "backup.failed": "Backup failed",
  "licence.changed": "Licence changed",
  "user.changed": "User account changed",
};

export interface ChannelFormState {
  readonly name: string;
  readonly enabled: boolean;
  readonly kind: ChannelKind;
  readonly types: readonly ActivityType[];
  readonly url: string;
  readonly signingSecret: string;
  readonly clearSigningSecret: boolean;
  readonly allowPrivateHost: boolean;
  readonly host: string;
  readonly port: string;
  readonly security: SmtpSecurity;
  readonly username: string;
  readonly password: string;
  readonly clearPassword: boolean;
  readonly from: string;
  readonly to: string;
}

export function emptyChannelState(
  kind: ChannelKind = "webhook",
): ChannelFormState {
  return {
    name: "",
    enabled: true,
    kind,
    types: ["change.applied", "change.conflict", "drift.detected"],
    url: "",
    signingSecret: "",
    clearSigningSecret: false,
    allowPrivateHost: false,
    host: "",
    port: "587",
    security: "starttls",
    username: "",
    password: "",
    clearPassword: false,
    from: "",
    to: "",
  };
}

/** The form of a stored channel: the masked address, no secret. */
export function stateOfChannel(channel: ChannelView): ChannelFormState {
  const base = { ...emptyChannelState(channel.kind) };
  const settings = channel.settings;
  return {
    ...base,
    name: channel.name,
    enabled: channel.enabled,
    types: channel.types,
    url:
      settings.kind === "webhook" || settings.kind === "discord"
        ? settings.url
        : "",
    allowPrivateHost:
      settings.kind === "in_app" ? false : settings.allowPrivateHost,
    host: settings.kind === "smtp" ? settings.host : "",
    port: settings.kind === "smtp" ? String(settings.port) : "587",
    security: settings.kind === "smtp" ? settings.security : "starttls",
    username: settings.kind === "smtp" ? (settings.username ?? "") : "",
    from: settings.kind === "smtp" ? settings.from : "",
    to: settings.kind === "smtp" ? settings.to.join(", ") : "",
  };
}

function hasSecret(channel: ChannelView | undefined): boolean {
  if (channel === undefined) return false;
  if (channel.settings.kind === "webhook")
    return channel.settings.hasSigningSecret;
  if (channel.settings.kind === "smtp") return channel.settings.hasPassword;
  return false;
}

/** The problems of the form before anything is sent, by field. */
export function validateChannelForm(
  state: ChannelFormState,
  editing: boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  if (state.name.trim() === "") {
    out.set("name", "Give the channel a name.");
  }
  if (state.types.length === 0) {
    out.set("types", "Choose at least one event type.");
  }
  if (state.kind === "webhook" || state.kind === "discord") {
    if (!editing && state.url.trim() === "") {
      out.set("url", "Enter the webhook address (https).");
    } else if (
      state.url.trim() !== "" &&
      !/^https:\/\//i.test(state.url.trim()) &&
      !state.url.includes("***")
    ) {
      out.set("url", "The address must start with https://.");
    }
  }
  if (
    state.kind === "webhook" &&
    state.signingSecret !== "" &&
    (state.signingSecret.length < 16 || state.signingSecret.length > 256)
  ) {
    out.set("signingSecret", "A signing secret is 16 to 256 characters.");
  }
  if (state.kind === "smtp") {
    if (state.host.trim() === "")
      out.set("host", "Enter the mail server host.");
    const port = Number(state.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      out.set("port", "The port is 1 to 65535.");
    }
    if (state.from.trim() === "") out.set("from", "Enter the sender address.");
    const to = recipientsOf(state.to);
    if (to.length === 0) out.set("to", "Enter at least one recipient.");
    if (to.length > 10) out.set("to", "At most 10 recipients.");
  }
  return out;
}

export function recipientsOf(text: string): string[] {
  return text
    .split(/[,\n;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * The body the API takes. On an edit the masked address and an empty
 * secret field are left out, which keeps the stored values; the clear boxes
 * send null, which removes them.
 */
export function inputOfChannelState(
  state: ChannelFormState,
  editing: boolean,
): ChannelInput {
  const url = state.url.trim();
  const urlPart = url === "" || (editing && url.includes("***")) ? {} : { url };
  let settings: ChannelSettingsInput;
  switch (state.kind) {
    case "in_app":
      settings = { kind: "in_app" };
      break;
    case "webhook":
      settings = {
        kind: "webhook",
        ...urlPart,
        ...(state.clearSigningSecret
          ? { signingSecret: null }
          : state.signingSecret === ""
            ? {}
            : { signingSecret: state.signingSecret }),
        allowPrivateHost: state.allowPrivateHost,
      };
      break;
    case "discord":
      settings = {
        kind: "discord",
        ...urlPart,
        allowPrivateHost: state.allowPrivateHost,
      };
      break;
    default:
      settings = {
        kind: "smtp",
        host: state.host.trim(),
        port: Number(state.port),
        security: state.security,
        username: state.username.trim() === "" ? null : state.username.trim(),
        ...(state.clearPassword
          ? { password: null }
          : state.password === ""
            ? {}
            : { password: state.password }),
        from: state.from.trim(),
        to: recipientsOf(state.to),
        allowPrivateHost: state.allowPrivateHost,
      };
  }
  return {
    name: state.name.trim(),
    enabled: state.enabled,
    types: state.types,
    settings,
  };
}

const KIND_OPTION =
  "flex cursor-pointer gap-3 rounded-control border border-border-strong bg-surface p-3 has-[:checked]:border-primary has-[:checked]:bg-accent-soft has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";

export interface ChannelFormProps {
  initial?: ChannelView | undefined;
  /** Whether an in-app channel exists already (at most one). */
  inAppTaken: boolean;
  pending: boolean;
  error?: unknown;
  onSubmit: (input: ChannelInput) => void;
  onCancel: () => void;
}

export function ChannelForm({
  initial,
  inAppTaken,
  pending,
  error,
  onSubmit,
  onCancel,
}: ChannelFormProps) {
  const editing = initial !== undefined;
  const [state, setState] = useState<ChannelFormState>(() =>
    initial === undefined ? emptyChannelState() : stateOfChannel(initial),
  );
  const [touched, setTouched] = useState(false);
  const patch = (next: Partial<ChannelFormState>) => {
    setState((current) => ({ ...current, ...next }));
  };
  const problems = touched
    ? validateChannelForm(state, editing)
    : new Map<string, string>();
  const serverProblems = fieldErrors(error);
  const problemOf = (field: string): string | undefined => {
    if (problems.has(field)) return problems.get(field);
    for (const [path, message] of serverProblems) {
      if (
        path === field ||
        path.endsWith(`.${field}`) ||
        path.endsWith(`/${field}`)
      ) {
        return message;
      }
    }
    return undefined;
  };
  const generalError =
    error !== undefined && error !== null && serverProblems.size === 0
      ? errorMessage(error)
      : null;
  const stored = hasSecret(initial);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (validateChannelForm(state, editing).size > 0) {
      return;
    }
    onSubmit(inputOfChannelState(state, editing));
  };

  const toggleType = (type: ActivityType) => {
    patch({
      types: state.types.includes(type)
        ? state.types.filter((item) => item !== type)
        : [...state.types, type],
    });
  };

  const urlField = (
    <TextField
      id="channel-url"
      label="Webhook address"
      type="url"
      placeholder="https://…"
      spellCheck={false}
      autoComplete="off"
      value={state.url}
      disabled={pending}
      error={problemOf("url")}
      help={
        editing
          ? "Shown masked; leave it as it is to keep the stored address, or type a new one. https only."
          : "https only; private and local addresses need the switch below."
      }
      onChange={(event) => {
        patch({ url: event.target.value });
      }}
    />
  );

  const privateSwitch = (
    <SwitchField
      id="channel-private-host"
      label="Allow a host on the private network"
      description="Off refuses private and local addresses. Turn it on only for a receiver you host yourself; loopback and metadata addresses never pass."
      checked={state.allowPrivateHost}
      disabled={pending}
      onCheckedChange={(checked) => {
        patch({ allowPrivateHost: checked });
      }}
    />
  );

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={submit}
      noValidate
      aria-label={editing ? "Edit channel" : "New channel"}
    >
      {generalError !== null ? (
        <Alert kind="error">{generalError}</Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField
          id="channel-name"
          label="Name"
          placeholder="Ops Discord"
          value={state.name}
          disabled={pending}
          error={problemOf("name")}
          maxLength={100}
          onChange={(event) => {
            patch({ name: event.target.value });
          }}
        />
        <div className="md:pt-7">
          <SwitchField
            id="channel-enabled"
            label="Deliver events"
            description="Off keeps the channel and sends nothing; the send test still works."
            checked={state.enabled}
            disabled={pending}
            onCheckedChange={(checked) => {
              patch({ enabled: checked });
            }}
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-fg">Kind</legend>
        {editing ? (
          <p className="text-sm text-fg-muted">
            A channel keeps its kind; make a new one for another kind.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(Object.keys(KIND_WORDS) as ChannelKind[]).map((kind) => {
            const { Icon, word, help } = KIND_WORDS[kind];
            const taken = kind === "in_app" && inAppTaken && !editing;
            return (
              <label key={kind} className={KIND_OPTION}>
                <input
                  type="radio"
                  name="channel-kind"
                  value={kind}
                  className="mt-1 accent-primary"
                  checked={state.kind === kind}
                  disabled={pending || editing || taken}
                  onChange={() => {
                    patch({ kind });
                  }}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                    <Icon className="size-4" aria-hidden="true" />
                    {word}
                    {taken ? (
                      <span className="text-xs font-normal text-fg-muted">
                        (one exists already)
                      </span>
                    ) : null}
                  </span>
                  <span className="text-sm text-fg-muted">{help}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {state.kind === "webhook" ? (
        <div className="flex flex-col gap-4">
          {urlField}
          <PasswordField
            id="channel-signing-secret"
            label="Signing secret"
            autoComplete="off"
            placeholder={
              stored && !state.clearSigningSecret
                ? "Stored; leave empty to keep it"
                : "Optional, 16 to 256 characters"
            }
            help="With a secret every delivery carries x-dialwarden-signature: t=<seconds>,v1=<HMAC-SHA256 of t.body>."
            value={state.signingSecret}
            disabled={pending || state.clearSigningSecret}
            error={problemOf("signingSecret")}
            onChange={(event) => {
              patch({ signingSecret: event.target.value });
            }}
          />
          {stored ? (
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={state.clearSigningSecret}
                disabled={pending}
                onChange={(event) => {
                  patch({
                    clearSigningSecret: event.target.checked,
                    ...(event.target.checked ? { signingSecret: "" } : {}),
                  });
                }}
              />
              Remove the stored signing secret
            </label>
          ) : null}
          {privateSwitch}
        </div>
      ) : state.kind === "discord" ? (
        <div className="flex flex-col gap-4">
          {urlField}
          {privateSwitch}
        </div>
      ) : state.kind === "smtp" ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="md:col-span-2">
              <TextField
                id="channel-host"
                label="Mail server host"
                placeholder="smtp.example.net"
                spellCheck={false}
                autoComplete="off"
                value={state.host}
                disabled={pending}
                error={problemOf("host")}
                onChange={(event) => {
                  patch({ host: event.target.value });
                }}
              />
            </div>
            <TextField
              id="channel-port"
              label="Port"
              type="number"
              min={1}
              max={65535}
              value={state.port}
              disabled={pending}
              error={problemOf("port")}
              onChange={(event) => {
                patch({ port: event.target.value });
              }}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <SelectField
              id="channel-security"
              label="Security"
              value={state.security}
              disabled={pending}
              options={[
                { value: "starttls", label: "STARTTLS (port 587)" },
                { value: "tls", label: "TLS (port 465)" },
              ]}
              onChange={(next) => {
                if (next === "starttls" || next === "tls") {
                  patch({ security: next });
                }
              }}
            />
            <TextField
              id="channel-username"
              label="User name (optional)"
              autoComplete="off"
              spellCheck={false}
              value={state.username}
              disabled={pending}
              error={problemOf("username")}
              onChange={(event) => {
                patch({ username: event.target.value });
              }}
            />
            <PasswordField
              id="channel-password"
              label="Password"
              autoComplete="off"
              placeholder={
                stored && !state.clearPassword
                  ? "Stored; leave empty to keep it"
                  : "Optional"
              }
              value={state.password}
              disabled={pending || state.clearPassword}
              error={problemOf("password")}
              onChange={(event) => {
                patch({ password: event.target.value });
              }}
            />
          </div>
          {stored ? (
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={state.clearPassword}
                disabled={pending}
                onChange={(event) => {
                  patch({
                    clearPassword: event.target.checked,
                    ...(event.target.checked ? { password: "" } : {}),
                  });
                }}
              />
              Remove the stored password
            </label>
          ) : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TextField
              id="channel-from"
              label="Sender address"
              type="email"
              placeholder="dialwarden@example.net"
              autoComplete="off"
              spellCheck={false}
              value={state.from}
              disabled={pending}
              error={problemOf("from")}
              onChange={(event) => {
                patch({ from: event.target.value });
              }}
            />
            <TextAreaField
              id="channel-to"
              label="Recipients"
              placeholder="ops@example.net, admin@example.net"
              help="Up to 10 addresses, separated by commas or lines."
              className="min-h-10"
              value={state.to}
              disabled={pending}
              error={problemOf("to")}
              onChange={(event) => {
                patch({ to: event.target.value });
              }}
            />
          </div>
          {privateSwitch}
        </div>
      ) : (
        <Alert kind="info">
          The in-app channel stores each event for the bell in the top bar.
          Owner and admins see every event; editors and viewers see those of the
          servers they may see.
        </Alert>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 flex w-full flex-wrap items-center justify-between gap-2 text-sm font-medium text-fg">
          <span>Events to send</span>
          <span className="flex gap-1">
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() => {
                patch({ types: [...ACTIVITY_TYPES] });
              }}
            >
              All
            </Button>
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() => {
                patch({ types: [] });
              }}
            >
              None
            </Button>
          </span>
        </legend>
        {problemOf("types") !== undefined ? (
          <p role="alert" className="text-sm text-error">
            {problemOf("types")}
          </p>
        ) : null}
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {ACTIVITY_TYPES.map((type) => (
            <li key={type}>
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm hover:bg-accent-soft",
                )}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--dw-primary)]"
                  checked={state.types.includes(type)}
                  disabled={pending}
                  onChange={() => {
                    toggleType(type);
                  }}
                />
                {TYPE_WORDS[type]}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending}>
          {editing ? "Save channel" : "Create channel"}
        </Button>
      </div>
    </form>
  );
}
