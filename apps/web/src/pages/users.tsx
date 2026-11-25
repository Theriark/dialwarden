// The Users page (dev-work-plan P8-B screen 1): every user with the stored
// and the acting role, the sign-in facts, the per-server grants, and the
// open invitations. The owner and admins manage users (an admin only editors
// and viewers; nobody changes their own role or the owner); everyone else
// sees a designed read-only state. Role and grant changes and new
// invitations are Paid (team.roles, team.users): on Free every 402 renders
// the C1 upgrade hint, and a user whose stored role is kept but who acts as
// a viewer carries the fallback badge with the reason. The server stays the
// authority: every control here mirrors a check it makes.
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Eraser,
  KeyRound,
  MailPlus,
  MoreHorizontal,
  PencilLine,
  ServerCog,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { errorMessage, fieldErrors } from "../api/errors";
import {
  entitlementQuery,
  invitationsQuery,
  p8keys,
  serversQuery,
  usersQuery,
} from "../api/queries";
import type {
  AssignableRole,
  Grant,
  InvitationView,
  PaymentRequiredBody,
  User,
  UserView,
} from "../api/schema";
import {
  canManageRole,
  useCanManageUsers,
  useSessionUser,
} from "../api/session";
import {
  anonymiseUser,
  createInvitation,
  createResetLink,
  deleteUser,
  exportUser,
  revokeInvitation,
  setUserGrants,
  setUserRole,
} from "../api/team";
import { PageHeader } from "../components/layout/page-header";
import {
  describeGrants,
  GrantEditor,
  type GrantServer,
} from "../components/grant-editor";
import { RevealOnce, type Revealed } from "../components/reveal-once";
import {
  FALLBACK_REASON,
  FallbackBadge,
  roleSentence,
  RoleBadge,
  roleWord,
} from "../components/role-badge";
import { UpgradeHint } from "../components/upgrade-hint";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, IconButton } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog, Dialog } from "../components/ui/dialog";
import { SelectField, TextField } from "../components/ui/field";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  RowsSkeleton,
} from "../components/ui/states";
import { Table, Td, Th } from "../components/ui/table";
import { useToast } from "../components/ui/toast";
import { downloadBlob } from "../lib/download";
import { formatDateTime } from "../lib/format";
import { useMediaQuery } from "../lib/use-media-query";

/** The table needs about 900 px; below it every user is a stacked card. */
export const TABLE_QUERY = "(min-width: 1024px)";

const MENU_CONTENT =
  "z-50 min-w-48 rounded-card border border-border-strong bg-surface p-1 text-sm text-fg shadow-card";
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-control px-2 py-2 outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** The roles an actor may give: the owner any but owner, an admin below. */
export function assignableFor(actor: string): readonly AssignableRole[] {
  if (actor === "owner") return ["admin", "editor", "viewer"];
  if (actor === "admin") return ["editor", "viewer"];
  return [];
}

/** Whether the actor may change this user at all (team/roles.ts canManage). */
export function manageable(actor: User, target: UserView): boolean {
  return target.id !== actor.id && canManageRole(actor.role, target.role);
}

/** A user whose stored role is kept but who acts as a viewer (Free). */
export function inFallback(user: UserView): boolean {
  return user.role !== user.effectiveRole;
}

/** The 402 body of a failed write, or null for any other failure. */
function paymentOf(error: unknown): PaymentRequiredBody | null {
  return error instanceof ApiError ? error.paymentRequired : null;
}

function SignInFacts({ user }: { user: UserView }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {user.sso ? (
        <Badge kind="info" icon={<KeyRound className="size-3.5" />}>
          Single sign-on
        </Badge>
      ) : null}
      {user.totpEnabled ? (
        <Badge kind="success" icon={<ShieldCheck className="size-3.5" />}>
          Two-factor on
        </Badge>
      ) : null}
      {!user.localPassword && !user.sso ? (
        <Badge kind="warning">No password yet</Badge>
      ) : null}
      {!user.sso && !user.totpEnabled && user.localPassword ? (
        <Badge kind="neutral">Password</Badge>
      ) : null}
    </div>
  );
}

function AccessWords({ user }: { user: UserView }) {
  if (user.role === "owner" || user.role === "admin") {
    return <span className="text-fg">Every server</span>;
  }
  return <span className="text-fg">{describeGrants(user.grants)}</span>;
}

interface RowActions {
  onRole: (user: UserView) => void;
  onGrants: (user: UserView) => void;
  onReset: (user: UserView) => void;
  onExport: (user: UserView) => void;
  onAnonymise: (user: UserView) => void;
  onDelete: (user: UserView) => void;
}

function UserMenu({
  user,
  actor,
  actions,
}: {
  user: UserView;
  actor: User;
  actions: RowActions;
}) {
  const canChange = manageable(actor, user);
  const canExport = actor.role === "owner";
  if (!canChange && !canExport) {
    return null;
  }
  const grantsApply = user.role === "editor" || user.role === "viewer";
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton label={`Actions for ${user.name}`}>
          <MoreHorizontal className="size-5" aria-hidden="true" />
        </IconButton>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className={MENU_CONTENT}>
          {canChange ? (
            <>
              <Menu.Item
                className={MENU_ITEM}
                onSelect={() => {
                  actions.onRole(user);
                }}
              >
                <PencilLine className="size-4" aria-hidden="true" />
                Change role
              </Menu.Item>
              {grantsApply ? (
                <Menu.Item
                  className={MENU_ITEM}
                  onSelect={() => {
                    actions.onGrants(user);
                  }}
                >
                  <ServerCog className="size-4" aria-hidden="true" />
                  Server grants
                </Menu.Item>
              ) : null}
              <Menu.Item
                className={MENU_ITEM}
                disabled={user.sso}
                onSelect={() => {
                  actions.onReset(user);
                }}
              >
                <KeyRound className="size-4" aria-hidden="true" />
                Password reset link
              </Menu.Item>
            </>
          ) : null}
          {canExport ? (
            <Menu.Item
              className={MENU_ITEM}
              onSelect={() => {
                actions.onExport(user);
              }}
            >
              <Download className="size-4" aria-hidden="true" />
              Export data
            </Menu.Item>
          ) : null}
          {canChange ? (
            <>
              <Menu.Separator className="my-1 h-px bg-border" />
              <Menu.Item
                className={MENU_ITEM}
                onSelect={() => {
                  actions.onAnonymise(user);
                }}
              >
                <Eraser className="size-4" aria-hidden="true" />
                Anonymise
              </Menu.Item>
              <Menu.Item
                className={`${MENU_ITEM} text-error`}
                onSelect={() => {
                  actions.onDelete(user);
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Delete
              </Menu.Item>
            </>
          ) : null}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function RoleCell({ user }: { user: UserView }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <RoleBadge role={user.role} />
      {inFallback(user) ? <FallbackBadge /> : null}
    </div>
  );
}

function UserRow({
  user,
  actor,
  actions,
}: {
  user: UserView;
  actor: User;
  actions: RowActions;
}) {
  return (
    <tr>
      <Td>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-fg">
            {user.name}
            {user.id === actor.id ? (
              <span className="ml-1.5 text-xs font-normal text-fg-muted">
                (you)
              </span>
            ) : null}
          </span>
          <span className="break-all text-xs text-fg-muted">{user.email}</span>
        </div>
      </Td>
      <Td>
        <RoleCell user={user} />
      </Td>
      <Td>
        <AccessWords user={user} />
      </Td>
      <Td>
        <SignInFacts user={user} />
      </Td>
      <Td mono className="whitespace-nowrap">
        {formatDateTime(user.createdAt)}
      </Td>
      <Td align="right">
        <UserMenu user={user} actor={actor} actions={actions} />
      </Td>
    </tr>
  );
}

/** One stacked card below 1024 px. */
function UserCard({
  user,
  actor,
  actions,
}: {
  user: UserView;
  actor: User;
  actions: RowActions;
}) {
  return (
    <li className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-fg">
            {user.name}
            {user.id === actor.id ? (
              <span className="ml-1.5 text-xs font-normal text-fg-muted">
                (you)
              </span>
            ) : null}
          </span>
          <span className="break-all text-xs text-fg-muted">{user.email}</span>
        </div>
        <UserMenu user={user} actor={actor} actions={actions} />
      </div>
      <RoleCell user={user} />
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <div className="flex gap-1">
          <dt>Access</dt>
          <dd>
            <AccessWords user={user} />
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Since</dt>
          <dd className="font-mono text-fg tabular">
            {formatDateTime(user.createdAt)}
          </dd>
        </div>
      </dl>
      <SignInFacts user={user} />
    </li>
  );
}

function RoleDialog({
  user,
  actor,
  onClose,
}: {
  user: UserView | null;
  actor: User;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [role, setRole] = useState<string>("");
  const options = assignableFor(actor.role);
  const current = role === "" ? (user?.role ?? "") : role;
  const change = useMutation({
    mutationFn: (input: { id: string; role: AssignableRole }) =>
      setUserRole(input.id, input.role),
    onSuccess: (updated) => {
      void client.invalidateQueries({ queryKey: p8keys.users });
      toast.push({
        kind: "success",
        title: "Role changed",
        description: `${updated.name} is now ${roleWord(updated.role).toLowerCase()}.`,
      });
      close();
    },
  });
  const close = () => {
    setRole("");
    change.reset();
    onClose();
  };
  const payment = paymentOf(change.error);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (user === null) return;
    const chosen = options.find((option) => option === current);
    if (chosen === undefined) return;
    change.mutate({ id: user.id, role: chosen });
  };
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Change the role"
      description={
        user === null
          ? ""
          : `${user.name} is ${roleWord(user.role).toLowerCase()} today. Open sessions keep working; the new role applies to the next request.`
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {payment !== null ? <UpgradeHint body={payment} /> : null}
        {change.isError && payment === null ? (
          <Alert kind="error">{errorMessage(change.error)}</Alert>
        ) : null}
        <SelectField
          id="role-change"
          label="Role"
          value={current}
          options={options.map((option) => ({
            value: option,
            label: roleWord(option),
          }))}
          onChange={setRole}
          help={roleSentence(current)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={change.isPending}
            disabled={user === null || current === user.role}
          >
            Change role
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function GrantsDialog({
  user,
  servers,
  onClose,
}: {
  user: UserView | null;
  servers: readonly GrantServer[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Grant[] | null>(null);
  const grants = draft ?? user?.grants ?? [];
  const save = useMutation({
    mutationFn: (input: { id: string; grants: readonly Grant[] }) =>
      setUserGrants(input.id, input.grants),
    onSuccess: (updated) => {
      void client.invalidateQueries({ queryKey: p8keys.users });
      toast.push({
        kind: "success",
        title: "Grants saved",
        description: `${updated.name}: ${describeGrants(updated.grants).toLowerCase()}.`,
      });
      close();
    },
  });
  const close = () => {
    setDraft(null);
    save.reset();
    onClose();
  };
  const payment = paymentOf(save.error);
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Server grants"
      description={
        user === null
          ? ""
          : `Which servers ${user.name} sees, and whether they may write.`
      }
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={user === null || draft === null}
            onClick={() => {
              if (user !== null) save.mutate({ id: user.id, grants });
            }}
          >
            Save grants
          </Button>
        </>
      }
    >
      {payment !== null ? <UpgradeHint body={payment} /> : null}
      {save.isError && payment === null ? (
        <Alert kind="error">{errorMessage(save.error)}</Alert>
      ) : null}
      {user !== null ? (
        <GrantEditor
          servers={servers}
          value={grants}
          onChange={setDraft}
          role={user.role}
          disabled={save.isPending}
        />
      ) : null}
    </Dialog>
  );
}

function InviteDialog({
  open,
  actor,
  servers,
  onClose,
  onRevealed,
}: {
  open: boolean;
  actor: User;
  servers: readonly GrantServer[];
  onClose: () => void;
  onRevealed: (revealed: Revealed) => void;
}) {
  const client = useQueryClient();
  const options = assignableFor(actor.role);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>(options.at(-1) ?? "viewer");
  const [grants, setGrants] = useState<Grant[]>([]);
  const invite = useMutation({
    mutationFn: (input: {
      email: string;
      role: AssignableRole;
      grants: readonly Grant[];
    }) => createInvitation(input),
    onSuccess: (made) => {
      void client.invalidateQueries({ queryKey: invitationsQuery().queryKey });
      close();
      onRevealed({
        title: "Invitation link",
        description: `Send this link to ${made.email}. It works once and expires ${formatDateTime(made.expiresAt)}.`,
        label: "Invitation link",
        value: made.link,
        note: "The link carries the invitation after a # and never reaches a server log.",
      });
    },
  });
  const close = () => {
    setEmail("");
    setRole(options.at(-1) ?? "viewer");
    setGrants([]);
    invite.reset();
    onClose();
  };
  const payment = paymentOf(invite.error);
  const fields = fieldErrors(invite.error);
  const grantsApply = role === "editor" || role === "viewer";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = options.find((option) => option === role);
    if (chosen === undefined) return;
    invite.mutate({
      email: email.trim(),
      role: chosen,
      grants: grantsApply ? grants : [],
    });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Invite a teammate"
      description="A single-use link, valid for 72 hours. The person chooses a name and a password when they accept it."
      className="max-w-2xl"
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {payment !== null ? <UpgradeHint body={payment} /> : null}
        {invite.isError && payment === null && fields.size === 0 ? (
          <Alert kind="error">{errorMessage(invite.error)}</Alert>
        ) : null}
        <TextField
          id="invite-email"
          label="E-mail address"
          type="email"
          autoComplete="off"
          required
          value={email}
          error={fields.get("email")}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <SelectField
          id="invite-role"
          label="Role"
          value={role}
          options={options.map((option) => ({
            value: option,
            label: roleWord(option),
          }))}
          onChange={(next) => {
            setRole(next);
            if (next === "viewer") {
              setGrants((current) =>
                current.map((grant) => ({ ...grant, level: "read" })),
              );
            }
          }}
          help={roleSentence(role)}
          error={fields.get("role")}
        />
        {grantsApply ? (
          <GrantEditor
            servers={servers}
            value={grants}
            onChange={setGrants}
            role={role}
            disabled={invite.isPending}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={invite.isPending}
            disabled={email.trim() === ""}
            icon={<MailPlus className="size-4" aria-hidden="true" />}
          >
            Create the link
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InvitationsCard({
  actor,
  servers,
  onRevealed,
}: {
  actor: User;
  servers: readonly GrantServer[];
  onRevealed: (revealed: Revealed) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const invitations = useQuery(invitationsQuery());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [revoking, setRevoking] = useState<InvitationView | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => revokeInvitation(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: invitationsQuery().queryKey });
      setRevoking(null);
      toast.push({ kind: "success", title: "Invitation revoked" });
    },
    onError: (error) => {
      toast.push({
        kind: "error",
        title: "The invitation was not revoked",
        description: errorMessage(error),
      });
    },
  });
  const payment = paymentOf(invitations.error);
  const canInvite = assignableFor(actor.role).length > 0 && payment === null;

  let body: ReactNode;
  if (invitations.isPending) {
    body = <RowsSkeleton rows={2} />;
  } else if (payment !== null) {
    body = (
      <>
        <p className="text-sm text-fg">
          Invitations are paused on the Free plan: the one user it includes is
          the owner. Open invitations can still be revoked once a licence is
          active.
        </p>
        <UpgradeHint body={payment} />
      </>
    );
  } else if (invitations.isError) {
    body = (
      <ErrorState
        message={errorMessage(invitations.error)}
        onRetry={() => {
          void invitations.refetch();
        }}
        retrying={invitations.isFetching}
      />
    );
  } else if (invitations.data.items.length === 0) {
    body = (
      <p className="flex items-center gap-2 text-sm text-fg-muted">
        <MailPlus className="size-5 shrink-0" aria-hidden="true" />
        No open invitation. Each link works once and expires after 72 hours.
      </p>
    );
  } else {
    body = (
      <ul
        aria-label="Open invitations"
        className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface"
      >
        {invitations.data.items.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="break-all text-sm font-medium text-fg">
                {item.email}
              </span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                <RoleBadge role={item.role} />
                {item.role === "admin" ? null : (
                  <span>{describeGrants(item.grants)}</span>
                )}
                <span>
                  Expires{" "}
                  <time dateTime={item.expiresAt}>
                    {formatDateTime(item.expiresAt)}
                  </time>
                </span>
                <span>by {item.invitedBy}</span>
              </div>
            </div>
            <Button
              size="md"
              className="min-h-11 sm:min-h-8"
              onClick={() => {
                setRevoking(item);
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card
      title="Invitations"
      description="Links that add a teammate with a role and, for editors and viewers, their servers."
      aside={
        <Button
          variant="primary"
          disabled={!canInvite}
          onClick={() => {
            setInviteOpen(true);
          }}
          icon={<MailPlus className="size-4" aria-hidden="true" />}
        >
          Invite
        </Button>
      }
    >
      {body}
      <InviteDialog
        open={inviteOpen}
        actor={actor}
        servers={servers}
        onClose={() => {
          setInviteOpen(false);
        }}
        onRevealed={onRevealed}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null);
        }}
        title="Revoke this invitation?"
        description={
          revoking === null
            ? ""
            : `The link sent to ${revoking.email} stops working at once.`
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

function StatTile({
  icon,
  label,
  value,
  caption,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4 shadow-card">
      <span className="flex items-center gap-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
        {icon}
        {label}
      </span>
      <span className="font-heading text-3xl font-semibold text-fg">
        {value}
      </span>
      <span className="text-xs text-fg-muted">{caption}</span>
    </div>
  );
}

function UsersAdmin({ actor }: { actor: User }) {
  const client = useQueryClient();
  const toast = useToast();
  const users = useQuery(usersQuery());
  const servers = useQuery(serversQuery());
  const entitlement = useQuery(entitlementQuery());
  const table = useMediaQuery(TABLE_QUERY);
  const [roleUser, setRoleUser] = useState<UserView | null>(null);
  const [grantsUser, setGrantsUser] = useState<UserView | null>(null);
  const [resetUser, setResetUser] = useState<UserView | null>(null);
  const [anonUser, setAnonUser] = useState<UserView | null>(null);
  const [deleteUserRow, setDeleteUserRow] = useState<UserView | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: p8keys.users });
  const failed = (title: string) => (error: unknown) => {
    toast.push({ kind: "error", title, description: errorMessage(error) });
  };

  const reset = useMutation({
    mutationFn: (id: string) => createResetLink(id),
    onSuccess: (link, id) => {
      const target = users.data?.items.find((item) => item.id === id);
      setResetUser(null);
      setRevealed({
        title: "Password reset link",
        description: `Hand this link to ${target?.name ?? "the user"} yourself. It works once and expires ${formatDateTime(link.expiresAt)}.`,
        label: "Reset link",
        value: link.link,
        note: "Every session of the account ends when the link is used.",
      });
    },
    onError: failed("The reset link was not made"),
  });

  const anonymise = useMutation({
    mutationFn: (id: string) => anonymiseUser(id),
    onSuccess: (updated) => {
      void refresh();
      setAnonUser(null);
      toast.push({
        kind: "success",
        title: "User anonymised",
        description: `The account now reads ${updated.name}; its history keeps the id only.`,
      });
    },
    onError: failed("The user was not anonymised"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      void refresh();
      setDeleteUserRow(null);
      toast.push({ kind: "success", title: "User deleted" });
    },
    onError: failed("The user was not deleted"),
  });

  const exportData = useMutation({
    mutationFn: (id: string) => exportUser(id),
    onSuccess: (result, id) => {
      const target = users.data?.items.find((item) => item.id === id);
      const safe = (target?.email ?? id).replace(/[^a-z0-9]+/gi, "-");
      downloadBlob(result.blob, result.filename ?? `dialwarden-${safe}.json`);
      toast.push({
        kind: "success",
        title: "Export started",
        description:
          "The file holds the person's data; no credential is in it.",
      });
    },
    onError: failed("The export failed"),
  });

  const actions: RowActions = {
    onRole: setRoleUser,
    onGrants: setGrantsUser,
    onReset: setResetUser,
    onExport: (user) => {
      exportData.mutate(user.id);
    },
    onAnonymise: setAnonUser,
    onDelete: setDeleteUserRow,
  };

  const items = users.data?.items ?? [];
  const fallbackCount = items.filter(inFallback).length;
  const paid = entitlement.data?.plan === "paid";
  const grantServers: GrantServer[] = (servers.data?.items ?? []).map(
    (server) => ({
      id: server.id,
      name: server.name,
      displayName: server.displayName,
    }),
  );

  let body: ReactNode;
  if (users.isPending) {
    body = <RowsSkeleton rows={3} />;
  } else if (users.isError) {
    body = (
      <ErrorState
        message={errorMessage(users.error)}
        onRetry={() => {
          void users.refetch();
        }}
        retrying={users.isFetching}
      />
    );
  } else if (table) {
    body = (
      <Table label="Users">
        <thead>
          <tr>
            <Th>User</Th>
            <Th>Role</Th>
            <Th>Access</Th>
            <Th>Sign-in</Th>
            <Th>Since</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              actor={actor}
              actions={actions}
            />
          ))}
        </tbody>
      </Table>
    );
  } else {
    body = (
      <ul
        aria-label="Users"
        className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface shadow-card"
      >
        {items.map((user) => (
          <UserCard key={user.id} user={user} actor={actor} actions={actions} />
        ))}
      </ul>
    );
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Teammates, their roles and the servers each one may see or change."
      />
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            icon={<Users className="size-5 shrink-0" aria-hidden="true" />}
            label="Users"
            value={users.isPending ? "…" : String(items.length)}
            caption={
              paid ? "No limit on the Paid plan" : "The Free plan includes one"
            }
          />
          <StatTile
            icon={
              <ShieldCheck className="size-5 shrink-0" aria-hidden="true" />
            }
            label="Admins"
            value={
              users.isPending
                ? "…"
                : String(items.filter((user) => user.role === "admin").length)
            }
            caption="Manage servers, users and the audit log"
          />
          <StatTile
            icon={<UserRound className="size-5 shrink-0" aria-hidden="true" />}
            label="Acting as viewer"
            value={users.isPending ? "…" : String(fallbackCount)}
            caption={
              fallbackCount > 0
                ? "Stored roles paused on the Free plan"
                : "Every stored role is in force"
            }
          />
        </div>
        {fallbackCount > 0 ? (
          <>
            <Alert kind="warning" title="Roles paused on the Free plan">
              {FALLBACK_REASON}
            </Alert>
            <UpgradeHint
              body={{
                error: "payment_required",
                plan: "free",
                feature: "team.roles",
              }}
            />
          </>
        ) : null}
        <Card
          title="Users"
          description="The stored role, the servers each one reaches and how they sign in."
        >
          {body}
        </Card>
        <InvitationsCard
          actor={actor}
          servers={grantServers}
          onRevealed={setRevealed}
        />
      </div>
      <RoleDialog
        user={roleUser}
        actor={actor}
        onClose={() => {
          setRoleUser(null);
        }}
      />
      <GrantsDialog
        user={grantsUser}
        servers={grantServers}
        onClose={() => {
          setGrantsUser(null);
        }}
      />
      <ConfirmDialog
        open={resetUser !== null}
        onOpenChange={(next) => {
          if (!next) setResetUser(null);
        }}
        title="Make a password reset link?"
        description={
          resetUser === null
            ? ""
            : `A single-use link for ${resetUser.name}, valid 24 hours. Hand it over yourself; Dialwarden sends no e-mail.`
        }
        confirmLabel="Make the link"
        loading={reset.isPending}
        onConfirm={() => {
          if (resetUser !== null) reset.mutate(resetUser.id);
        }}
      />
      <ConfirmDialog
        open={anonUser !== null}
        onOpenChange={(next) => {
          if (!next) setAnonUser(null);
        }}
        title="Anonymise this user?"
        description={
          anonUser === null
            ? ""
            : `${anonUser.name} loses the name, e-mail address and sign-in; the history and the audit log keep an erased label. This cannot be undone.`
        }
        confirmLabel="Anonymise"
        destructive
        loading={anonymise.isPending}
        onConfirm={() => {
          if (anonUser !== null) anonymise.mutate(anonUser.id);
        }}
      />
      <ConfirmDialog
        open={deleteUserRow !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteUserRow(null);
        }}
        title="Delete this user?"
        description={
          deleteUserRow === null
            ? ""
            : `${deleteUserRow.name} is removed with every session, token and open link. The history and the audit log keep an erased label. This cannot be undone.`
        }
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleteUserRow !== null) remove.mutate(deleteUserRow.id);
        }}
      />
      <RevealOnce
        revealed={revealed}
        onDone={() => {
          setRevealed(null);
        }}
      />
    </>
  );
}

export function UsersPage() {
  const actor = useSessionUser();
  const canManage = useCanManageUsers();
  if (actor === null) {
    return <CardSkeleton />;
  }
  if (!canManage) {
    return (
      <>
        <PageHeader
          title="Users"
          description="Teammates, their roles and the servers each one may see or change."
        />
        <EmptyState
          icon={<UsersRound className="size-6" aria-hidden="true" />}
          title="Managed by the owner and admins"
          description={`You are signed in as ${roleWord(actor.role).toLowerCase()}: you see the servers granted to you, and the owner or an admin manages the team.`}
        />
      </>
    );
  }
  return <UsersAdmin actor={actor} />;
}
