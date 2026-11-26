// Route configs of the server-scoped routes (P8-A). The guard finds the game
// server of the request and checks the principal's grant there before the
// handler runs (see guard.ts).
import type { ServerAccess, ServerSource } from "./context.js";

const scoped = (from: ServerSource, access: ServerAccess) => ({
  auth: "user" as const,
  server: { from, access },
});

/** A route on the server of the slug path parameter. */
export const onSlug = (access: ServerAccess) => scoped("slug", access);

/** A route on the server of the change set of the id path parameter. */
export const onChangeSet = (access: ServerAccess) =>
  scoped("changeSet", access);

/** A route on the server of the snapshot of the id path parameter. */
export const onSnapshot = (access: ServerAccess) => scoped("snapshot", access);

/** A route on the server of the schedule of the id path parameter. */
export const onSchedule = (access: ServerAccess) => scoped("schedule", access);

/** A route on the server named by the server field of the body. */
export const onBodyServer = (access: ServerAccess) =>
  scoped("bodyServer", access);
