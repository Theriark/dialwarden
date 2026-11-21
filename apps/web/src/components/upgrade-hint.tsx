// Renders every 402 body of contract C1: the feature or limit in plain words,
// the current and maximum values for a limit, no price and no outside link
// (dev-work-plan P1-B; 27.0.0 has no checkout). The words mirror the labels of
// packages/entitlement/src/registry.ts; an unknown key falls back to itself.
import { Lock } from "lucide-react";
import type { PaymentRequiredBody } from "../api/schema";
import { cn } from "../lib/cn";

export const FEATURE_WORDS = new Map<string, string>([
  ["presets.bulk", "applying presets to many servers at once"],
  ["schedules", "scheduled changes"],
  ["drift.background", "background drift checks"],
  ["notifications", "notification channels"],
  ["team.users", "more than one user"],
  ["team.roles", "user roles and per-server grants"],
  ["audit", "the audit log"],
  ["oidc", "single sign-on"],
  ["apiTokens", "API tokens"],
  ["fleet.matrix", "the fleet settings matrix"],
  ["reports", "reports"],
  ["assistant", "the settings assistant"],
]);

export const LIMIT_WORDS = new Map<string, string>([
  ["servers", "editable servers"],
  ["users", "users"],
  ["historyVisible", "visible versions"],
  ["presets", "saved presets"],
]);

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The sentence for a 402 body, in plain words. */
export function upgradeSentence(body: PaymentRequiredBody): string {
  if (body.feature !== undefined) {
    const words = FEATURE_WORDS.get(body.feature) ?? body.feature;
    return `${capitalise(words)} is part of the Paid plan.`;
  }
  if (body.limit !== undefined) {
    const words = LIMIT_WORDS.get(body.limit) ?? body.limit;
    const amount = body.max === undefined ? words : `${body.max} ${words}`;
    const paid =
      body.limit === "servers"
        ? "A Paid licence raises it to the servers it covers."
        : "The Paid plan removes this limit.";
    return `The Free plan includes ${amount}. ${paid}`;
  }
  return "This needs the Paid plan.";
}

interface UpgradeHintProps {
  body: PaymentRequiredBody;
  className?: string | undefined;
}

export function UpgradeHint({ body, className }: UpgradeHintProps) {
  const usage =
    body.current !== undefined && body.max !== undefined
      ? `${body.current} of ${body.max} in use`
      : null;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-card border border-border-strong bg-accent-soft p-4",
        className,
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-primary">
        <Lock className="size-4" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-semibold text-fg">Paid plan</p>
        <p className="text-fg">{upgradeSentence(body)}</p>
        {usage !== null ? (
          <p className="font-mono text-xs text-fg-muted tabular">{usage}</p>
        ) : null}
        <p className="text-fg-muted">
          Add a licence key on the Licence page under Settings.
        </p>
      </div>
    </div>
  );
}
