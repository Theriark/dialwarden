// The invitation page (/invite#value): the value travels in the fragment,
// which no server or Referer sees. The person chooses a name and a password
// and is signed in (POST /api/v1/invitations/accept). Every refusal of the
// value answers one 410; the users limit of the Free plan answers the C1
// 402, rendered with the upgrade hint; single sign-on answers 403 and the
// invitation stays open for after it is turned off.
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { MailOpen } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { errorMessage, fieldErrors } from "../api/errors";
import { rememberSession } from "../api/session";
import { acceptInvitation } from "../api/team";
import { UpgradeHint } from "../components/upgrade-hint";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { PasswordField, TextField } from "../components/ui/field";
import { EmptyState } from "../components/ui/states";
import { AuthFrame } from "./auth-frame";

const MIN_PASSWORD = 12;

/** The value after the # of the address, or null without one. */
export function tokenFromHash(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  return value === "" ? null : value;
}

/**
 * Once the page holds the value, the address bar and the history entry drop
 * it, so it is not left on screen or in the back button. The router's own
 * history state is kept.
 */
export function useForgetHash(proof: string | null): void {
  useEffect(() => {
    if (proof === null || window.location.hash === "") return;
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", pathname + search);
  }, [proof]);
}

export function InvitePage() {
  const client = useQueryClient();
  const router = useRouter();
  const [proof] = useState(() => tokenFromHash(window.location.hash));
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  useForgetHash(proof);

  if (proof === null) {
    return (
      <AuthFrame title="Invitation">
        <EmptyState
          icon={<MailOpen className="size-6" aria-hidden="true" />}
          title="The link is incomplete"
          description="An invitation link ends with a # and its value. Open the link exactly as it was sent to you."
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

  const payment = failure instanceof ApiError ? failure.paymentRequired : null;
  const fields = fieldErrors(failure);
  const mismatch = again !== "" && phrase !== again;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const session = await acceptInvitation({
        token: proof,
        name: name.trim(),
        password: phrase,
      });
      rememberSession(client, session);
      router.history.push("/");
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Join this Dialwarden"
      description="You were invited to this instance. Choose how you appear and a password of your own."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        {payment !== null ? <UpgradeHint body={payment} /> : null}
        {failure !== null && payment === null && fields.size === 0 ? (
          <Alert kind="error">{errorMessage(failure)}</Alert>
        ) : null}
        <TextField
          id="invite-name"
          label="Your name"
          autoComplete="name"
          required
          value={name}
          error={fields.get("name")}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <PasswordField
          id="invite-password"
          label="Password"
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
          id="invite-password-again"
          label="Password again"
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
          disabled={
            name.trim() === "" ||
            phrase.length < MIN_PASSWORD ||
            phrase !== again
          }
        >
          Accept the invitation
        </Button>
        <p className="text-center text-xs text-fg-muted">
          Already have an account?{" "}
          <Link to="/login" className="text-primary underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
}
