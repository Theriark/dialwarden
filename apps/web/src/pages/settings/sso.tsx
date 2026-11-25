// Single sign-on (dev-work-plan P8-B screen 4): the OIDC provider of this
// instance, owner only and Paid (feature oidc). The discovery URL, the
// client settings with the secret never read back, the group-to-role
// mapping, the redirect address to register at the provider, a test
// sign-in through the real start route, and the owner's local fallback in
// words. On Free the settings answer 402: the page says single sign-on is
// off and renders the C1 upgrade hint; the switch back to Paid refetches it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  KeyRound,
  Plus,
  ShieldCheck,
  ShieldOff,
  X,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { errorMessage, fieldErrors } from "../../api/errors";
import { entitlementQuery, oidcSettingsQuery, p8keys } from "../../api/queries";
import {
  ASSIGNABLE_ROLES,
  type AssignableRole,
  type OidcInput,
  type OidcView,
} from "../../api/schema";
import { useIsOwner } from "../../api/session";
import { oidcStartUrl, saveOidc } from "../../api/team";
import { roleWord } from "../../components/role-badge";
import { UpgradeHint } from "../../components/upgrade-hint";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button, IconButton } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { CodeBlock } from "../../components/ui/code-block";
import {
  PasswordField,
  SelectField,
  TextField,
} from "../../components/ui/field";
import { CardSkeleton, ErrorState } from "../../components/ui/states";
import { SwitchField } from "../../components/ui/switch";
import { useToast } from "../../components/ui/toast";

interface MappingRow {
  readonly key: number;
  readonly group: string;
  readonly role: AssignableRole;
}

let nextKey = 1;

function rowsOf(mapping: Readonly<Record<string, string>>): MappingRow[] {
  return Object.entries(mapping).map(([group, role]) => ({
    key: nextKey++,
    group,
    role: isAssignable(role) ? role : "viewer",
  }));
}

function isAssignable(value: string): value is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/** The rows as the mapping the server takes; blank groups are dropped. */
export function mappingOf(
  rows: readonly MappingRow[],
): Record<string, AssignableRole> {
  const entries: [string, AssignableRole][] = [];
  for (const row of rows) {
    const group = row.group.trim();
    if (group !== "") {
      entries.push([group, row.role]);
    }
  }
  return Object.fromEntries(entries);
}

const OWNER_FALLBACK =
  "The owner always signs in with the local password, also while single sign-on is on and when the provider is down, and can switch it off here at any time. Everyone else signs in through the provider only.";

function MappingEditor({
  rows,
  onChange,
  disabled,
}: {
  rows: readonly MappingRow[];
  onChange: (rows: MappingRow[]) => void;
  disabled: boolean;
}) {
  const update = (key: number, patch: Partial<MappingRow>) => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium text-fg">Groups and roles</legend>
      <p className="text-sm text-fg-muted">
        A group of the provider gives its role at every sign-in; the highest
        wins. A person in no mapped group is refused. Nobody becomes owner this
        way.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No group mapped yet: nobody can sign in through the provider.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <li
              key={row.key}
              className="flex flex-col gap-2 rounded-control border border-border p-3 sm:flex-row sm:items-end sm:gap-3"
            >
              <div className="min-w-0 flex-1">
                <TextField
                  id={`sso-group-${row.key}`}
                  label={`Group ${index + 1}`}
                  placeholder="game-admins"
                  spellCheck={false}
                  value={row.group}
                  disabled={disabled}
                  onChange={(event) => {
                    update(row.key, { group: event.target.value });
                  }}
                />
              </div>
              <div className="w-full sm:w-40">
                <SelectField
                  id={`sso-role-${row.key}`}
                  label="Role"
                  value={row.role}
                  disabled={disabled}
                  options={ASSIGNABLE_ROLES.map((role) => ({
                    value: role,
                    label: roleWord(role),
                  }))}
                  onChange={(next) => {
                    if (isAssignable(next)) update(row.key, { role: next });
                  }}
                />
              </div>
              <IconButton
                label={`Remove group ${index + 1}`}
                className="min-h-11 sm:min-h-10 sm:self-end"
                disabled={disabled}
                onClick={() => {
                  onChange(rows.filter((item) => item.key !== row.key));
                }}
              >
                <X className="size-5" aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          disabled={disabled}
          onClick={() => {
            onChange([...rows, { key: nextKey++, group: "", role: "viewer" }]);
          }}
          icon={<Plus className="size-4" aria-hidden="true" />}
        >
          Add a group
        </Button>
      </div>
    </fieldset>
  );
}

function SsoForm({ view }: { view: OidcView }) {
  const client = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(view.enabled);
  const [issuer, setIssuer] = useState(view.issuer ?? "");
  const [clientId, setClientId] = useState(view.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [scope, setScope] = useState(view.scope);
  const [groupsClaim, setGroupsClaim] = useState(view.groupsClaim);
  const [rows, setRows] = useState<MappingRow[]>(() =>
    rowsOf(view.roleMapping),
  );
  const [privateNetwork, setPrivateNetwork] = useState(
    view.allowPrivateNetwork,
  );

  useEffect(() => {
    // A save or a plan switch answers the stored settings: the form follows.
    setEnabled(view.enabled);
    setIssuer(view.issuer ?? "");
    setClientId(view.clientId ?? "");
    setScope(view.scope);
    setGroupsClaim(view.groupsClaim);
    setRows(rowsOf(view.roleMapping));
    setPrivateNetwork(view.allowPrivateNetwork);
    setSecret("");
    setClearSecret(false);
  }, [view]);

  const save = useMutation({
    mutationFn: (input: OidcInput) => saveOidc(input),
    onSuccess: (data) => {
      client.setQueryData(p8keys.oidc, data);
      toast.push({
        kind: "success",
        title: data.enabled ? "Single sign-on is on" : "Settings saved",
        description: data.enabled
          ? "Everyone but the owner now signs in through the provider."
          : data.configured
            ? "The provider is stored and switched off."
            : undefined,
      });
    },
  });
  const fields = fieldErrors(save.error);
  const refused =
    save.error instanceof ApiError && save.error.paymentRequired !== null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: OidcInput = {
      enabled,
      issuer: issuer.trim(),
      clientId: clientId.trim(),
      roleMapping: mappingOf(rows),
      allowPrivateNetwork: privateNetwork,
      ...(scope.trim() === "" ? {} : { scope: scope.trim() }),
      ...(groupsClaim.trim() === "" ? {} : { groupsClaim: groupsClaim.trim() }),
      ...(clearSecret
        ? { clientSecret: "" }
        : secret === ""
          ? {}
          : { clientSecret: secret }),
    };
    save.mutate(input);
  };
  const switchOffOnly = !enabled && view.configured;
  const ready =
    switchOffOnly || (issuer.trim() !== "" && clientId.trim() !== "");

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <Card
        title="Provider"
        description="An OpenID Connect provider with a discovery document. Dialwarden reads it when you save and checks the issuer it names."
        aside={
          view.enabled ? (
            <Badge
              kind="success"
              icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
            >
              On
            </Badge>
          ) : (
            <Badge
              kind="neutral"
              icon={<ShieldOff className="size-3.5" aria-hidden="true" />}
            >
              Off
            </Badge>
          )
        }
      >
        {save.isError && fields.size === 0 && !refused ? (
          <Alert kind="error">{errorMessage(save.error)}</Alert>
        ) : null}
        {save.error instanceof ApiError &&
        save.error.paymentRequired !== null ? (
          <UpgradeHint body={save.error.paymentRequired} />
        ) : null}
        <SwitchField
          id="sso-enabled"
          label="Sign in through the provider"
          description={
            view.configured
              ? "Off keeps the stored provider for later and needs no connection to it."
              : "Turns on once the provider below is saved."
          }
          checked={enabled}
          disabled={save.isPending}
          onCheckedChange={setEnabled}
        />
        <TextField
          id="sso-issuer"
          label="Discovery URL (issuer)"
          type="url"
          placeholder="https://login.example.com/realms/games"
          help="The issuer address; /.well-known/openid-configuration is appended. HTTPS only, public addresses unless the private network is allowed."
          spellCheck={false}
          autoComplete="off"
          value={issuer}
          disabled={save.isPending}
          error={fields.get("issuer")}
          onChange={(event) => {
            setIssuer(event.target.value);
          }}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            id="sso-client-id"
            label="Client id"
            spellCheck={false}
            autoComplete="off"
            value={clientId}
            disabled={save.isPending}
            error={fields.get("clientId")}
            onChange={(event) => {
              setClientId(event.target.value);
            }}
          />
          <PasswordField
            id="sso-client-secret"
            label="Client secret"
            autoComplete="off"
            placeholder={
              view.hasClientSecret && !clearSecret
                ? "Stored; leave empty to keep it"
                : "Empty for a public client"
            }
            help={
              view.hasClientSecret
                ? "The stored secret is never shown again. Type a new one to replace it."
                : "Needed by a confidential client; left empty for a public one."
            }
            value={secret}
            disabled={save.isPending || clearSecret}
            error={fields.get("clientSecret")}
            onChange={(event) => {
              setSecret(event.target.value);
            }}
          />
        </div>
        {view.hasClientSecret ? (
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={clearSecret}
              disabled={save.isPending}
              onChange={(event) => {
                setClearSecret(event.target.checked);
                if (event.target.checked) setSecret("");
              }}
            />
            Remove the stored secret (public client)
          </label>
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            id="sso-scope"
            label="Scope"
            help="Space-separated, starting with openid."
            spellCheck={false}
            autoComplete="off"
            value={scope}
            disabled={save.isPending}
            error={fields.get("scope")}
            onChange={(event) => {
              setScope(event.target.value);
            }}
          />
          <TextField
            id="sso-groups-claim"
            label="Groups claim"
            help="The claim of the ID token that lists the person's groups."
            spellCheck={false}
            autoComplete="off"
            value={groupsClaim}
            disabled={save.isPending}
            error={fields.get("groupsClaim")}
            onChange={(event) => {
              setGroupsClaim(event.target.value);
            }}
          />
        </div>
        <SwitchField
          id="sso-private-network"
          label="Allow a provider on the private network"
          description="Off refuses private and local addresses, which stops a request from reaching anything inside your network. Turn it on only for a provider you host yourself."
          checked={privateNetwork}
          disabled={save.isPending}
          onCheckedChange={setPrivateNetwork}
        />
      </Card>
      <Card
        title="Roles"
        description="Which group of the provider gives which role."
      >
        <MappingEditor
          rows={rows}
          onChange={setRows}
          disabled={save.isPending}
        />
      </Card>
      <Card
        title="At the provider"
        description="Register this redirect address with the client at the provider."
      >
        {view.redirectUri === null ? (
          <Alert kind="warning" title="BASE_URL is not set">
            The server needs BASE_URL to build the redirect address; single
            sign-on stays off until it is set.
          </Alert>
        ) : (
          <CodeBlock value={view.redirectUri} label="Redirect address" />
        )}
        <Alert
          kind="info"
          title="The owner keeps the local sign-in"
          action={
            view.enabled ? (
              <a
                href={oidcStartUrl("/settings/sso")}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-accent-soft"
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                Test sign-in in a new tab
              </a>
            ) : (
              <span className="text-xs text-fg-muted">
                Save with the switch on to test a sign-in.
              </span>
            )
          }
        >
          {OWNER_FALLBACK}
        </Alert>
      </Card>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={save.isPending}
          disabled={!ready}
          icon={<KeyRound className="size-4" aria-hidden="true" />}
        >
          {enabled ? "Save and turn on" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function SsoPage() {
  const owner = useIsOwner();
  const settings = useQuery({ ...oidcSettingsQuery(), enabled: owner });
  const entitlement = useQuery(entitlementQuery());
  if (!owner) {
    return (
      <Card title="Single sign-on">
        <Alert kind="info">Only the owner can set up single sign-on.</Alert>
      </Card>
    );
  }
  if (settings.isPending) {
    return (
      <>
        <CardSkeleton />
        <CardSkeleton />
      </>
    );
  }
  if (settings.isError) {
    const payment =
      settings.error instanceof ApiError
        ? settings.error.paymentRequired
        : null;
    if (payment !== null) {
      return (
        <Card
          title="Single sign-on is off"
          description="On the Free plan everyone signs in with a local password. A stored provider is kept and returns with a licence."
          aside={
            <Badge
              kind="neutral"
              icon={<ShieldOff className="size-3.5" aria-hidden="true" />}
            >
              Off
            </Badge>
          }
        >
          <UpgradeHint body={payment} />
          <p className="text-sm text-fg-muted">{OWNER_FALLBACK}</p>
        </Card>
      );
    }
    return (
      <ErrorState
        message={errorMessage(settings.error)}
        onRetry={() => {
          void settings.refetch();
        }}
        retrying={settings.isFetching}
      />
    );
  }
  return (
    <>
      {entitlement.data?.plan === "free" ? (
        <UpgradeHint
          body={{ error: "payment_required", plan: "free", feature: "oidc" }}
        />
      ) : null}
      <SsoForm view={settings.data} />
    </>
  );
}
