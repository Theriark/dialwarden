// About: version, revision and build date from /healthz, the Free versus Paid
// list from the registry, the licence words, the outbound connections list
// and the not-affiliated notice (dev-work-plan P1-B, legal-input-1 rule 4).
import { useQuery } from "@tanstack/react-query";
import { Check, Minus } from "lucide-react";
import { entitlementQuery, healthQuery, registryQuery } from "../api/queries";
import { errorMessage } from "../api/errors";
import { PageHeader } from "../components/layout/page-header";
import { Badge } from "../components/ui/badge";
import { Card, Fact } from "../components/ui/card";
import { CardSkeleton, ErrorState } from "../components/ui/states";
import { Table, Td, Th } from "../components/ui/table";
import { formatDateTime } from "../lib/format";

export const NOT_AFFILIATED =
  "Dialwarden is a product of Theriark. It is not affiliated with, endorsed by or sponsored by Valve, Steam or any game publisher or developer. Game names are used only to identify the servers you manage.";

export const SOURCE_AVAILABLE =
  "Dialwarden is source-available under FCL-1.0-MIT. The source code is public and becomes MIT two years after each release.";

const NO_OUTBOUND =
  "No outbound connection is configured. There is no telemetry and no update check.";

const LIST_ICON = "size-4 shrink-0 text-primary";

function paidValue(value: number | null | "licence"): string {
  if (value === null) {
    return "Unlimited";
  }
  if (value === "licence") {
    return "As many as the licence covers";
  }
  return String(value);
}

function InstanceCard() {
  const health = useQuery(healthQuery());
  if (health.isPending) {
    return <CardSkeleton />;
  }
  if (health.isError) {
    return (
      <ErrorState
        message={errorMessage(health.error)}
        onRetry={() => {
          void health.refetch();
        }}
        retrying={health.isFetching}
      />
    );
  }
  const info = health.data;
  return (
    <Card
      title="This instance"
      aside={
        <Badge kind={info.plan === "paid" ? "success" : "info"}>
          {info.plan === "paid" ? "Paid" : "Free"}
        </Badge>
      }
    >
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <Fact label="Version" mono>{info.version}</Fact>
        <Fact label="Revision" mono>{info.revision}</Fact>
        <Fact label="Build date">{formatDateTime(info.buildDate)}</Fact>
        <Fact label="Feature baseline">
          {formatDateTime(info.featureBaseline)}
        </Fact>
      </dl>
    </Card>
  );
}

function PlansCard() {
  const registry = useQuery(registryQuery());
  const entitlement = useQuery(entitlementQuery());
  if (registry.isPending) {
    return <CardSkeleton />;
  }
  if (registry.isError) {
    return (
      <ErrorState
        message={errorMessage(registry.error)}
        onRetry={() => {
          void registry.refetch();
        }}
        retrying={registry.isFetching}
      />
    );
  }
  const data = registry.data;
  const plan = entitlement.data?.plan;
  return (
    <Card
      title="Free and Paid"
      description="One image, two plans. A licence key unlocks Paid on this instance."
    >
      <Table label="Plan limits and features">
        <thead>
          <tr>
            <Th>What</Th>
            <Th>{plan === "free" ? "Free (this instance)" : "Free"}</Th>
            <Th>{plan === "paid" ? "Paid (this instance)" : "Paid"}</Th>
          </tr>
        </thead>
        <tbody>
          {data.limits.map((limit) => (
            <tr key={limit.key}>
              <Td>{limit.label}</Td>
              <Td mono>{String(limit.free)}</Td>
              <Td>{paidValue(limit.paid)}</Td>
            </tr>
          ))}
          {data.features.map((feature) => (
            <tr key={feature.key}>
              <Td>{feature.label}</Td>
              <Td>
                <span className="inline-flex items-center gap-1 text-fg-muted">
                  <Minus className="size-4" aria-hidden="true" />
                  Not included
                </span>
              </Td>
              <Td>
                {feature.available ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <Check className="size-4" aria-hidden="true" />
                    Included
                  </span>
                ) : (
                  <span className="text-fg-muted">Not in this version</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="flex flex-col gap-2">
        <h3 className="font-heading text-base font-semibold">Always free</h3>
        <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          {data.alwaysFree.map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check className={LIST_ICON} aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function AboutPage() {
  return (
    <>
      <PageHeader
        title="About"
        description="What this instance runs, what each plan includes, and who makes it."
      />
      <div className="flex flex-col gap-6">
        <InstanceCard />
        <PlansCard />
        <Card title="Licence and ownership">
          <p className="text-sm text-fg">{SOURCE_AVAILABLE}</p>
          <p className="text-sm text-fg">{NOT_AFFILIATED}</p>
        </Card>
        <Card
          title="Outbound connections"
          description="Everything this instance may talk to. Nothing is on by default."
        >
          <ul className="text-sm text-fg">
            <li className="flex items-center gap-2">
              <Badge kind="neutral">none</Badge>
              {NO_OUTBOUND}
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
