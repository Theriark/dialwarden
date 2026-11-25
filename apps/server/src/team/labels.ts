// The display label of an actor id (R&D decision Q4, D7). Since P8-A every
// table that names the acting user stores the internal user id, never the
// e-mail address, so erasing a person never has to rewrite history rows; the
// APIs keep their author and actor fields and carry the label instead. The
// audit-actors row wins (it keeps the erased label of a gone user), then the
// e-mail of a living user; an id with no row shows as itself, so nothing is
// invented. "system" and the outside-edit author stay as they are.
import { eq, inArray } from "drizzle-orm";
import { auditActors, users } from "../db/schema.js";
import type { Store } from "../db/store.js";

/** Actor ids that are not users and keep their own label. */
const KEPT = new Map<string, string>([
  ["system", "system"],
  ["unknown", "Unknown user"],
]);

/**
 * The labels of the given actor ids, in one query per table. Ids without a
 * row are left out; the caller shows them as they are.
 */
export function actorLabels(
  store: Store,
  ids: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const kept = KEPT.get(id);
    if (kept !== undefined) out.set(id, kept);
  }
  const wanted = unique.filter((id) => !KEPT.has(id));
  if (wanted.length === 0) return out;
  const db = store.db;
  const actors = db
    .select({ id: auditActors.id, label: auditActors.label })
    .from(auditActors)
    .where(inArray(auditActors.id, wanted))
    .all();
  for (const row of actors) {
    out.set(row.id, row.label);
  }
  const missing = wanted.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const rows = db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, missing))
      .all();
    for (const row of rows) {
      out.set(row.id, row.email);
    }
  }
  return out;
}

/** The one label of one actor id. */
export function actorLabel(store: Store, id: string): string {
  const kept = KEPT.get(id);
  if (kept !== undefined) return kept;
  const row = store.db
    .select({ label: auditActors.label })
    .from(auditActors)
    .where(eq(auditActors.id, id))
    .get();
  if (row !== undefined) return row.label;
  const user = store.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .get();
  return user?.email ?? id;
}
