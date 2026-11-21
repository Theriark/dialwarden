export const activityEvents = sqliteTable("activity_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  data: text("data")
    .notNull()
    .default(sql`'{}'`),
});
