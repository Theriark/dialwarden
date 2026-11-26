// Reports (dev-work-plan P9-C step 6, Paid feature reports): the change
// report of a time range and a set of servers, previewed as the HTML print
// view looks (a paper sheet with one table per server), the Markdown to
// copy, and the Discord message as it lands. The chips of every entry wear
// the house chip. The print view itself is the server's own page, opened in
// a new tab. Any signed-in user; the report holds only readable servers.
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  FileText,
  MessageSquare,
  Printer,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import { reportPrintUrl, reportQuery, serversQuery } from "../api/queries";
import type { Report, ReportSelection, Server } from "../api/schema";
import { TextChip } from "../components/change-chip";
import { PageHeader } from "../components/layout/page-header";
import { UpgradeHint } from "../components/upgrade-hint";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { CopyButton } from "../components/ui/code-block";
import { TextField } from "../components/ui/field";
import { EmptyState, ErrorState, RowsSkeleton } from "../components/ui/states";
import { Tabs } from "../components/ui/tabs";
import { DISPLAY_ZONE, formatDateTime } from "../lib/format";
import { isoOfLocalInput, localInputValue } from "../lib/time";

/** The local datetime value of now minus some days, in the display zone. */
function daysAgoLocal(days: number, now = new Date()): string {
  return localInputValue(
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    DISPLAY_ZONE,
  );
}

/** The report query of the form: a range and the chosen servers. */
export function selectionOf(
  fromLocal: string,
  toLocal: string,
  servers: readonly string[],
  all: boolean,
): ReportSelection {
  const from = isoOfLocalInput(fromLocal, DISPLAY_ZONE);
  const to = isoOfLocalInput(toLocal, DISPLAY_ZONE);
  return {
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
    ...(all ? {} : { servers }),
  };
}

/** "2026-11-25 22:10 UTC", the time words of the export. */
export function utcWords(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function summaryWords(report: Report): string {
  const range =
    report.from === null && report.to === null
      ? ""
      : `, ${report.from === null ? "start" : utcWords(report.from)} to ${
          report.to === null ? "now" : utcWords(report.to)
        }`;
  return `${report.entryCount} change sets${report.truncated ? " (first 500)" : ""} on ${report.servers.length} servers${range}`;
}

/** The preview that looks like the export: a white sheet, one table per server. */
export function PrintPreview({ report }: { report: Report }) {
  return (
    <div
      aria-label="Report preview"
      className="overflow-x-auto rounded-card border border-border-strong bg-white p-6 text-[#111] shadow-card sm:p-8"
    >
      <h2 className="m-0 font-sans text-xl font-semibold">
        Dialwarden change report
      </h2>
      <p className="mt-1 mb-4 text-sm text-[#555]">
        Generated {utcWords(report.generatedAt)}: {summaryWords(report)}.
      </p>
      {report.servers.length === 0 ? (
        <p className="text-sm">No changes.</p>
      ) : (
        report.servers.map((server) => (
          <section key={server.id} className="mt-6 first:mt-0">
            <h3 className="mb-2 font-sans text-base font-semibold">
              {server.name} ({server.game})
            </h3>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["When", "Cause", "Status", "By", "Changes"].map((head) => (
                    <th
                      key={head}
                      scope="col"
                      className="border border-[#ccc] bg-[#f3f3f3] px-2 py-1.5 text-left font-semibold"
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {server.entries.map((entry) => (
                  <tr key={entry.changeSetId}>
                    <td className="border border-[#ccc] px-2 py-1.5 align-top whitespace-nowrap">
                      {utcWords(entry.at)}
                    </td>
                    <td className="border border-[#ccc] px-2 py-1.5 align-top">
                      {entry.cause}
                    </td>
                    <td className="border border-[#ccc] px-2 py-1.5 align-top">
                      {entry.status}
                    </td>
                    <td className="border border-[#ccc] px-2 py-1.5 align-top">
                      {entry.author}
                    </td>
                    <td className="border border-[#ccc] px-2 py-1.5 align-top">
                      <ul className="flex flex-wrap gap-1">
                        {entry.chips.map((chip, index) => (
                          <TextChip
                            key={`${entry.changeSetId}-${index}`}
                            text={chip}
                          />
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}

/** The Discord message as it lands: bold lines, then one chip per change. */
export function DiscordPreview({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div
      aria-label="Discord preview"
      className="flex gap-3 rounded-card border border-[#1f2124] bg-[#313338] p-4 text-sm text-[#dbdee1]"
    >
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary font-heading text-sm font-semibold text-primary-fg"
      >
        DW
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-white">Dialwarden</span>
          <span className="rounded bg-[#5865f2] px-1 text-[10px] font-semibold text-white uppercase">
            App
          </span>
          <span className="text-xs text-[#949ba4]">now</span>
        </span>
        {lines.map((line, index) => {
          const chip = /^- (.*)$/.exec(line);
          if (chip !== null) {
            const [head, ...rest] = (chip[1] ?? "").split(": ");
            const chips = rest
              .join(": ")
              .split("; ")
              .filter((item) => item !== "");
            return (
              <div key={index} className="flex flex-col gap-1 pl-2">
                <span className="text-xs text-[#949ba4]">{head}</span>
                <ul className="flex flex-wrap gap-1">
                  {chips.map((item, chipIndex) => (
                    <TextChip
                      key={`${index}-${chipIndex}`}
                      text={item.replace(/\\(.)/g, "$1")}
                      className="border-[#4e5058] bg-[#2b2d31] text-[#dbdee1]"
                    />
                  ))}
                </ul>
              </div>
            );
          }
          const bold = /^\*\*(.+?)\*\*(.*)$/.exec(line);
          if (bold !== null) {
            return (
              <p key={index} className="m-0">
                <strong className="text-white">
                  {(bold[1] ?? "").replace(/\\(.)/g, "$1")}
                </strong>
                {(bold[2] ?? "").replace(/\\(.)/g, "$1")}
              </p>
            );
          }
          return (
            <p key={index} className="m-0">
              {line.replace(/\\(.)/g, "$1")}
            </p>
          );
        })}
      </div>
    </div>
  );
}

export function ReportsPage() {
  const servers = useQuery(serversQuery());
  const [fromLocal, setFromLocal] = useState(() => daysAgoLocal(7));
  const [toLocal, setToLocal] = useState("");
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [selection, setSelection] = useState<ReportSelection | null>(null);
  const [tab, setTab] = useState("preview");
  const report = useQuery({
    ...reportQuery(selection ?? {}),
    enabled: selection !== null,
  });

  const list: readonly Server[] = servers.data?.items ?? [];
  const build = () => {
    setSelection(selectionOf(fromLocal, toLocal, picked, all));
  };
  const payment =
    report.error instanceof ApiError ? report.error.paymentRequired : null;

  return (
    <>
      <PageHeader
        title="Reports"
        description="A change report you can print, copy as Markdown or post to Discord; the preview is the export."
      />
      <div className="flex flex-col gap-6">
        <Card
          title="Selection"
          description="A time range in Europe/Lisbon and the servers to include; only the servers you may read are ever in a report."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TextField
              id="report-from"
              label="From"
              type="datetime-local"
              value={fromLocal}
              onChange={(event) => {
                setFromLocal(event.target.value);
              }}
            />
            <TextField
              id="report-to"
              label="To"
              type="datetime-local"
              help="Empty means up to now."
              value={toLocal}
              onChange={(event) => {
                setToLocal(event.target.value);
              }}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-fg">
              Servers
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--dw-primary)]"
                checked={all}
                onChange={(event) => {
                  setAll(event.target.checked);
                }}
              />
              Every server I may read
            </label>
            {all ? null : list.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No server in the fleet yet.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-x-4 gap-y-2">
                {list.map((server) => (
                  <li key={server.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--dw-primary)]"
                        checked={picked.includes(server.id)}
                        onChange={() => {
                          setPicked((current) =>
                            current.includes(server.id)
                              ? current.filter((item) => item !== server.id)
                              : [...current, server.id],
                          );
                        }}
                      />
                      {server.name}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={<FileText className="size-4" aria-hidden="true" />}
              loading={report.isFetching}
              disabled={!all && picked.length === 0}
              onClick={build}
            >
              Build the report
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setFromLocal(daysAgoLocal(7));
                setToLocal("");
              }}
            >
              Last 7 days
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setFromLocal(daysAgoLocal(30));
                setToLocal("");
              }}
            >
              Last 30 days
            </Button>
          </div>
        </Card>
        {selection === null ? (
          <EmptyState
            icon={<FileText className="size-6" aria-hidden="true" />}
            title="No report built yet"
            description="Choose a range and the servers, then build the report. The preview shows exactly what the print view and the Markdown carry."
          />
        ) : report.isPending ? (
          <RowsSkeleton rows={6} />
        ) : report.isError ? (
          payment !== null ? (
            <div className="flex flex-col gap-4">
              <UpgradeHint body={payment} />
              <Alert kind="info" title="What a report holds">
                Every change set of the range, grouped by server, with its time,
                cause, status, author and the changes as chips; as a print page,
                as Markdown and as a Discord message. The history of each server
                stays readable on its own page.
              </Alert>
            </div>
          ) : (
            <ErrorState
              message={errorMessage(report.error)}
              onRetry={() => {
                void report.refetch();
              }}
              retrying={report.isFetching}
            />
          )
        ) : (
          <Card
            title="Report"
            description={`Generated ${formatDateTime(report.data.generatedAt)}: ${summaryWords(report.data)}.`}
            aside={
              <div className="flex flex-wrap gap-2">
                <a
                  href={reportPrintUrl(selection)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-fg transition-colors duration-150 hover:bg-accent-soft"
                >
                  <Printer className="size-4" aria-hidden="true" />
                  Open the print view
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
                <CopyButton
                  value={report.data.markdown}
                  label="Copy Markdown"
                />
              </div>
            }
          >
            {report.data.truncated ? (
              <Alert kind="warning">
                <span className="flex items-center gap-2">
                  <TriangleAlert
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                  More than 500 change sets matched; the report holds the newest
                  500. Narrow the range for the rest.
                </span>
              </Alert>
            ) : null}
            <Tabs
              label="Report format"
              items={[
                {
                  id: "preview",
                  label: "Print preview",
                  icon: <Printer className="size-4" aria-hidden="true" />,
                },
                {
                  id: "markdown",
                  label: "Markdown",
                  icon: <FileText className="size-4" aria-hidden="true" />,
                },
                {
                  id: "discord",
                  label: "Discord",
                  icon: <MessageSquare className="size-4" aria-hidden="true" />,
                },
              ]}
              value={tab}
              onChange={setTab}
              panel={(id) =>
                id === "markdown" ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge kind="info">
                        {report.data.markdown.length} characters
                      </Badge>
                      <CopyButton
                        value={report.data.markdown}
                        label="Copy Markdown"
                      />
                    </div>
                    <pre
                      aria-label="Markdown text"
                      className="m-0 max-h-[60dvh] overflow-auto rounded-control border border-border-strong bg-bg p-3 font-mono text-xs whitespace-pre-wrap text-fg"
                    >
                      {report.data.markdown}
                    </pre>
                  </div>
                ) : id === "discord" ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge
                        kind={
                          report.data.discord.content.length >= 1940
                            ? "warning"
                            : "info"
                        }
                      >
                        {report.data.discord.content.length} of 2000 characters
                      </Badge>
                      <CopyButton
                        value={report.data.discord.content}
                        label="Copy the message"
                      />
                    </div>
                    <DiscordPreview content={report.data.discord.content} />
                    <p className="text-xs text-fg-muted">
                      How a Discord notification channel posts it: the same
                      text, with every mention broken so nothing pings.
                    </p>
                  </div>
                ) : (
                  <PrintPreview report={report.data} />
                )
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}
