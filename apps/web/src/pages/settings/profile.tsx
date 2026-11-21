// Profile and password (PATCH /api/v1/auth/profile, POST /api/v1/auth/password)
// and two-factor sign-in: enrol, enable with the recovery codes shown once,
// and disable (POST /api/v1/auth/totp/*).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { toDataURL } from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { keys, sessionQuery } from "../../api/queries";
import type {
  RecoveryCodes,
  SignedIn,
  TotpEnrolment,
  User,
} from "../../api/schema";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { CodeBlock, CopyButton } from "../../components/ui/code-block";
import { ConfirmDialog, Dialog } from "../../components/ui/dialog";
import { PasswordField, TextField } from "../../components/ui/field";
import {
  CardSkeleton,
  ErrorState,
  Skeleton,
} from "../../components/ui/states";
import { useToast } from "../../components/ui/toast";

const MIN_PASSWORD = 12;

function ProfileCard({ user }: { user: User }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const save = useMutation({
    mutationFn: (value: string) =>
      api<{ user: User }>("/api/v1/auth/profile", {
        method: "PATCH",
        body: { name: value },
      }),
    onSuccess: (result) => {
      client.setQueryData<SignedIn | null>(keys.session, (current) => {
        if (current === null || current === undefined) {
          return current;
        }
        return { ...current, user: result.user };
      });
      toast.push({ kind: "success", title: "Profile saved" });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(name.trim());
  };
  return (
    <Card title="Profile" description="How you appear in the activity log.">
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {save.isError ? (
          <Alert kind="error">{errorMessage(save.error)}</Alert>
        ) : null}
        <TextField
          id="profile-name"
          label="Name"
          autoComplete="name"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <TextField
          id="profile-email"
          label="E-mail address"
          type="email"
          value={user.email}
          readOnly
          help="The sign-in address cannot be changed in this version."
        />
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabled={name.trim() === "" || name.trim() === user.name}
          >
            Save
          </Button>
          <Badge kind="neutral">{user.role}</Badge>
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [fresh, setFresh] = useState("");
  const [again, setAgain] = useState("");
  const change = useMutation({
    mutationFn: () =>
      api<undefined>("/api/v1/auth/password", {
        method: "POST",
        body: { currentPassword: current, newPassword: fresh },
      }),
    onSuccess: () => {
      setCurrent("");
      setFresh("");
      setAgain("");
      toast.push({
        kind: "success",
        title: "Password changed",
        description: "Every other session of this account was signed out.",
      });
    },
  });
  const mismatch = again !== "" && fresh !== again;
  const wrongCurrent =
    change.error instanceof ApiError &&
    change.error.code === "invalid_credentials";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    change.mutate();
  };
  return (
    <Card
      title="Password"
      description="Choose a long passphrase you do not use anywhere else."
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {change.isError && !wrongCurrent ? (
          <Alert kind="error">{errorMessage(change.error)}</Alert>
        ) : null}
        <PasswordField
          id="password-current"
          label="Current password"
          autoComplete="current-password"
          required
          value={current}
          error={wrongCurrent ? "The current password is wrong." : undefined}
          onChange={(event) => {
            setCurrent(event.target.value);
          }}
        />
        <PasswordField
          id="password-new"
          label="New password"
          help={`At least ${MIN_PASSWORD} characters.`}
          autoComplete="new-password"
          required
          value={fresh}
          onChange={(event) => {
            setFresh(event.target.value);
          }}
        />
        <PasswordField
          id="password-again"
          label="New password again"
          autoComplete="new-password"
          required
          value={again}
          error={mismatch ? "The two passwords differ." : undefined}
          onChange={(event) => {
            setAgain(event.target.value);
          }}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={change.isPending}
            disabled={
              current === "" || fresh.length < MIN_PASSWORD || fresh !== again
            }
          >
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

type EnrolStep = "password" | "verify" | "codes";

function EnrolDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<EnrolStep>("password");
  const [phrase, setPhrase] = useState("");
  const [code, setCode] = useState("");
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const enrol = useMutation({
    mutationFn: () =>
      api<TotpEnrolment>("/api/v1/auth/totp/enrol", {
        method: "POST",
        body: { password: phrase },
      }),
    onSuccess: (result) => {
      setEnrolment(result);
      setPhrase("");
      setStep("verify");
    },
  });

  const enable = useMutation({
    mutationFn: () =>
      api<RecoveryCodes>("/api/v1/auth/totp/enable", {
        method: "POST",
        body: { code: code.replace(/\s/g, "") },
      }),
    onSuccess: (result) => {
      setCodes(result.recoveryCodes);
      setStep("codes");
      void client.invalidateQueries({ queryKey: keys.session });
    },
  });

  useEffect(() => {
    if (enrolment === null) {
      setQr(null);
      return;
    }
    let cancelled = false;
    toDataURL(enrolment.otpauthUri, { width: 200, margin: 1 })
      .then((url) => {
        if (!cancelled) {
          setQr(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQr(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enrolment]);

  const close = (next: boolean) => {
    if (!next && step === "codes" && !saved) {
      return;
    }
    onOpenChange(next);
    if (!next) {
      setStep("password");
      setPhrase("");
      setCode("");
      setEnrolment(null);
      setCodes([]);
      setSaved(false);
      enrol.reset();
      enable.reset();
      if (step === "codes") {
        toast.push({ kind: "success", title: "Two-factor sign-in is on" });
      }
    }
  };

  const wrongCode =
    enable.error instanceof ApiError && enable.error.code === "invalid_code";

  if (step === "password") {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title="Turn on two-factor sign-in"
        description="Confirm your password to start. You will need an authenticator app."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            enrol.mutate();
          }}
          noValidate
        >
          {enrol.isError ? (
            <Alert kind="error">{errorMessage(enrol.error)}</Alert>
          ) : null}
          <PasswordField
            id="totp-enrol-password"
            label="Password"
            autoComplete="current-password"
            required
            value={phrase}
            onChange={(event) => {
              setPhrase(event.target.value);
            }}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              loading={enrol.isPending}
              disabled={phrase === ""}
            >
              Continue
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  if (step === "verify" && enrolment !== null) {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title="Scan the code"
        description="Add Dialwarden to your authenticator app, then enter the six-digit code it shows."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            enable.mutate();
          }}
          noValidate
        >
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            {qr === null ? (
              <Skeleton className="size-[200px] shrink-0 rounded-card" />
            ) : (
              <img
                src={qr}
                alt="QR code for the authenticator app"
                width={200}
                height={200}
                className="size-[200px] shrink-0 rounded-card border border-border bg-white"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
              <p className="text-fg-muted">
                No camera? Enter this key by hand instead.
              </p>
              <CodeBlock value={enrolment.secret} label="Setup key" />
            </div>
          </div>
          {enable.isError && !wrongCode ? (
            <Alert kind="error">{errorMessage(enable.error)}</Alert>
          ) : null}
          <TextField
            id="totp-enrol-code"
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="font-mono text-xl tracking-[0.3em]"
            required
            value={code}
            error={
              wrongCode ? "The code is wrong. Try the next one." : undefined
            }
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              loading={enable.isPending}
              disabled={code.replace(/\s/g, "").length !== 6}
            >
              Turn on
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Save your recovery codes"
      description="Each code signs you in once if you lose the authenticator app. They are shown only now."
      footer={
        <Button
          variant="primary"
          disabled={!saved}
          onClick={() => {
            close(false);
          }}
        >
          Done
        </Button>
      }
    >
      <CodeBlock
        value={codes.join("\n")}
        label="Recovery codes"
        copy={false}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CopyButton value={codes.join("\n")} label="Copy all codes" />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={saved}
            onChange={(event) => {
              setSaved(event.target.checked);
            }}
          />
          I have saved these codes
        </label>
      </div>
    </Dialog>
  );
}

function DisableDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [phrase, setPhrase] = useState("");
  const [code, setCode] = useState("");
  const disable = useMutation({
    mutationFn: () =>
      api<undefined>("/api/v1/auth/totp/disable", {
        method: "POST",
        body: { password: phrase, code: code.replace(/\s/g, "") },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.session });
      onOpenChange(false);
      setPhrase("");
      setCode("");
      toast.push({ kind: "success", title: "Two-factor sign-in is off" });
    },
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          disable.reset();
        }
      }}
      title="Turn off two-factor sign-in"
      description="Your password alone will sign you in afterwards. Every other session ends now."
      confirmLabel="Turn off"
      destructive
      loading={disable.isPending}
      confirmDisabled={phrase === "" || code.trim() === ""}
      onConfirm={() => {
        disable.mutate();
      }}
    >
      <div className="flex flex-col gap-4">
        {disable.isError ? (
          <Alert kind="error">{errorMessage(disable.error)}</Alert>
        ) : null}
        <PasswordField
          id="totp-disable-password"
          label="Password"
          autoComplete="current-password"
          value={phrase}
          onChange={(event) => {
            setPhrase(event.target.value);
          }}
        />
        <TextField
          id="totp-disable-code"
          label="Code from the app"
          inputMode="numeric"
          autoComplete="one-time-code"
          className="font-mono"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
      </div>
    </ConfirmDialog>
  );
}

function TwoFactorCard({ user }: { user: User }) {
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const onIcon = <ShieldCheck className="size-3.5" aria-hidden="true" />;
  const offIcon = <ShieldOff className="size-3.5" aria-hidden="true" />;
  const badge = user.totpEnabled ? (
    <Badge kind="success" icon={onIcon}>On</Badge>
  ) : (
    <Badge kind="neutral" icon={offIcon}>Off</Badge>
  );
  return (
    <Card
      title="Two-factor sign-in"
      description="A code from an authenticator app at every sign-in, plus ten recovery codes."
      aside={badge}
    >
      {user.totpEnabled ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg">
            Sign-in asks for a code after the password.
          </p>
          <div>
            <Button
              variant="destructive"
              onClick={() => {
                setDisableOpen(true);
              }}
            >
              Turn off
            </Button>
          </div>
          <DisableDialog open={disableOpen} onOpenChange={setDisableOpen} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg">
            A stolen password alone is not enough once this is on.
          </p>
          <div>
            <Button
              variant="primary"
              onClick={() => {
                setEnrolOpen(true);
              }}
            >
              Turn on
            </Button>
          </div>
          <EnrolDialog open={enrolOpen} onOpenChange={setEnrolOpen} />
        </div>
      )}
    </Card>
  );
}

export function ProfilePage() {
  const session = useQuery(sessionQuery());
  if (session.isPending) {
    return <CardSkeleton />;
  }
  if (session.isError || session.data === null || session.data === undefined) {
    return (
      <ErrorState
        message={session.isError ? errorMessage(session.error) : "Signed out."}
        onRetry={() => {
          void session.refetch();
        }}
        retrying={session.isFetching}
      />
    );
  }
  return (
    <>
      <ProfileCard user={session.data.user} />
      <PasswordCard />
      <TwoFactorCard user={session.data.user} />
    </>
  );
}
