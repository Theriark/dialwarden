// The second sign-in step (POST /api/v1/auth/login/totp): a six-digit code
// from the authenticator app, or one unused recovery code.
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import type { SignedIn } from "../api/schema";
import {
  readPendingChallenge,
  rememberSession,
  safeRedirect,
  setPendingChallenge,
} from "../api/session";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { TextField } from "../components/ui/field";
import { AuthFrame } from "./auth-frame";
import type { LoginSearch } from "./login";

export function TwoFactorPage({ search }: { search: LoginSearch }) {
  const client = useQueryClient();
  const router = useRouter();
  const [challenge] = useState(readPendingChallenge);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // A dead challenge is dropped, so coming back here asks for the password.
  const restart = (
    <Link
      to="/login"
      search={search}
      className="font-medium"
      onClick={() => {
        setPendingChallenge(null);
      }}
    >
      Start the sign-in again
    </Link>
  );

  if (challenge === null) {
    return (
      <AuthFrame title="Second step">
        <Alert kind="info" action={restart}>
          Sign in with your password first.
        </Alert>
      </AuthFrame>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    const answer = useRecovery
      ? { recoveryCode: code.trim() }
      : { code: code.replace(/\s/g, "") };
    try {
      const session = await api<SignedIn>("/api/v1/auth/login/totp", {
        method: "POST",
        body: { challenge, ...answer },
      });
      setPendingChallenge(null);
      rememberSession(client, session);
      router.history.push(safeRedirect(search.redirect));
    } catch (error) {
      if (error instanceof ApiError && error.code === "challenge_expired") {
        setPendingChallenge(null);
        setExpired(true);
      } else {
        setFailure(errorMessage(error));
      }
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Second step"
      description="Two-factor sign-in is on for this account."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        {expired ? (
          <Alert kind="warning" action={restart}>
            The sign-in step expired after five minutes.
          </Alert>
        ) : null}
        {failure !== null ? <Alert kind="error">{failure}</Alert> : null}
        {useRecovery ? (
          <TextField
            id="totp-recovery"
            label="Recovery code"
            help="One of the ten codes shown when two-factor sign-in was turned on. Each works once."
            autoComplete="one-time-code"
            className="font-mono"
            required
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        ) : (
          <TextField
            id="totp-code"
            label="Code from your authenticator app"
            help="Six digits; the code changes every 30 seconds."
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            className="font-mono text-xl tracking-[0.3em]"
            required
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          disabled={code.trim() === "" || expired}
        >
          Continue
        </Button>
        <button
          type="button"
          className="self-start text-sm text-primary underline underline-offset-2"
          onClick={() => {
            setUseRecovery((value) => !value);
            setCode("");
            setFailure(null);
          }}
        >
          {useRecovery ? "Use the authenticator app" : "Use a recovery code"}
        </button>
      </form>
    </AuthFrame>
  );
}
