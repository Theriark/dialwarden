// The matrix (dev-work-plan P9-C step 5, Paid feature fleet.matrix): the
// settings of one game by its servers, one row per setting, one column per
// server, the first column sticky, the rows that differ marked with a badge
// and a left rule (never colour alone), narrowed by settings group, by
// server and to the differences only. Designed states for no server, one
// server (nothing to compare, the values are listed) and the Free plan.
/* eslint-disable security/detect-object-injection -- the keys are the server ids of the server's own JSON answer, never free-form input */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CircleX,
  Equal,
  EyeOff,
  LayoutGrid,
  Lock,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import { matrixQuery, serversQuery } from "../api/queries";
import type { Matrix, MatrixRow, Server } from "../api/schema";
import { useIsOwner } from "../api/session";
import { formatChipValue } from "../components/change-chip";
import { PageHeader } from "../components/layout/page-header";
import { UpgradeHint } from "../components/upgrade-hint";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SelectField } from "../components/ui/field";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { SwitchField } from "../components/ui/switch";
import { cn } from "../lib/cn";

export interface GameChoice {
  readonly packId: string;
  readonly displayName: string;
  readonly count: number;
}

/** The games the fleet runs, with how many servers each. */
export function gamesOf(servers: readonly Server[]): GameChoice[] {
  const out = new Map<string, GameChoice>();
  for (const server of servers) {
    const found = out.get(server.packId);
    if (found === undefined) {
      out.set(server.packId, {
        packId: server.packId,
        displayName: server.displayName,
        count: 1,
      });
    } else {
      out.set(server.packId, { ...found, count: found.count + 1 });
    }
  }
  return [...out.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}

/** A cell's text: the chip value words, or hidden for a secret. */
export function cellText(row: MatrixRow, serverId: string): string {
  if (row.secret) {
    return "hidden";
  }
  if (!(serverId in row.values)) {
    return "—";
  }
  return formatChipValue(row.values[serverId]);
}

const HEAD =
  "sticky top-0 z-20 border-b border-border-strong bg-surface px-3 py-2 text-left text-xs font-medium tracking-wide text-fg-muted uppercase";
const FIRST =
  "sticky left-0 z-10 border-r border-border bg-surface px-3 py-2 text-left";

function MatrixTable({
  matrix,
  differencesOnly,
}: {
  matrix: Matrix;
  differencesOnly: boolean;
}) {
  const rows = differencesOnly
    ? matrix.rows.filter((row) => row.differs)
    : matrix.rows;
  if (rows.length === 0) {
    return (
      <Alert kind="success" title="No difference">
        Every server of {matrix.displayName} holds the same values
        {matrix.group === null ? "" : ` in ${matrix.group}`}.
      </Alert>
    );
  }
  return (
    <div className="max-h-[70dvh] overflow-auto rounded-card border border-border bg-surface shadow-card">
      <table
        aria-label={`${matrix.displayName} settings by server`}
        className="w-full border-collapse text-sm"
      >
        <thead>
          <tr>
            <th scope="col" className={cn(HEAD, FIRST, "z-30 min-w-56")}>
              Setting
            </th>
            {matrix.servers.map((server) => (
              <th
                key={server.id}
                scope="col"
                className={cn(HEAD, "min-w-40 whitespace-nowrap")}
              >
                <span className="flex flex-col gap-1">
                  <Link
                    to="/servers/$slug/settings"
                    params={{ slug: server.id }}
                    className="normal-case text-fg hover:text-primary"
                  >
                    {server.name}
                  </Link>
                  <span className="flex gap-1">
                    {server.editable ? null : (
                      <Badge kind="neutral" icon={<Lock className="size-3" />}>
                        Read-only
                      </Badge>
                    )}
                    {server.error === null ? null : (
                      <span title={server.error}>
                        <Badge
                          kind="error"
                          icon={<CircleX className="size-3" />}
                        >
                          Unreadable
                        </Badge>
                      </span>
                    )}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={cn(
                row.differs
                  ? "border-l-4 border-l-warning bg-warning-soft/30"
                  : "border-l-4 border-l-transparent",
              )}
            >
              <th scope="row" className={cn(FIRST, "font-medium text-fg")}>
                <span className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {row.label}
                    {row.differs ? (
                      <Badge
                        kind="warning"
                        icon={<TriangleAlert className="size-3" />}
                      >
                        Differs
                      </Badge>
                    ) : (
                      <Badge kind="neutral" icon={<Equal className="size-3" />}>
                        Same
                      </Badge>
                    )}
                    {row.secret ? (
                      <Badge
                        kind="neutral"
                        icon={<EyeOff className="size-3" />}
                      >
                        Secret
                      </Badge>
                    ) : null}
                  </span>
                  <span className="font-mono text-[11px] font-normal text-fg-muted">
                    {row.key}
                    {row.group === null ? "" : ` · ${row.group}`}
                  </span>
                </span>
              </th>
              {matrix.servers.map((server) => {
                const text = cellText(row, server.id);
                return (
                  <td
                    key={server.id}
                    className={cn(
                      "border-b border-border px-3 py-2 align-top font-mono text-xs break-all",
                      text === "hidden" || text === "—"
                        ? "text-fg-muted"
                        : "text-fg",
                    )}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MatrixPage() {
  const isOwner = useIsOwner();
  const servers = useQuery(serversQuery());
  const games = gamesOf(servers.data?.items ?? []);
  const [game, setGame] = useState("");
  const [group, setGroup] = useState("");
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [differencesOnly, setDifferencesOnly] = useState(false);

  useEffect(() => {
    // The first game of the fleet is chosen for the person; a game that
    // left the fleet gives way to the first again.
    if (games.length > 0 && !games.some((item) => item.packId === game)) {
      setGame(games[0]?.packId ?? "");
      setGroup("");
      setChosen(null);
    }
  }, [games, game]);

  const gameServers = (servers.data?.items ?? []).filter(
    (server) => server.packId === game,
  );
  const selected =
    chosen === null
      ? gameServers.map((server) => server.id)
      : chosen.filter((id) => gameServers.some((server) => server.id === id));
  const matrix = useQuery({
    ...matrixQuery(
      game,
      group === "" ? null : group,
      chosen === null ? [] : selected,
    ),
    enabled: game !== "" && (chosen === null || selected.length > 0),
  });

  if (servers.isPending) {
    return (
      <>
        <PageHeader title="Matrix" description="Loading the fleet…" />
        <RowsSkeleton rows={5} />
      </>
    );
  }

  if (servers.isError) {
    return (
      <>
        <PageHeader title="Matrix" />
        <ErrorState
          message="The server list could not be loaded."
          onRetry={() => {
            void servers.refetch();
          }}
        />
      </>
    );
  }

  const header = (
    <PageHeader
      title="Matrix"
      description="The settings of every server of one game, side by side, with the differences marked."
    />
  );

  if (games.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={<LayoutGrid className="size-6" aria-hidden="true" />}
          title="No servers to compare"
          description={
            isOwner
              ? "Add two servers of the same game and their settings line up here, row by row."
              : "No game server is set up yet. Ask the owner to add the first one."
          }
          action={
            isOwner ? (
              <Link
                to="/servers/new"
                className="inline-flex h-10 items-center gap-2 rounded-control border border-transparent bg-primary px-4 text-base font-medium text-primary-fg transition-colors duration-150 hover:opacity-90"
              >
                <Plus className="size-4" aria-hidden="true" />
                Add server
              </Link>
            ) : undefined
          }
        />
      </>
    );
  }

  const payment =
    matrix.error instanceof ApiError ? matrix.error.paymentRequired : null;

  return (
    <>
      {header}
      <div className="mb-4 flex flex-col gap-3 rounded-card border border-border bg-surface p-3 shadow-card">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <SelectField
            id="matrix-game"
            label="Game"
            value={game}
            options={games.map((item) => ({
              value: item.packId,
              label: `${item.displayName} (${item.count} ${item.count === 1 ? "server" : "servers"})`,
            }))}
            onChange={(next) => {
              setGame(next);
              setGroup("");
              setChosen(null);
            }}
          />
          <SelectField
            id="matrix-group"
            label="Settings group"
            placeholder="Every group"
            value={group}
            disabled={matrix.data === undefined}
            options={(matrix.data?.groups ?? []).map((name) => ({
              value: name,
              label: name,
            }))}
            onChange={setGroup}
          />
          <div className="md:pt-7">
            <SwitchField
              id="matrix-differences"
              label="Differences only"
              checked={differencesOnly}
              onCheckedChange={setDifferencesOnly}
            />
          </div>
        </div>
        {gameServers.length > 1 ? (
          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <legend className="mb-1 text-sm font-medium text-fg">
              Servers
            </legend>
            {gameServers.map((server) => {
              const id = `matrix-server-${server.id}`;
              return (
                <label
                  key={server.id}
                  htmlFor={id}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="size-4 accent-[var(--dw-primary)]"
                    checked={selected.includes(server.id)}
                    onChange={() => {
                      const next = selected.includes(server.id)
                        ? selected.filter((item) => item !== server.id)
                        : [...selected, server.id];
                      setChosen(next);
                    }}
                  />
                  {server.name}
                </label>
              );
            })}
            {chosen !== null ? (
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setChosen(null);
                }}
              >
                Show all servers
              </Button>
            ) : null}
          </fieldset>
        ) : null}
      </div>
      {chosen !== null && selected.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid className="size-6" aria-hidden="true" />}
          title="No server chosen"
          description="Tick at least one server above to see its settings; two or more line up for a comparison."
          action={
            <Button
              variant="primary"
              onClick={() => {
                setChosen(null);
              }}
            >
              Show all servers
            </Button>
          }
        />
      ) : matrix.isPending ? (
        <RowsSkeleton rows={8} />
      ) : matrix.isError ? (
        payment !== null ? (
          <div className="flex flex-col gap-4">
            <UpgradeHint body={payment} />
            <Alert kind="info" title="What the matrix shows">
              Every setting of{" "}
              {games.find((item) => item.packId === game)?.displayName ??
                "a game"}{" "}
              with one column per server, the rows that differ marked, narrowed
              by group or to the differences only. The settings of each server
              stay readable on its own page.
            </Alert>
          </div>
        ) : (
          <ErrorState
            message={errorMessage(matrix.error)}
            onRetry={() => {
              void matrix.refetch();
            }}
            retrying={matrix.isFetching}
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {matrix.data.servers.length === 0 ? (
            <EmptyState
              icon={<LayoutGrid className="size-6" aria-hidden="true" />}
              title="No readable server"
              description="None of the chosen servers is in your fleet; the matrix shows only the servers you may read."
            />
          ) : (
            <>
              {matrix.data.servers.length === 1 ? (
                <Alert kind="info" title="Only one server to show">
                  Nothing to compare yet: the values of{" "}
                  {matrix.data.servers[0]?.name ?? "the server"} are listed. Add
                  another {matrix.data.displayName} server, or tick more servers
                  above, and the differences show here.
                </Alert>
              ) : (
                <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                  <Badge
                    kind={matrix.data.differing > 0 ? "warning" : "success"}
                  >
                    {matrix.data.differing} of {matrix.data.rows.length}{" "}
                    settings differ
                  </Badge>
                  across {matrix.data.servers.length} servers of{" "}
                  {matrix.data.displayName}
                  {matrix.data.group === null ? "" : ` in ${matrix.data.group}`}
                  .
                </p>
              )}
              <MatrixTable
                matrix={matrix.data}
                differencesOnly={differencesOnly}
              />
            </>
          )}
        </div>
      )}
    </>
  );
}
