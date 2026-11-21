// First-run setup (POST /api/v1/setup): the owner account, with the one-time
// setup token the server printed at start. Below it, the optional import of an
// app backup export (POST /api/v1/setup/import), which restores the whole
// instance on an empty data folder instead of creating a new owner.
import * as Collapsible from "@radix-ui/react-collapsible";
import * as Progress from "@radix-ui/react-progress";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDown, DatabaseBackup } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { errorMessage, fieldErrors } from "../api/errors";
import { keys } from "../api/queries";
import type { SignedIn } from "../api/schema";
import { rememberSession } from "../api/session";
import { uploadImport } from "../api/upload";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { PasswordField, TextField } from "../components/ui/field";
import { useToast } from "../components/ui/toast";
import { AuthFrame } from "./auth-frame";

const MIN_PASSWORD = 12;
const MIN_PASSPHRASE = 12;
const TOKEN_HELP =
  "Printed in the server log at every start until an owner exists, and stored in DATA_DIR/setup-token.";
const IMPORT_TEXT =
  "Upload the export file of another Dialwarden instance. The data folder must be empty, and the setup token above is needed too.";
const ICON = "size-4 text-primary";

function tokenError(error: unknown): string | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  if (
    error.code === "setup_token_required" ||
    error.code === "setup_token_invalid"
  ) {
    return errorMessage(error);
  }
  return null;
}

export function SetupPage() {
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");
  const [again, setAgain] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [fields, setFields] = useState<Map<string, string>>(new Map());

  const [importOpen, setImportOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [importFailure, setImportFailure] = useState<string | null>(null);

  const mismatch = again !== "" && first !== again;
  const ready =
    name.trim() !== "" &&
    email.trim() !== "" &&
    first.length >= MIN_PASSWORD &&
    first === again &&
    setupKey.trim() !== "";

  const createOwner = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFields(new Map());
    try {
      const session = await api<SignedIn>("/api/v1/setup", {
        method: "POST",
        headers: { "x-dialwarden-setup-token": setupKey.trim() },
        body: { name: name.trim(), email: email.trim(), password: first },
      });
      rememberSession(client, session);
      client.setQueryData(keys.setup, { required: false });
      toast.push({
        kind: "success",
        title: `Welcome, ${session.user.name}`,
        description: "The owner account is ready. Add your first server next.",
      });
      await router.navigate({ to: "/" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "setup_done") {
        setDone(true);
      } else {
        const issues = fieldErrors(error);
        const forToken = tokenError(error);
        if (forToken !== null) {
          issues.set("setupToken", forToken);
        }
        setFields(issues);
        if (issues.size === 0) {
          setFailure(errorMessage(error));
        }
      }
      setBusy(false);
    }
  };

  const importBackup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (file === null) {
      return;
    }
    setProgress(0);
    setImportFailure(null);
    try {
      const result = await uploadImport(
        file,
        passphrase,
        setupKey.trim(),
        setProgress,
      );
      client.setQueryData(keys.setup, { required: false });
      toast.push({
        kind: "success",
        title: "Backup imported",
        description: `Data from ${result.createdAt} is in place. Sign in with the owner account it contains.`,
      });
      await router.navigate({ to: "/login" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "setup_done") {
        setDone(true);
      } else {
        setImportFailure(errorMessage(error));
      }
      setProgress(null);
    }
  };

  if (done) {
    return (
      <AuthFrame title="Setup is done">
        <Alert
          kind="info"
          action={
            <Link to="/login" className="font-medium">
              Go to the sign-in page
            </Link>
          }
        >
          This instance already has an owner account.
        </Alert>
      </AuthFrame>
    );
  }

  const uploading = progress !== null;

  return (
    <AuthFrame
      title="Set up Dialwarden"
      description="Create the owner account of this instance. You can invite teammates later."
      wide
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void createOwner(event);
        }}
        noValidate
      >
        {failure !== null ? <Alert kind="error">{failure}</Alert> : null}
        <TextField
          id="setup-name"
          label="Your name"
          autoComplete="name"
          required
          value={name}
          error={fields.get("name")}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <TextField
          id="setup-email"
          label="E-mail address"
          type="email"
          autoComplete="username"
          required
          value={email}
          error={fields.get("email")}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <PasswordField
          id="setup-password"
          label="Password"
          help={`At least ${MIN_PASSWORD} characters.`}
          autoComplete="new-password"
          required
          value={first}
          error={fields.get("password")}
          onChange={(event) => {
            setFirst(event.target.value);
          }}
        />
        <PasswordField
          id="setup-password-again"
          label="Password again"
          autoComplete="new-password"
          required
          value={again}
          error={mismatch ? "The two passwords differ." : undefined}
          onChange={(event) => {
            setAgain(event.target.value);
          }}
        />
        <TextField
          id="setup-token"
          label="Setup token"
          help={TOKEN_HELP}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          required
          value={setupKey}
          error={fields.get("setupToken")}
          onChange={(event) => {
            setSetupKey(event.target.value);
          }}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          disabled={!ready || uploading}
        >
          Create the owner account
        </Button>
      </form>

      <Collapsible.Root open={importOpen} onOpenChange={setImportOpen}>
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-control border border-border px-4 py-3 text-left text-sm font-medium text-fg hover:bg-accent-soft"
          >
            <span className="flex items-center gap-2">
              <DatabaseBackup className={ICON} aria-hidden="true" />
              Restore from an app backup instead
            </span>
            <ChevronDown
              className={importOpen ? "size-4 rotate-180" : "size-4"}
              aria-hidden="true"
            />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <form
            className="mt-4 flex flex-col gap-4 rounded-card border border-border bg-bg p-4"
            onSubmit={(event) => {
              void importBackup(event);
            }}
            noValidate
          >
            <p className="text-sm text-fg-muted">{IMPORT_TEXT}</p>
            {importFailure !== null ? (
              <Alert kind="error">{importFailure}</Alert>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="setup-import-file"
                className="text-sm font-medium"
              >
                Export file
              </label>
              <input
                id="setup-import-file"
                type="file"
                accept=".dwbx,application/octet-stream"
                className="text-sm text-fg file:mr-3 file:rounded-control file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-fg"
                onChange={(event) => {
                  setFile(event.target.files?.item(0) ?? null);
                }}
              />
            </div>
            <PasswordField
              id="setup-import-passphrase"
              label="Passphrase of the export"
              help={`At least ${MIN_PASSPHRASE} characters, as entered at export time.`}
              autoComplete="off"
              value={passphrase}
              onChange={(event) => {
                setPassphrase(event.target.value);
              }}
            />
            {uploading ? (
              <Progress.Root
                value={Math.round(progress * 100)}
                className="h-2 w-full overflow-hidden rounded-full bg-skeleton"
                aria-label="Upload progress"
              >
                <Progress.Indicator
                  className="h-full bg-primary transition-transform duration-150"
                  style={{ transform: `translateX(-${100 - progress * 100}%)` }}
                />
              </Progress.Root>
            ) : null}
            <Button
              type="submit"
              size="lg"
              loading={uploading}
              disabled={
                file === null ||
                passphrase.length < MIN_PASSPHRASE ||
                setupKey.trim() === "" ||
                busy
              }
            >
              {uploading ? "Importing" : "Import the backup"}
            </Button>
          </form>
        </Collapsible.Content>
      </Collapsible.Root>
    </AuthFrame>
  );
}
