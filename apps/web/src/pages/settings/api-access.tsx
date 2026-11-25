// API tokens (dev-work-plan P8-B screen 6), at /settings/tokens: every
// signed-in user makes, lists and revokes their own tokens. A token acts
// with a role at most the creator's; the value is shown once, with one copy
// action. Making one is Paid (apiTokens): on Free the page says tokens are
// stopped (every token answers 402 until a licence is active), renders the
// C1 upgrade hint and keeps the list and the revoke, and the switch back to
// Paid restores the form without a reload.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import { errorMessage, fieldErrors } from "../../api/errors";
import { entitlementQuery, p8keys, tokensQuery } from "../../api/queries";
import type {
  AssignableRole,
  PaymentRequiredBody,
  TokenView,
} from "../../api/schema";
import { rolesBelow, useSessionUser } from "../../api/session";
import { createToken, revokeToken } from "../../api/team";
import { RevealOnce, type Revealed } from "../../components/reveal-once";
import { roleSentence, RoleBadge, roleWord } from "../../components/role-badge";
import { UpgradeHint } from "../../components/upgrade-hint";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/dialog";
import { SelectField, TextField } from "../../components/ui/field";
import { ErrorState, RowsSkeleton } from "../../components/ui/states";
import { Table, Td, Th } from "../../components/ui/table";
import { useToast } from "../../components/ui/toast";
import { formatDateTime } from "../../lib/format";
import { useMediaQuery } from "../../lib/use-media-query";

/** The table from 1280 px up (inside the settings layout); cards below. */
export const TABLE_QUERY = "(min-width: 1280px)";

const USAGE =
  "Send it as Authorization: Bearer on API requests. A token never signs in, makes tokens or manages users, and it acts with its role at most, on the servers you may see.";

function CreateCard({
  actorRole,
  stopped,
  onRevealed,
}: {
  actorRole: string;
  stopped: PaymentRequiredBody | null;
  onRevealed: (revealed: Revealed) => void;
}) {
  const client = useQueryClient();
  const options = rolesBelow(actorRole);
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>(options.at(-1) ?? "viewer");
  const create = useMutation({
    mutationFn: (input: { name: string; role: AssignableRole }) =>
      createToken(input.name, input.role),
    onSuccess: (made) => {
      void client.invalidateQueries({ queryKey: p8keys.tokens });
      setName("");
      onRevealed({
        title: "Your new API token",
        description: `${made.name}, acting as ${roleWord(made.role).toLowerCase()}.`,
        label: "API token",
        value: made.token,
        note: USAGE,
      });
    },
  });
  const payment =
    create.error instanceof ApiError ? create.error.paymentRequired : null;
  const fields = fieldErrors(create.error);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = options.find((option) => option === role);
    if (chosen === undefined) return;
    create.mutate({ name: name.trim(), role: chosen });
  };
  return (
    <Card
      title="New token"
      description="A name you will recognise and the role it acts with."
      aside={
        stopped !== null ? (
          <Badge kind="warning">Stopped on Free</Badge>
        ) : (
          <Badge kind="success">Ready</Badge>
        )
      }
    >
      {stopped !== null ? (
        <>
          <p className="text-sm text-fg">
            API tokens are stopped on the Free plan: no new token can be made
            and every existing one answers 402 until a licence is active. The
            list below stays, and a token can still be revoked.
          </p>
          <UpgradeHint body={stopped} />
        </>
      ) : null}
      {payment !== null && stopped === null ? (
        <UpgradeHint body={payment} />
      ) : null}
      {create.isError && payment === null && fields.size === 0 ? (
        <Alert kind="error">{errorMessage(create.error)}</Alert>
      ) : null}
      <form
        className="flex flex-col gap-4 sm:flex-row sm:items-end"
        onSubmit={submit}
        noValidate
      >
        <div className="min-w-0 flex-1">
          <TextField
            id="token-name"
            label="Name"
            placeholder="Backup script on the game host"
            autoComplete="off"
            required
            maxLength={100}
            value={name}
            disabled={stopped !== null || create.isPending}
            error={fields.get("name")}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="w-full sm:w-44">
          <SelectField
            id="token-role"
            label="Acts as"
            value={role}
            disabled={stopped !== null || create.isPending}
            options={options.map((option) => ({
              value: option,
              label: roleWord(option),
            }))}
            onChange={setRole}
            error={fields.get("role")}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="sm:h-10"
          loading={create.isPending}
          disabled={stopped !== null || name.trim() === ""}
          icon={<Plus className="size-4" aria-hidden="true" />}
        >
          Create token
        </Button>
      </form>
      <p className="text-xs text-fg-muted">
        {roleSentence(role)} At most your own role.
      </p>
    </Card>
  );
}

function TokenRow({
  token,
  onRevoke,
}: {
  token: TokenView;
  onRevoke: (token: TokenView) => void;
}) {
  return (
    <tr>
      <Td>
        <span className="font-medium text-fg">{token.name}</span>
      </Td>
      <Td>
        <RoleBadge role={token.role} />
      </Td>
      <Td mono>{token.prefix}…</Td>
      <Td mono className="whitespace-nowrap">
        {formatDateTime(token.createdAt)}
      </Td>
      <Td mono className="whitespace-nowrap">
        {token.lastUsedAt === null ? "Never" : formatDateTime(token.lastUsedAt)}
      </Td>
      <Td align="right">
        <Button
          size="md"
          variant="destructive"
          onClick={() => {
            onRevoke(token);
          }}
          icon={<Trash2 className="size-4" aria-hidden="true" />}
        >
          Revoke
        </Button>
      </Td>
    </tr>
  );
}

function TokenCard({
  token,
  onRevoke,
}: {
  token: TokenView;
  onRevoke: (token: TokenView) => void;
}) {
  return (
    <li className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-fg">{token.name}</span>
          <span className="font-mono text-xs text-fg-muted">
            {token.prefix}…
          </span>
        </div>
        <RoleBadge role={token.role} className="shrink-0" />
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-fg-muted">
        <div className="flex gap-1">
          <dt>Made</dt>
          <dd className="font-mono text-fg tabular">
            {formatDateTime(token.createdAt)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Last used</dt>
          <dd className="font-mono text-fg tabular">
            {token.lastUsedAt === null
              ? "Never"
              : formatDateTime(token.lastUsedAt)}
          </dd>
        </div>
      </dl>
      <Button
        size="md"
        variant="destructive"
        className="min-h-11 w-full sm:w-auto sm:self-end"
        onClick={() => {
          onRevoke(token);
        }}
        icon={<Trash2 className="size-4" aria-hidden="true" />}
      >
        Revoke
      </Button>
    </li>
  );
}

function ListCard() {
  const client = useQueryClient();
  const toast = useToast();
  const tokens = useQuery(tokensQuery());
  const table = useMediaQuery(TABLE_QUERY);
  const [revoking, setRevoking] = useState<TokenView | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => revokeToken(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: p8keys.tokens });
      setRevoking(null);
      toast.push({ kind: "success", title: "Token revoked" });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The token was not revoked",
        description: errorMessage(error),
      });
    },
  });
  let body: ReactNode;
  if (tokens.isPending) {
    body = <RowsSkeleton rows={2} />;
  } else if (tokens.isError) {
    body = (
      <ErrorState
        message={errorMessage(tokens.error)}
        onRetry={() => {
          void tokens.refetch();
        }}
        retrying={tokens.isFetching}
      />
    );
  } else if (tokens.data.items.length === 0) {
    body = (
      <p className="flex items-center gap-2 text-sm text-fg-muted">
        <KeyRound className="size-5 shrink-0" aria-hidden="true" />
        No token yet. The first one appears here with its prefix once made.
      </p>
    );
  } else if (table) {
    body = (
      <Table label="API tokens">
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Acts as</Th>
            <Th>Prefix</Th>
            <Th>Made</Th>
            <Th>Last used</Th>
            <Th align="right">Revoke</Th>
          </tr>
        </thead>
        <tbody>
          {tokens.data.items.map((token) => (
            <TokenRow key={token.id} token={token} onRevoke={setRevoking} />
          ))}
        </tbody>
      </Table>
    );
  } else {
    body = (
      <ul
        aria-label="API tokens"
        className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface shadow-card"
      >
        {tokens.data.items.map((token) => (
          <TokenCard key={token.id} token={token} onRevoke={setRevoking} />
        ))}
      </ul>
    );
  }
  return (
    <Card
      title="Your tokens"
      description="Only the prefix is kept in the clear; the value was shown once."
    >
      {body}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null);
        }}
        title="Revoke this token?"
        description={
          revoking === null
            ? ""
            : `${revoking.name} stops working at once. Anything that uses it must get a new one.`
        }
        confirmLabel="Revoke"
        destructive
        loading={revoke.isPending}
        onConfirm={() => {
          if (revoking !== null) revoke.mutate(revoking.id);
        }}
      />
    </Card>
  );
}

export function ApiAccessPage() {
  const user = useSessionUser();
  const entitlement = useQuery(entitlementQuery());
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  if (user === null) {
    return <RowsSkeleton rows={2} />;
  }
  const stopped: PaymentRequiredBody | null =
    entitlement.data !== undefined && !entitlement.data.features.apiTokens
      ? { error: "payment_required", plan: "free", feature: "apiTokens" }
      : null;
  return (
    <>
      <CreateCard
        actorRole={user.role}
        stopped={stopped}
        onRevealed={setRevealed}
      />
      <ListCard />
      <RevealOnce
        revealed={revealed}
        onDone={() => {
          setRevealed(null);
        }}
      />
    </>
  );
}
