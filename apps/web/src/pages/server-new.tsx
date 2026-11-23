// The add-server wizard (screen 2 of dev-work-plan P5): the connector choice
// (Local or SFTP, the password option of panel SFTP), this instance's public
// key with a copy button, the connection test, the host-key fingerprint
// confirm and the game detection. The launch source step is designed but
// filled in by P6. Adding a server is owner only (the server enforces it).
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  Copy,
  Gamepad2,
  HardDrive,
  KeyRound,
  Loader2,
  Plus,
  Rocket,
  ScanSearch,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import {
  addServer,
  confirmHostKey,
  detectGames,
  testConnection,
} from "../api/changes";
import { errorMessage } from "../api/errors";
import { instanceKeyQuery } from "../api/queries";
import type { ConnectionSpec, Detection, TestResult } from "../api/schema";
import { useIsOwner } from "../api/session";
import { PageHeader } from "../components/layout/page-header";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PasswordField, TextField } from "../components/ui/field";
import { SwitchField } from "../components/ui/switch";
import { EmptyState } from "../components/ui/states";
import { useToast } from "../components/ui/toast";
import { cn } from "../lib/cn";

const STEP_ICON = "size-5 shrink-0";

/** One numbered step of the wizard: a header and the step's body. */
function Step({
  number,
  icon,
  title,
  done,
  children,
}: {
  number: number;
  icon: React.ReactNode;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-6">
      <h2 className="mb-4 flex items-center gap-3 font-heading text-lg font-semibold text-fg">
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-full border text-sm font-semibold",
            done
              ? "border-success/40 bg-success-soft text-success"
              : "border-border bg-accent-soft text-primary",
          )}
        >
          {done ? <Check className="size-4" aria-hidden="true" /> : number}
        </span>
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function CopyKey({ publicKey }: { publicKey: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      toast.push({
        kind: "error",
        title: "The key could not be copied",
        description: "Select the key text and copy it by hand.",
      });
    }
  };
  return (
    <Button
      icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      onClick={() => {
        void copy();
      }}
    >
      {copied ? "Copied" : "Copy key"}
    </Button>
  );
}

export function NewServerPage() {
  const isOwner = useIsOwner();
  const navigate = useNavigate();
  const toast = useToast();
  const key = useQuery(instanceKeyQuery());

  const [name, setName] = useState("");
  const [kind, setKind] = useState<"local" | "sftp">("local");
  const [root, setRoot] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("");
  const [panel, setPanel] = useState(false);
  const [password, setPassword] = useState("");

  const [tested, setTested] = useState<TestResult | null>(null);
  const [keyTrusted, setKeyTrusted] = useState(false);
  const [detected, setDetected] = useState<readonly Detection[] | null>(null);
  const [packId, setPackId] = useState<string | null>(null);

  const portNumber = Number(port);
  const portOk =
    Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const connectionReady =
    name.trim() !== "" &&
    (kind === "local"
      ? root.trim() !== ""
      : host.trim() !== "" &&
        username.trim() !== "" &&
        portOk &&
        (!panel || password !== ""));
  const isSftp = kind === "sftp";
  const keyConfirmed =
    !isSftp ||
    tested?.ok !== true ||
    tested.hostKey?.status === "pinned" ||
    keyTrusted;

  const spec = (): ConnectionSpec | null => {
    if (!connectionReady) {
      return null;
    }
    if (kind === "local") {
      return { kind: "local", root: root.trim() };
    }
    const base = {
      kind: "sftp" as const,
      host: host.trim(),
      port: portNumber,
      username: username.trim(),
      root: remoteRoot.trim(),
      panel,
    };
    return panel ? { ...base, password } : base;
  };

  const test = useMutation({
    mutationFn: (value: ConnectionSpec) => testConnection(value),
    onSuccess: (result) => {
      setTested(result);
      setKeyTrusted(false);
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The connection test failed",
        description: errorMessage(error),
      });
    },
  });

  const confirmKey = useMutation({
    mutationFn: (replace: boolean) =>
      confirmHostKey(
        host.trim(),
        portNumber,
        tested?.hostKey?.fingerprint ?? "",
        replace,
      ),
    onSuccess: () => {
      setKeyTrusted(true);
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The host key was not confirmed",
        description: errorMessage(error),
      });
    },
  });

  const detect = useMutation({
    mutationFn: (value: ConnectionSpec) => detectGames(value),
    onSuccess: (result) => {
      setDetected(result.items);
      if (result.items.length === 1) {
        setPackId(result.items[0]?.packId ?? null);
      }
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The game detection failed",
        description: errorMessage(error),
      });
    },
  });

  const add = useMutation({
    mutationFn: (value: { spec: ConnectionSpec; packId: string | null }) =>
      addServer({
        name: name.trim(),
        connector: value.spec,
        ...(value.packId === null ? {} : { packId: value.packId }),
      }),
    onSuccess: (server) => {
      toast.push({ kind: "success", title: `${server.name} added` });
      void navigate({
        to: "/servers/$slug/settings",
        params: { slug: server.id },
      });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The server was not added",
        description: errorMessage(error),
      });
    },
  });

  if (!isOwner) {
    return (
      <>
        <PageHeader
          title="Add server"
          description="Connect a game server folder to Dialwarden."
        />
        <EmptyState
          icon={<Server className="size-6" aria-hidden="true" />}
          title="Owner only"
          description="Only the owner can add servers. Ask them to connect this server."
        />
      </>
    );
  }

  const hostKeyState = tested?.hostKey;

  return (
    <>
      <PageHeader
        title="Add server"
        description="Connect a game server folder to Dialwarden. Dialwarden only reads and writes setting files; it never runs the server itself."
      />
      <div className="flex max-w-3xl flex-col gap-4">
        <Step
          number={1}
          icon={<HardDrive className={STEP_ICON} aria-hidden="true" />}
          title="Name and connector"
          done={connectionReady && tested?.ok === true}
        >
          <div className="flex flex-col gap-4">
            <TextField
              id="new-name"
              label="Server name"
              help="Shown on the fleet wall. The address comes from the slug made of this name."
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-fg">Connector</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-control border p-3",
                    kind === "local"
                      ? "border-primary bg-accent-soft"
                      : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name="connector-kind"
                    className="mt-1 size-4 accent-[var(--dw-primary)]"
                    checked={kind === "local"}
                    onChange={() => {
                      setKind("local");
                      setTested(null);
                    }}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg">
                      Local folder
                    </span>
                    <span className="text-xs text-fg-muted">
                      A folder on this machine, for example a container mount.
                    </span>
                  </span>
                </label>
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-control border p-3",
                    kind === "sftp"
                      ? "border-primary bg-accent-soft"
                      : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name="connector-kind"
                    className="mt-1 size-4 accent-[var(--dw-primary)]"
                    checked={kind === "sftp"}
                    onChange={() => {
                      setKind("sftp");
                      setTested(null);
                    }}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg">SFTP</span>
                    <span className="text-xs text-fg-muted">
                      A remote server over SFTP, with the host key confirmed.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
            {kind === "local" ? (
              <TextField
                id="new-root"
                label="Server folder"
                help="The absolute path of the server folder on this machine."
                placeholder="/data/palworld"
                value={root}
                onChange={(event) => {
                  setRoot(event.target.value);
                }}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    id="new-host"
                    label="Host"
                    placeholder="sftp.example.com"
                    value={host}
                    onChange={(event) => {
                      setHost(event.target.value);
                    }}
                  />
                  <TextField
                    id="new-port"
                    label="Port"
                    type="number"
                    value={port}
                    error={portOk ? undefined : "Port must be 1 to 65535"}
                    onChange={(event) => {
                      setPort(event.target.value);
                    }}
                  />
                </div>
                <TextField
                  id="new-username"
                  label="User name"
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value);
                  }}
                />
                <TextField
                  id="new-remote-root"
                  label="Server folder"
                  help="The path of the server folder on the remote host."
                  value={remoteRoot}
                  onChange={(event) => {
                    setRemoteRoot(event.target.value);
                  }}
                />
                <SwitchField
                  id="new-panel"
                  label="Panel SFTP with a password"
                  description="Only for SFTP panels that take a password instead of a key."
                  checked={panel}
                  onCheckedChange={(next) => {
                    setPanel(next);
                    setTested(null);
                  }}
                />
                {panel ? (
                  <PasswordField
                    id="new-password"
                    label="Panel password"
                    help="Stored for this server and never shown again."
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                    }}
                  />
                ) : null}
                {key.data === undefined ? null : (
                  <div className="flex flex-col gap-2 rounded-control border border-border bg-accent-soft p-3">
                    <span className="flex items-center gap-2 text-sm font-medium text-fg">
                      <KeyRound
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                      This instance's public key
                    </span>
                    <pre className="max-h-24 overflow-auto rounded-control bg-surface p-2 font-mono text-xs break-all whitespace-pre-wrap">
                      {key.data.publicKey}
                    </pre>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-fg-muted">
                        {key.data.fingerprint}
                      </span>
                      <CopyKey publicKey={key.data.publicKey} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Step>

        <Step
          number={2}
          icon={<ShieldCheck className={STEP_ICON} aria-hidden="true" />}
          title="Connect and host key"
          done={tested?.ok === true && keyConfirmed}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                loading={test.isPending}
                disabled={!connectionReady}
                icon={<Loader2 className="size-4" aria-hidden="true" />}
                onClick={() => {
                  const value = spec();
                  if (value !== null) {
                    test.mutate(value);
                  }
                }}
              >
                Test connection
              </Button>
              {tested === null ? (
                <span className="text-sm text-fg-muted">Not tested yet.</span>
              ) : tested.ok === true ? (
                <Badge kind="success">
                  Connected to {tested.root ?? "the folder"}
                </Badge>
              ) : (
                <Badge kind="error">
                  {tested.message ?? "The connection failed"}
                </Badge>
              )}
            </div>
            {tested?.ok === true &&
            isSftp &&
            hostKeyState !== undefined &&
            hostKeyState.status !== "pinned" ? (
              <Alert kind="warning">
                <p className="font-medium">
                  Confirm the host key of {host}:{port}
                </p>
                <p className="mt-1 font-mono text-xs break-all">
                  {hostKeyState.algorithm} {hostKeyState.fingerprint}
                </p>
                <p className="mt-1 text-sm">
                  {hostKeyState.status === "changed"
                    ? "The host key changed since it was last confirmed. Check that you trust this machine before trusting the new key."
                    : "This host is not confirmed yet. Check the fingerprint out of band before trusting it."}
                </p>
                <div className="mt-3">
                  <Button
                    variant="primary"
                    loading={confirmKey.isPending}
                    onClick={() => {
                      confirmKey.mutate(hostKeyState.status === "changed");
                    }}
                  >
                    {hostKeyState.status === "changed"
                      ? "Trust the new key"
                      : "Trust this key"}
                  </Button>
                </div>
              </Alert>
            ) : null}
            {tested?.ok === true && keyConfirmed ? (
              <Button
                variant="primary"
                loading={detect.isPending}
                icon={<ScanSearch className="size-4" aria-hidden="true" />}
                onClick={() => {
                  const value = spec();
                  if (value !== null) {
                    detect.mutate(value);
                  }
                }}
              >
                Detect the game
              </Button>
            ) : null}
          </div>
        </Step>

        <Step
          number={3}
          icon={<Gamepad2 className={STEP_ICON} aria-hidden="true" />}
          title="Game"
          done={packId !== null}
        >
          {detected === null ? (
            <p className="text-sm text-fg-muted">
              The game is detected from the server folder after the connection
              test.
            </p>
          ) : detected.length === 0 ? (
            <Alert kind="error">
              No known game was found in the folder. Check that it holds the
              server files of a supported game.
            </Alert>
          ) : (
            <div className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-fg">
                  Detected games
                </legend>
                {detected.map((item) => (
                  <label
                    key={item.packId}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-control border p-3",
                      packId === item.packId
                        ? "border-primary bg-accent-soft"
                        : "border-border",
                    )}
                  >
                    <input
                      type="radio"
                      name="detected-pack"
                      className="mt-1 size-4 accent-[var(--dw-primary)]"
                      checked={packId === item.packId}
                      onChange={() => {
                        setPackId(item.packId);
                      }}
                    />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium text-fg">
                        {item.displayName}
                      </span>
                      <span className="text-xs text-fg-muted">
                        Found by{" "}
                        {item.by === "appmanifest"
                          ? "the Steam app manifest"
                          : "file markers"}
                        {item.os !== null ? ` · ${item.os}` : ""}
                      </span>
                      {item.warnings.map((warning) => (
                        <span key={warning} className="text-xs text-warning">
                          {warning}
                        </span>
                      ))}
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>
          )}
        </Step>

        <Step
          number={4}
          icon={<Rocket className={STEP_ICON} aria-hidden="true" />}
          title="Launch source"
          done={false}
        >
          <p className="text-sm text-fg-muted">
            The launch source — how Dialwarden starts and stops this server —
            arrives with phase P6. Adding the server now is safe: settings can
            be edited and saved by hand from day one.
          </p>
        </Step>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="lg"
            loading={add.isPending}
            disabled={tested?.ok !== true || !keyConfirmed || packId === null}
            icon={<Plus className="size-4" aria-hidden="true" />}
            onClick={() => {
              const value = spec();
              if (value !== null) {
                add.mutate({ spec: value, packId });
              }
            }}
          >
            Add server
          </Button>
          <span className="text-sm text-fg-muted">
            {tested?.ok === true && packId !== null
              ? `Adds ${name.trim() || "the server"} to the fleet.`
              : "Test the connection and detect the game first."}
          </span>
        </div>
      </div>
    </>
  );
}
