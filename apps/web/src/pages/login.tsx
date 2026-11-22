// Sign-in (POST /api/v1/auth/login). A totp_required answer sends the user to
// the second step with the challenge kept in memory.
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { errorMessage } from "../api/errors";
import type { LoginResponse } from "../api/schema";
import {
  rememberSession,
  safeRedirect,
  setPendingChallenge,
} from "../api/session";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { PasswordField, TextField } from "../components/ui/field";
import { AuthFrame } from "./auth-frame";

export interface LoginSearch {
  redirect?: string;
}

export function LoginPage({ search }: { search: LoginSearch }) {
  const client = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const result = await api<LoginResponse>("/api/v1/auth/login", {
        method: "POST",
        body: { email: email.trim(), password: phrase },
      });
      if (result.status === "totp_required") {
        setPendingChallenge(result.challenge);
        await navigate({ to: "/login/2fa", search });
        return;
      }
      rememberSession(client, result);
      router.history.push(safeRedirect(search.redirect));
    } catch (error) {
      setFailure(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Sign in"
      description="Use the owner account of this Dialwarden instance."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        {failure !== null ? <Alert kind="error">{failure}</Alert> : null}
        <TextField
          id="login-email"
          label="E-mail address"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <PasswordField
          id="login-password"
          label="Password"
          autoComplete="current-password"
          required
          value={phrase}
          onChange={(event) => {
            setPhrase(event.target.value);
          }}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          disabled={email.trim() === "" || phrase === ""}
        >
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}
