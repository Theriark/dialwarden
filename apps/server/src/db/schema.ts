// Drizzle schema of the P1 tables. The SQL that creates them is in
// migrations.ts; schema.test.ts fails when the two disagree. Later phases add
// their tables here and a new migration (never an edit of an applied one).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnc: text("totp_secret_enc"),
  totpPendingEnc: text("totp_pending_enc"),
  totpLastStep: integer("totp_last_step"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** HMAC key of the recovery codes, encrypted (migration 0002). */
  recoveryKeyEnc: text("recovery_key_enc"),
});

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [
    uniqueIndex("recovery_codes_user_code").on(table.userId, table.codeHash),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** sha256 of the session secret in the cookie, hex. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [index("sessions_user").on(table.userId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON text. */
  value: text("value").notNull(),
});

/** The licence pasted in the UI: one row, encrypted with APP_SECRET_KEY. */
export const licence = sqliteTable(
  "licence",
  {
    id: integer("id").primaryKey(),
    tokenEnc: text("token_enc").notNull(),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [check("licence_one_row", sql`${table.id} = 1`)],
);

/** Contract C6. */
export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    serverId: text("server_id"),
    at: text("at").notNull(),
    actor: text("actor").notNull(),
    data: text("data")
      .notNull()
      .default(sql`'{}'`),
  },
  (table) => [
    index("activity_events_type").on(table.type, table.id),
    index("activity_events_server").on(table.serverId, table.id),
  ],
);

export const schema = {
  users,
  recoveryCodes,
  sessions,
  settings,
  licence,
  activityEvents,
};
