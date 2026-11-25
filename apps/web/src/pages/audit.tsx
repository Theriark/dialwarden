// The Audit page (dev-work-plan P8-B screen 3): the hash-chained log of
// every state-changing request and every refused sign-in, for the owner and
// admins. Filters by actor, action, server and date range go to the server
// (GET /api/v1/audit); the search box narrows the loaded rows in the
// browser. The chain status comes from the verification endpoint: valid, or
// broken at the first bad row, which the table marks. Reading the log is
// Always Free; the CSV export is the Paid part (feature audit), so on Free
// the export control carries the C1 upgrade hint.
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  Download,
  FilterX,
  Link2,
  Link2Off,
  RefreshCw,
  Rows3,
  Rows4,
  ScrollText,
  Search,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import {
  auditVerifyQuery,
  entitlementQuery,
  fetchAuditPage,
  p8keys,
  serversQuery,
  usersQuery,
} from "../api/queries";
import type {
  AuditEntry,
  AuditFilters,
  AuditVerify,
  PaymentRequiredBody,
} from "../api/schema";
import { useCanManageUsers, useSessionUser } from "../api/session";
import { exportAuditCsv } from "../api/team";
import {
  AuditTable,
  DENSITY_KEY,
  describeAction,
  type Density,
} from "../components/audit-table";
import { PageHeader } from "../components/layout/page-header";
import { roleWord } from "../components/role-badge";
import { UpgradeHint } from "../components/upgrade-hint";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SelectField, TextField } from "../components/ui/field";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  RowsSkeleton,
} from "../components/ui/states";
import { useToast } from "../components/ui/toast";
import { cn } from "../lib/cn";
import { downloadBlob } from "../lib/download";
import { readStored, writeStored } from "../lib/storage";
import { useMediaQuery } from "../lib/use-media-query";

export const PAGE_SIZE = 50;

/** The table from 1024 px up; stacked rows below. */
export const TABLE_QUERY = "(min-width: 1024px)";

const REASON_WORDS: Readonly<Record<string, string>> = {
  gap: "a row is missing",
  prev_mismatch: "a row does not point at the one before it",
  hash_mismatch: "a row was changed after it was written",
  head_mismatch: "the newest rows were removed",
  base_invalid: "the chain start does not match its checkpoint",
};

/** The chain status in words. */
export function chainWords(verify: AuditVerify): string {
  if (verify.valid) {
    const rows = verify.count === 1 ? "1 row" : `${verify.count} rows`;
    return `Chain valid, ${rows}`;
  }
  const reason = REASON_WORDS[verify.reason] ?? verify.reason;
  if (verify.firstBrokenId === null) {
    return `Chain broken: ${reason}`;
  }
  return `Chain broken at row ${verify.firstBrokenId}: ${reason}`;
}

function readDensity(): Density {
  return readStored(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
}

/** A yyyy-mm-dd date input at the given local time, as an ISO instant. */
function localInstant(day: string, end: boolean): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return null;
  }
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  if (end) {
    date.setHours(23, 59, 59, 999);
  }
  return date.toISOString();
}

/**
 * The date inputs as the ISO bounds the server filters on. The inputs show
 * the browser's local days, so a day runs from local midnight to the last
 * millisecond before the next one.
 */
export function dateBounds(from: string, to: string): AuditFilters {
  const out: { from?: string; to?: string } = {};
  const start = localInstant(from, false);
  if (start !== null) {
    out.from = start;
  }
  const last = localInstant(to, true);
  if (last !== null) {
    out.to = last;
  }
  return out;
}

/** Under the Free hint of this page: only the export is Paid. */
export const EXPORT_PAID_SENTENCE =
  "Only the CSV export needs Paid: reading, filtering and checking the log stay on every plan.";

/** The rows whose actor, action, target or address contain the words. */
export function matchesSearch(entry: AuditEntry, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  const hay = [
    entry.actor.label,
    entry.action,
    describeAction(entry.action).word,
    entry.targetType ?? "",
    entry.targetId ?? "",
    entry.serverId ?? "",
    entry.ip ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return needle.split(/\s+/).every((word) => hay.includes(word));
}

function ChainStatus({
  verify,
}: {
  verify: ReturnType<typeof useQuery<AuditVerify>>;
}) {
  if (verify.isPending) {
    return <Badge kind="pending">Checking the chain</Badge>;
  }
  if (verify.isError) {
    return <Badge kind="warning">Chain not checked</Badge>;
  }
  const data = verify.data;
  return (
    <Badge
      kind={data.valid ? "success" : "error"}
      icon={
        data.valid ? (
          <Link2 className="size-3.5" aria-hidden="true" />
        ) : (
          <Link2Off className="size-3.5" aria-hidden="true" />
        )
      }
    >
      {chainWords(data)}
    </Badge>
  );
}

const DENSITY_BUTTON =
  "inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-sm font-medium text-fg-muted hover:bg-accent-soft hover:text-fg aria-pressed:bg-surface aria-pressed:text-fg aria-pressed:shadow-card";

function DensityToggle({
  value,
  onChange,
}: {
  value: Density;
  onChange: (density: Density) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Row density"
      className="flex gap-0.5 rounded-control border border-border bg-bg p-0.5"
    >
      <button
        type="button"
        className={DENSITY_BUTTON}
        aria-pressed={value === "comfortable"}
        onClick={() => {
          onChange("comfortable");
        }}
      >
        <Rows3 className="size-4" aria-hidden="true" />
        Comfortable
      </button>
      <button
        type="button"
        className={DENSITY_BUTTON}
        aria-pressed={value === "compact"}
        onClick={() => {
          onChange("compact");
        }}
      >
        <Rows4 className="size-4" aria-hidden="true" />
        Compact
      </button>
    </div>
  );
}

function AuditAdmin() {
  const toast = useToast();
  const wide = useMediaQuery(TABLE_QUERY);
  const [density, setDensity] = useState<Density>(readDensity);
  const [search, setSearch] = useState("");
  const [actorId, setActorId] = useState("");
  const [action, setAction] = useState("");
  const [serverId, setServerId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exportHint, setExportHint] = useState<PaymentRequiredBody | null>(
    null,
  );

  const filters: AuditFilters = {
    ...(actorId === "" ? {} : { actorId }),
    ...(action === "" ? {} : { action }),
    ...(serverId === "" ? {} : { serverId }),
    ...dateBounds(from, to),
  };
  const filtered = Object.keys(filters).length > 0;

  const feed = useInfiniteQuery({
    queryKey: p8keys.audit(filters),
    queryFn: ({ pageParam }) =>
      fetchAuditPage({ filters, before: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    staleTime: 10_000,
  });
  const verify = useQuery(auditVerifyQuery());
  const servers = useQuery(serversQuery());
  const users = useQuery(usersQuery());
  const entitlement = useQuery(entitlementQuery());

  const exportCsv = useMutation({
    mutationFn: () => exportAuditCsv(filters),
    onSuccess: (result) => {
      downloadBlob(result.blob, result.filename ?? "dialwarden-audit.csv");
      setExportHint(null);
      toast.push({
        kind: "success",
        title: "Export started",
        description: filtered
          ? "The file holds the rows that match the filters."
          : "The file holds every row of the log.",
      });
    },
    onError: (error) => {
      const payment = error instanceof ApiError ? error.paymentRequired : null;
      if (payment !== null) {
        setExportHint(payment);
        return;
      }
      toast.push({
        kind: "error",
        title: "The export failed",
        description: errorMessage(error),
      });
    },
  });

  const loaded = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const rows = loaded.filter((entry) => matchesSearch(entry, search));
  const serverNames = new Map(
    (servers.data?.items ?? []).map((server) => [server.id, server.name]),
  );
  const exportPaid = entitlement.data?.features.audit !== false;
  const hint =
    exportHint ??
    (entitlement.data !== undefined && !exportPaid
      ? ({
          error: "payment_required",
          plan: "free",
          feature: "audit",
        } satisfies PaymentRequiredBody)
      : null);
  const brokenAt =
    verify.data !== undefined && !verify.data.valid
      ? verify.data.firstBrokenId
      : null;

  // The actor choices: every user, plus the labels seen in the loaded rows
  // (erased users and anonymous sign-ins have no user row).
  const actorOptions = new Map<string, string>();
  for (const user of users.data?.items ?? []) {
    actorOptions.set(user.id, `${user.name} (${user.email})`);
  }
  for (const entry of loaded) {
    if (!actorOptions.has(entry.actor.id)) {
      actorOptions.set(entry.actor.id, entry.actor.label);
    }
  }
  if (actorId !== "" && !actorOptions.has(actorId)) {
    actorOptions.set(actorId, actorId);
  }
  const actionOptions = new Map<string, string>();
  for (const entry of loaded) {
    if (!actionOptions.has(entry.action)) {
      actionOptions.set(
        entry.action,
        `${describeAction(entry.action).word} · ${entry.action}`,
      );
    }
  }
  if (action !== "" && !actionOptions.has(action)) {
    actionOptions.set(action, action);
  }

  const clear = () => {
    setSearch("");
    setActorId("");
    setAction("");
    setServerId("");
    setFrom("");
    setTo("");
  };

  let body: ReactNode;
  if (feed.isPending) {
    body = <RowsSkeleton rows={8} />;
  } else if (feed.isError && loaded.length === 0) {
    body = (
      <ErrorState
        message={errorMessage(feed.error)}
        onRetry={() => {
          void feed.refetch();
        }}
        retrying={feed.isFetching}
      />
    );
  } else if (rows.length === 0 && !feed.hasNextPage) {
    body = (
      <EmptyState
        icon={<ScrollText className="size-6" aria-hidden="true" />}
        title={
          filtered || search !== "" ? "No row matches" : "Nothing recorded yet"
        }
        description={
          filtered || search !== ""
            ? "Widen the filters or clear them to see the whole log."
            : "Every sign-in, change and setting saved on this instance appears here as it happens."
        }
        action={
          filtered || search !== "" ? (
            <Button
              onClick={clear}
              icon={<FilterX className="size-4" aria-hidden="true" />}
            >
              Clear filters
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {feed.isError ? (
          <ErrorState
            message="The next page could not be loaded."
            onRetry={() => {
              void feed.fetchNextPage();
            }}
            retrying={feed.isFetchingNextPage}
          />
        ) : null}
        <AuditTable
          items={rows}
          density={density}
          serverNames={serverNames}
          wide={wide}
          brokenAt={brokenAt}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-fg-muted">
            {rows.length} of {loaded.length} loaded{" "}
            {loaded.length === 1 ? "row" : "rows"} shown
            {feed.hasNextPage ? "" : " · everything loaded"}
          </span>
          {feed.hasNextPage ? (
            <Button
              loading={feed.isFetchingNextPage}
              onClick={() => {
                void feed.fetchNextPage();
              }}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every state-changing request and every refused sign-in, in a hash chain the instance checks on request."
        actions={
          <>
            <ChainStatus verify={verify} />
            <Button
              size="md"
              loading={verify.isFetching}
              onClick={() => {
                void verify.refetch();
              }}
              icon={<RefreshCw className="size-4" aria-hidden="true" />}
            >
              Verify again
            </Button>
            <Button
              size="md"
              variant="primary"
              loading={exportCsv.isPending}
              disabled={!exportPaid}
              onClick={() => {
                exportCsv.mutate();
              }}
              icon={<Download className="size-4" aria-hidden="true" />}
            >
              Export CSV
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-4">
        {hint !== null ? (
          <div className="flex flex-col gap-1.5">
            <UpgradeHint body={hint} />
            <p className="text-sm text-fg-muted">{EXPORT_PAID_SENTENCE}</p>
          </div>
        ) : null}
        <section
          aria-label="Audit filters"
          className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <TextField
              id="audit-search"
              label="Search the loaded rows"
              placeholder="Who, what, which id or address"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
            <SelectField
              id="audit-actor"
              label="Who"
              value={actorId}
              placeholder="Everyone"
              options={Array.from(actorOptions, ([value, label]) => ({
                value,
                label,
              }))}
              onChange={setActorId}
            />
            <SelectField
              id="audit-action"
              label="Action"
              value={action}
              placeholder="Every action"
              options={Array.from(actionOptions, ([value, label]) => ({
                value,
                label,
              }))}
              onChange={setAction}
            />
            <SelectField
              id="audit-server"
              label="Server"
              value={serverId}
              placeholder="Every server"
              options={(servers.data?.items ?? []).map((server) => ({
                value: server.id,
                label: server.name,
              }))}
              onChange={setServerId}
            />
            <TextField
              id="audit-from"
              label="From"
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            />
            <TextField
              id="audit-to"
              label="To"
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <Search className="size-4" aria-hidden="true" />
              {filtered
                ? "Filters go to the server; the search box narrows what is loaded."
                : "The search box narrows the loaded rows; the other filters ask the server."}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DensityToggle
                value={density}
                onChange={(next) => {
                  setDensity(next);
                  writeStored(DENSITY_KEY, next);
                }}
              />
              <Button
                size="md"
                variant="ghost"
                disabled={!filtered && search === ""}
                onClick={clear}
                icon={<FilterX className="size-4" aria-hidden="true" />}
              >
                Clear
              </Button>
            </div>
          </div>
        </section>
        <div className={cn(density === "compact" && "text-sm")}>{body}</div>
      </div>
      <span className="sr-only" aria-live="polite">
        {verify.data === undefined ? "" : chainWords(verify.data)}
      </span>
    </>
  );
}

export function AuditPage() {
  const actor = useSessionUser();
  const canRead = useCanManageUsers();
  if (actor === null) {
    return <CardSkeleton />;
  }
  if (!canRead) {
    return (
      <>
        <PageHeader
          title="Audit log"
          description="Every state-changing request and every refused sign-in, in a hash chain the instance checks on request."
        />
        <EmptyState
          icon={<ScrollText className="size-6" aria-hidden="true" />}
          title="Read by the owner and admins"
          description={`You are signed in as ${roleWord(actor.role).toLowerCase()}. Your own changes are recorded here; the owner or an admin can show them to you.`}
        />
      </>
    );
  }
  return <AuditAdmin />;
}
