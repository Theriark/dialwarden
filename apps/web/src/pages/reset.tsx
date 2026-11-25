// The password reset page (/reset#value), from a link the owner or an admin
// made and handed over themselves. The value travels in the fragment. A new
// password signs the person in (200), or, when a second factor or single
// sign-on applies, is set without a session (204) and the person signs in
// on the login page. Every refusal of the value answers one 410.
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, fieldErrors } from "../api/errors";
import { rememberSession } from "../api/session";
import { redeemPasswordReset } from "../api/team";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { PasswordField } from "../components/ui/field";
import { EmptyState } from "../components/ui/states";
import { AuthFrame } from "./auth-frame";
import { tokenFromHash, useForgetHash } from "./invite";

const MIN_PASSWORD = 12;

export function ResetPage() {
  const client = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const [proof] = useState(() => tokenFromHash(window.location.hash));
  const [phrase, setPhrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  useForgetHash(proof);

  if (proof === null) {
    return (
      <AuthFrame title="Password reset">
        <EmptyState
          icon={<KeyRound className="size-6" aria-hidden="true" />}
          title="The link is incomplete"
          description="A reset link ends with a # and its value. Open the link exactly as it was handed to you."
          action={
            <Link
              to="/login"
              className="inline-flex h-10 items-center rounded-control bg-primary px-4 text-sm font-medium text-primary-fg no-underline"
            >
              Go to sign in
            </Link>
          }
        />
      </AuthFrame>
    );
  }

  if (done) {
    return (
      <AuthFrame title="Password set">
        <Alert kind="success" title="Your new password is in place">
          Every other session of the account was signed out. Sign in with the
          new password; the second step or single sign-on still applies.
        </Alert>
        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            void navigate({ to: "/login" });
          }}
        >
          Go to sign in
        </Button>
      </AuthFrame>
    );
  }

  const fields = fieldErrors(failure);
  const mismatch = again !== "" && phrase !== again;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const session = await redeemPasswordReset({
        token: proof,
        password: phrase,
      });
      if (session === undefined) {
        setDone(true);
        return;
      }
      rememberSession(client, session);
      router.history.push("/");
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Choose a new password"
      description="This link works once and ends every other session of the account."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        {failure !== null && fields.size === 0 ? (
          <Alert kind="error">{errorMessage(failure)}</Alert>
        ) : null}
        <PasswordField
          id="reset-password"
          label="New password"
          help={`At least ${MIN_PASSWORD} characters.`}
          autoComplete="new-password"
          required
          value={phrase}
          error={fields.get("password")}
          onChange={(event) => {
            setPhrase(event.target.value);
          }}
        />
        <PasswordField
          id="reset-password-again"
          label="New password again"
          autoComplete="new-password"
          required
          value={again}
          error={mismatch ? "The two passwords differ." : undefined}
          onChange={(event) => {
            setAgain(event.target.value);
          }}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          disabled={phrase.length < MIN_PASSWORD || phrase !== again}
        >
          Set the password
        </Button>
      </form>
    </AuthFrame>
  );
}
