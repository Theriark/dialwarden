export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** HMAC key of the recovery codes, encrypted (migration 0002). */
  recoveryKeyEnc: text("recovery_key_enc"),
});
