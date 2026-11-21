export const sessions = sqliteTable(
  "sessions",
  {
    /** sha256 of the session secret in the cookie, hex. */
    id: text("id").primaryKey(),
    ip: text("ip"),
  },
  (table) => [index("sessions_user").on(table.userId)],
);
