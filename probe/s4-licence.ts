/** The licence pasted in the UI: one row, encrypted with APP_SECRET_KEY. */
export const licence = sqliteTable(
  "licence",
  {
    id: integer("id").primaryKey(),
    updatedBy: text("updated_by"),
  },
  (table) => [check("licence_one_row", sql`${table.id} = 1`)],
);
