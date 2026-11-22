// The global strip under the top bar while an internal-dev licence is the
// effective licence (dev-work-plan P1-A step 5: always shown, never on a
// production instance). Steel 700 with Ice text in light; Steel with Midnight
// text in dark (design-direction-1 part 2.4).
import { FlaskConical } from "lucide-react";
import type { Entitlement } from "../api/schema";

export function isDevLicenceEffective(entitlement: Entitlement): boolean {
  return (
    entitlement.plan === "paid" && entitlement.licence?.kind === "internal-dev"
  );
}

export function DevLicenceBanner({
  entitlement,
}: {
  entitlement: Entitlement | undefined;
}) {
  if (entitlement === undefined || !isDevLicenceEffective(entitlement)) {
    return null;
  }
  const name = entitlement.licence?.customerName;
  return (
    <div
      role="status"
      className="flex h-9 items-center justify-center gap-2 bg-banner px-4 text-sm font-medium text-banner-fg"
    >
      <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
      <span>Development licence, not for production</span>
      {name !== null && name !== undefined ? (
        <span className="hidden text-banner-fg/80 sm:inline">({name})</span>
      ) : null}
    </div>
  );
}
