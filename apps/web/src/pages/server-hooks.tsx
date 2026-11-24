// The hooks page of a server (dev-work-plan P6-C step 1, contract C7): the
// live status from the probe, the control hook (the pack's own protocol
// only, an SSH command, or a docker socket proxy with its container label),
// the per-probe overrides (host, port, password), and the four actions with
// the client that runs each. The owner or an admin configures; an editor
// triggers; a viewer looks. Hooks and status are always Free (contract C1).
/* eslint-disable security/detect-object-injection -- the keys are the four hook actions and the pack's probe kinds from the server's own JSON answer, never free-form input */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  Container,
  Play,
  Plug,
  Power,
  RefreshCw,
  RotateCw,
  Save,
  Square,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { putHooks, runHook } from "../api/changes";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import {
  hooksQuery,
  p6keys,
  serverQuery,
  serverStatusQuery,
} from "../api/queries";
import type {
  HookAction,
  HookConfig,
  HooksView,
  ProbeInput,
  ProbeOverrideView,
  RunAnswer,
  Server,
} from "../api/schema";
import { useCanConfigureHooks, useCanRunHooks } from "../api/session";
import { PageHeader } from "../components/layout/page-header";
import { PendingBadge } from "../components/pending-badge";
import { ServerTabs } from "../components/server-tabs";
import { StatusChip } from "../components/status-chip";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/dialog";
import { PasswordField, TextField } from "../components/ui/field";
import { ErrorState, RowsSkeleton } from "../components/ui/states";
import { useToast } from "../components/ui/toast";
import { formatDateTime } from "../lib/format";

type HookKind = "none" | "sshCommand" | "dockerProxy";

const OPTION =
  "flex cursor-pointer gap-3 rounded-control border border-border-strong bg-surface p-3 has-[:checked]:border-primary has-[:checked]:bg-accent-soft has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";

/** The plain words of a client kind, for badges and sentences. */
export function sourceWord(source: string): string {
  switch (source) {
    case "palworldRest":
      return "Palworld REST API";
    case "sourceRcon":
      return "RCON";
    case "rustWebRcon":
      return "WebRCON";
    case "telnet7dtd":
      return "telnet";
    case "a2s":
      return "A2S query";
    case "sshCommand":
      return "SSH command";
    case "dockerProxy":
      return "docker proxy";
    default:
      return source;
  }
}

/** One sentence for a 422 of PUT hooks (routes/hooks.ts), else the default. */
export function hooksErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const kind =
      typeof error.body?.["kind" as keyof typeof error.body] === "string"
        ? String(error.body?.["kind" as keyof typeof error.body])
        : "";
    switch (error.code) {
      case "hook_needs_sftp":
        return "An SSH command hook needs a server connected over SFTP with a pinned host key.";
      case "hook_command_not_usable":
        return "The hook is not usable: one line under 2000 characters for the command, or an http or https proxy address with no path and a label like key or key=value.";
      case "unknown_probe":
        return `This pack has no ${kind} probe.`;
      case "probe_host_not_usable":
        return "The probe host must be an IP address or a DNS name.";
      case "probe_port_not_usable":
        return "The probe port must be between 1 and 65535.";
      case "probe_password_not_usable":
        return "The probe password must be one line.";
      case "hook_not_configured":
        return "No hook can run this action. Set one up first.";
      case "control_error":
      case "connector_error": {
        const message = error.body?.["message" as keyof typeof error.body];
        return typeof message === "string"
          ? `The server could not be reached: ${message}.`
          : "The server could not be reached.";
      }
      default:
        break;
    }
  }
  return errorMessage(error);
}

const ACTION_WORDS: Readonly<
  Record<HookAction, { label: string; icon: LucideIcon; sentence: string }>
> = {
  save: {
    label: "Save",
    icon: Save,
    sentence: "Asks the game to write its world and reload live settings.",
  },
  stop: {
    label: "Stop",
    icon: Square,
    sentence:
      "Stops the game; pending changes are written once it is seen stopped.",
  },
  start: {
    label: "Start",
    icon: Play,
    sentence: "Starts the game again after a stop.",
  },
  restart: {
    label: "Restart",
    icon: RotateCw,
    sentence: "Stops and starts the game in one go.",
  },
};

function kindOf(hook: HookConfig | null): HookKind {
  return hook === null ? "none" : hook.kind;
}

function HookForm({
  slug,
  view,
  canConfigure,
  server,
}: {
  slug: string;
  view: HooksView;
  canConfigure: boolean;
  server: Server;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<HookKind>(kindOf(view.hook));
  const [command, setCommand] = useState(
    view.hook?.kind === "sshCommand" ? view.hook.command : "",
  );
  const [url, setUrl] = useState(
    view.hook?.kind === "dockerProxy" ? view.hook.url : "",
  );
  const [label, setLabel] = useState(
    view.hook?.kind === "dockerProxy" ? view.hook.containerLabel : "",
  );
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      let hook: HookConfig | null = null;
      if (kind === "sshCommand") hook = { kind, command: command.trim() };
      if (kind === "dockerProxy") {
        hook = { kind, url: url.trim(), containerLabel: label.trim() };
      }
      return putHooks(slug, { hook });
    },
    onSuccess: (next) => {
      setProblem(null);
      client.setQueryData(p6keys.hooks(slug), next);
      void client.invalidateQueries({ queryKey: p6keys.status(slug) });
      toast.push({
        kind: "success",
        title: "Hook saved",
        description:
          kind === "none"
            ? "Only the pack's own protocol is used from now on."
            : "The hook is set; the actions below show what it can run.",
      });
    },
    onError: (error) => {
      setProblem(hooksErrorMessage(error));
    },
  });

  const sftp = server.connector.kind === "sftp";
  const packWords =
    view.hooksSupported.length === 0
      ? "This pack offers no protocol action of its own, so a hook is the only way to stop or start the server from here."
      : `The pack's own protocol can ${view.hooksSupported.join(" and ")} the game; a hook adds the rest.`;

  return (
    <Card
      title="Control hook"
      description="How Dialwarden stops and starts this server. One fixed action per hook; nothing typed here reaches the game as a command."
    >
      {canConfigure ? null : (
        <Alert kind="info">
          Only the owner or an admin changes the hook. Editors can run the
          actions below.
        </Alert>
      )}
      {problem !== null ? <Alert kind="error">{problem}</Alert> : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-fg">Hook kind</legend>
        <label className={OPTION}>
          <input
            type="radio"
            name="hook-kind"
            value="none"
            className="mt-1 accent-primary"
            checked={kind === "none"}
            disabled={!canConfigure}
            onChange={() => {
              setKind("none");
            }}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium text-fg">
              <Plug className="size-4 shrink-0" aria-hidden="true" />
              Pack protocol only
            </span>
            <span className="text-sm text-fg-muted">{packWords}</span>
          </span>
        </label>
        <label className={OPTION}>
          <input
            type="radio"
            name="hook-kind"
            value="sshCommand"
            className="mt-1 accent-primary"
            checked={kind === "sshCommand"}
            disabled={!canConfigure}
            onChange={() => {
              setKind("sshCommand");
            }}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium text-fg">
              <Terminal className="size-4 shrink-0" aria-hidden="true" />
              SSH command
            </span>
            <span className="text-sm text-fg-muted">
              One fixed restart command, run over the server&apos;s own SFTP
              connection with its pinned host key.
              {sftp ? "" : " This server is not connected over SFTP."}
            </span>
          </span>
        </label>
        <label className={OPTION}>
          <input
            type="radio"
            name="hook-kind"
            value="dockerProxy"
            className="mt-1 accent-primary"
            checked={kind === "dockerProxy"}
            disabled={!canConfigure}
            onChange={() => {
              setKind("dockerProxy");
            }}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium text-fg">
              <Container className="size-4 shrink-0" aria-hidden="true" />
              Docker socket proxy
            </span>
            <span className="text-sm text-fg-muted">
              Stops, starts and restarts the one container that carries a label,
              through a docker-socket-proxy you run. Dialwarden never mounts the
              Docker socket itself.
            </span>
          </span>
        </label>
      </fieldset>
      {kind === "sshCommand" ? (
        <TextField
          id="hook-command"
          label="Restart command"
          help="One line, run as the SFTP user. It is the only thing ever sent; nothing is appended at run time."
          className="font-mono"
          value={command}
          disabled={!canConfigure}
          onChange={(event) => {
            setCommand(event.target.value);
          }}
        />
      ) : null}
      {kind === "dockerProxy" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="hook-url"
            label="Proxy address"
            help="http or https, no path, no credentials."
            placeholder="http://docker-proxy:2375"
            className="font-mono"
            value={url}
            disabled={!canConfigure}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
          <TextField
            id="hook-label"
            label="Container label"
            help="key or key=value; exactly one container must carry it."
            placeholder="dialwarden.server=valheim"
            className="font-mono"
            value={label}
            disabled={!canConfigure}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-fg-muted">
          {view.updatedAt === null
            ? "No hook has been set for this server yet."
            : `Last changed ${formatDateTime(view.updatedAt)} by ${
                view.updatedBy ?? "someone"
              }.`}
        </span>
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={
            !canConfigure ||
            (kind === "sshCommand" && command.trim() === "") ||
            (kind === "dockerProxy" &&
              (url.trim() === "" || label.trim() === ""))
          }
          onClick={() => {
            save.mutate();
          }}
        >
          Save hook
        </Button>
      </div>
    </Card>
  );
}

function ProbeForm({
  slug,
  probe,
  canConfigure,
  local,
}: {
  slug: string;
  probe: ProbeOverrideView;
  canConfigure: boolean;
  local: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [host, setHost] = useState(probe.host ?? "");
  const [port, setPort] = useState(
    probe.port === null ? "" : String(probe.port),
  );
  const [probeSecret, setProbeSecret] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const id = `probe-${probe.kind}`;

  const save = useMutation({
    mutationFn: (clear: boolean) => {
      if (clear) return putHooks(slug, { probes: { [probe.kind]: null } });
      const input: { host?: string; port?: number; password?: string } = {};
      if (host.trim() !== "") input.host = host.trim();
      if (port.trim() !== "") input.port = Number(port);
      if (probeSecret !== "") input.password = probeSecret;
      const body: ProbeInput = input;
      return putHooks(slug, { probes: { [probe.kind]: body } });
    },
    onSuccess: (next, clear) => {
      setProblem(null);
      setProbeSecret("");
      if (clear) {
        setHost("");
        setPort("");
      }
      client.setQueryData(p6keys.hooks(slug), next);
      void client.invalidateQueries({ queryKey: p6keys.status(slug) });
      toast.push({
        kind: "success",
        title: clear ? "Override cleared" : "Probe saved",
        description: clear
          ? "The probe reads the server connection and the pack again."
          : "The next status check uses these values.",
      });
    },
    onError: (error) => {
      setProblem(hooksErrorMessage(error));
    },
  });

  const portNumber = Number(port);
  const portBad =
    port.trim() !== "" &&
    (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535);
  const overridden =
    probe.host !== null || probe.port !== null || probe.hasPassword;

  return (
    <div className="flex flex-col gap-4 rounded-control border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium text-fg">
          {sourceWord(probe.kind)} probe
          {overridden ? (
            <Badge kind="info">Overridden</Badge>
          ) : (
            <Badge kind="neutral">Pack values</Badge>
          )}
        </span>
        {probe.hasPassword ? (
          <Badge kind="neutral">Password stored</Badge>
        ) : null}
      </div>
      {local && probe.host === null ? (
        <Alert kind="info">
          A server on a local folder has no host of its own: set the host the
          game listens on, or the probe answers unknown.
        </Alert>
      ) : null}
      {problem !== null ? <Alert kind="error">{problem}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          id={`${id}-host`}
          label="Host"
          help="Leave empty to use the server connection's host."
          placeholder="game.example.net"
          value={host}
          disabled={!canConfigure}
          onChange={(event) => {
            setHost(event.target.value);
          }}
        />
        <TextField
          id={`${id}-port`}
          label="Port"
          help="Leave empty to read it from the game's own settings."
          type="number"
          min={1}
          max={65_535}
          value={port}
          error={portBad ? "Between 1 and 65535." : undefined}
          disabled={!canConfigure}
          onChange={(event) => {
            setPort(event.target.value);
          }}
        />
        <PasswordField
          id={`${id}-password`}
          label="Password"
          help={
            probe.hasPassword
              ? "Leave empty to keep the stored one."
              : "Leave empty to read it from the game's own settings."
          }
          autoComplete="off"
          value={probeSecret}
          placeholder={probe.hasPassword ? "Unchanged" : undefined}
          disabled={!canConfigure}
          onChange={(event) => {
            setProbeSecret(event.target.value);
          }}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          disabled={!canConfigure || !overridden}
          loading={save.isPending && save.variables === true}
          onClick={() => {
            save.mutate(true);
          }}
        >
          Clear override
        </Button>
        <Button
          variant="primary"
          disabled={!canConfigure || portBad}
          loading={save.isPending && save.variables === false}
          onClick={() => {
            save.mutate(false);
          }}
        >
          Save probe
        </Button>
      </div>
    </div>
  );
}

function ActionTile({
  action,
  source,
  canRun,
  running,
  onRun,
}: {
  action: HookAction;
  source: string | null;
  canRun: boolean;
  running: boolean;
  onRun: (action: HookAction) => void;
}) {
  const words = ACTION_WORDS[action];
  const Icon = words.icon;
  return (
    <li className="flex flex-col gap-2 rounded-control border border-border p-4">
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium text-fg">
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {words.label}
        </span>
        {source === null ? (
          <Badge kind="neutral">Not available</Badge>
        ) : (
          <Badge kind="success">{sourceWord(source)}</Badge>
        )}
      </span>
      <span className="text-sm text-fg-muted">{words.sentence}</span>
      <Button
        className="self-start"
        disabled={!canRun || source === null}
        loading={running}
        onClick={() => {
          onRun(action);
        }}
      >
        Run {words.label.toLowerCase()}
      </Button>
    </li>
  );
}

function runWords(answer: RunAnswer): { title: string; description: string } {
  const label = ACTION_WORDS[answer.action].label;
  if (answer.action !== "stop") {
    return {
      title: `${label} ran`,
      description: `Through the ${sourceWord(answer.source)}, at ${formatDateTime(answer.at)}.`,
    };
  }
  if (answer.stopped === true) {
    const flushed = answer.flushed ?? 0;
    return {
      title: "Server stopped",
      description:
        flushed === 0
          ? "No pending change was waiting for it."
          : `${flushed} pending ${flushed === 1 ? "change was" : "changes were"} written.`,
    };
  }
  return {
    title: "Stop sent",
    description:
      "The probe did not see the server stopped within the wait; pending changes are written at the next status check that does.",
  };
}

export function ServerHooksPage() {
  const params = useParams({ strict: false }) as { slug: string };
  const slug = params.slug;
  const client = useQueryClient();
  const toast = useToast();
  const server = useQuery(serverQuery(slug));
  const hooks = useQuery(hooksQuery(slug));
  const status = useQuery(serverStatusQuery(slug));
  const canConfigure = useCanConfigureHooks();
  const canRun = useCanRunHooks();
  const [confirming, setConfirming] = useState<HookAction | null>(null);

  // The hook form starts from the stored configuration; a fresh answer that
  // changes the stored hook resets it (the key remounts the form). A save of
  // one probe leaves the hook card and the sibling probe cards as typed.
  const hookKey = JSON.stringify(hooks.data?.hook ?? null);

  const run = useMutation({
    mutationFn: (action: HookAction) => runHook(slug, action),
    onSuccess: (answer) => {
      toast.push({ kind: "success", ...runWords(answer) });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The hook did not run",
        description: hooksErrorMessage(error),
      });
    },
    onSettled: () => {
      setConfirming(null);
      void client.invalidateQueries({ queryKey: p6keys.status(slug) });
      void client.invalidateQueries({ queryKey: p6keys.pending(slug) });
      void client.invalidateQueries({ queryKey: p6keys.hooks(slug) });
      void client.invalidateQueries({ queryKey: ["activity"] });
    },
  });

  if (server.isPending || hooks.isPending) {
    return (
      <>
        <PageHeader title="Hooks" description="Loading the hook settings…" />
        <RowsSkeleton rows={5} />
      </>
    );
  }

  if (server.isError || hooks.isError) {
    return (
      <>
        <PageHeader
          title="Hooks"
          description="How Dialwarden checks, stops and starts this server."
        />
        <ErrorState
          message={
            server.isError
              ? "This server could not be loaded."
              : hooksErrorMessage(hooks.error)
          }
          onRetry={() => {
            void server.refetch();
            void hooks.refetch();
          }}
        />
      </>
    );
  }

  const view = hooks.data;
  const data = server.data;
  let statusBody: ReactNode;
  if (status.isError) {
    statusBody = (
      <Alert kind="info">
        The status could not be checked: {hooksErrorMessage(status.error)}
      </Alert>
    );
  } else if (status.data !== undefined) {
    statusBody = (
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">
            Checked
          </dt>
          <dd className="text-fg">{formatDateTime(status.data.at)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">
            Answered by
          </dt>
          <dd className="text-fg">
            {status.data.source === null
              ? "No probe"
              : sourceWord(status.data.source)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium tracking-wide text-fg-muted uppercase">
            Players
          </dt>
          <dd className="text-fg">
            {status.data.players === null
              ? "Not reported"
              : String(status.data.players)}
          </dd>
        </div>
      </dl>
    );
  }

  return (
    <>
      <PageHeader
        title={`${data.name} hooks`}
        description="How Dialwarden checks, stops and starts this server. Always part of the Free plan."
      />
      <ServerTabs slug={slug} current="hooks" />
      <div className="flex flex-col gap-6">
        <Card
          title="Server status"
          description="What the probe reports right now."
          aside={
            <Button
              loading={status.isFetching}
              icon={<RefreshCw className="size-4" aria-hidden="true" />}
              onClick={() => {
                void status.refetch();
              }}
            >
              Check now
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              status={status.data}
              loading={status.isPending}
              error={status.error ?? undefined}
              simulated={data.demo}
            />
            <PendingBadge count={status.data?.pending ?? 0} slug={slug} />
          </div>
          {statusBody}
          {data.demo ? (
            <p className="text-sm text-fg-muted">
              This is a demo server seeded with synthetic files: its status and
              hooks are simulated, never a real game.
            </p>
          ) : null}
        </Card>
        <HookForm
          key={hookKey}
          slug={slug}
          view={view}
          canConfigure={canConfigure}
          server={data}
        />
        {view.probes.length > 0 ? (
          <Card
            title="Status probes"
            description="The pack's probes read the game's state. Each takes the host of the server connection and the port and password from the game's own settings, unless set here."
          >
            {view.probes.map((probe) => (
              <ProbeForm
                key={`${probe.kind}-${probe.host ?? ""}-${probe.port ?? ""}-${probe.hasPassword ? "secret" : "open"}`}
                slug={slug}
                probe={probe}
                canConfigure={canConfigure}
                local={data.connector.kind === "local"}
              />
            ))}
          </Card>
        ) : (
          <Card
            title="Status probes"
            description="This pack declares no status probe, so the status comes from the hook alone."
          >
            <p className="text-sm text-fg-muted">
              A docker socket proxy hook reports the container state; an SSH
              command hook reports nothing, so the status stays unknown.
            </p>
          </Card>
        )}
        <Card
          title="Actions"
          description="What can run today, and through which client. Running an action is always confirmed first."
        >
          {canRun ? null : (
            <Alert kind="info">
              A viewer can see the actions; running one needs the editor role or
              above.
            </Alert>
          )}
          <ul className="grid gap-3 sm:grid-cols-2">
            {(["save", "stop", "start", "restart"] as const).map((action) => (
              <ActionTile
                key={action}
                action={action}
                source={view.available[action]}
                canRun={canRun}
                running={run.isPending && run.variables === action}
                onRun={setConfirming}
              />
            ))}
          </ul>
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Power className="size-3.5 shrink-0" aria-hidden="true" />
            Every run is recorded on the Activity page, whether it worked or
            not.
          </p>
        </Card>
      </div>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={
          confirming === null
            ? ""
            : `Run the ${ACTION_WORDS[confirming].label.toLowerCase()} hook?`
        }
        description={
          confirming === null
            ? ""
            : `${ACTION_WORDS[confirming].sentence} The game and its players feel it at once.`
        }
        confirmLabel={
          confirming === null
            ? "Run"
            : `Run ${ACTION_WORDS[confirming].label.toLowerCase()}`
        }
        destructive={confirming === "stop" || confirming === "restart"}
        loading={run.isPending}
        onConfirm={() => {
          if (confirming !== null) run.mutate(confirming);
        }}
      />
    </>
  );
}
