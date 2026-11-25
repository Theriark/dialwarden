// Sessions (dev-work-plan P1-A step 3). The cookie carries a random 256-bit
// session value, signed with SESSION_SECRET (HttpOnly, SameSite=Strict, Secure
// behind https). The database keeps only its SHA-256, so a database copy holds
// no usable session. Each session has its own CSRF token, which every state
// changing request must send back in the X-CSRF-Token header.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, ne, or } from "drizzle-orm";
import { sessions, users } from "../db/schema.js";
import type { Store } from "../db/store.js";

export const SESSION_COOKIE = "dw_session";
/** The cookie name behind https: the __Host- prefix pins it to this host. */
export const SECURE_SESSION_COOKIE = "__Host-dw_session";

/** The session cookie name for a BASE_URL (D17). */
export function sessionCookieName(baseUrl: string | null): string {
  const secure = baseUrl?.startsWith("https://") ?? false;
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  totpEnabled: boolean;
}

export interface ActiveSession {
  id: string;
  csrfToken: string;
  user: SessionUser;
}

export interface NewSession {
  /** The cookie value (before signing). Never stored or logged. */
  value: string;
  csrfToken: string;
  expiresAt: Date;
}

export const sessionId = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export class SessionService {
  readonly #store: Store;
  readonly #now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  create(
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): NewSession {
    const value = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + SESSION_MAX_MS);
    this.#store.db
      .insert(sessions)
      .values({
        id: sessionId(value),
        userId,
        csrfToken,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 200) ?? null,
      })
      .run();
    this.#purgeExpired(now);
    return { value, csrfToken, expiresAt };
  }

  resolve(value: string): ActiveSession | null {
    const id = sessionId(value);
    const row = this.#store.db
      .select({
        id: sessions.id,
        csrfToken: sessions.csrfToken,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        totpSecretEnc: users.totpSecretEnc,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .get();
    if (row === undefined) {
      return null;
    }
    const now = this.#now().getTime();
    const lastSeen = Date.parse(row.lastSeenAt);
    if (now >= Date.parse(row.expiresAt) || now - lastSeen >= SESSION_IDLE_MS) {
      this.#store.db.delete(sessions).where(eq(sessions.id, id)).run();
      return null;
    }
    if (now - lastSeen >= TOUCH_EVERY_MS) {
      const lastSeenAt = new Date(now).toISOString();
      this.#store.db
        .update(sessions)
        .set({ lastSeenAt })
        .where(eq(sessions.id, id))
        .run();
    }
    return {
      id: row.id,
      csrfToken: row.csrfToken,
      user: {
        id: row.userId,
        email: row.email,
        name: row.name,
        role: row.role,
        totpEnabled: row.totpSecretEnc !== null,
      },
    };
  }

  destroy(id: string): void {
    this.#store.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  /** Ends every session of a user, except the one given (password change). */
  destroyForUser(userId: string, keep: string | null = null): void {
    const mine = eq(sessions.userId, userId);
    const where = keep === null ? mine : and(mine, ne(sessions.id, keep));
    this.#store.db.delete(sessions).where(where).run();
  }

  #purgeExpired(now: Date): void {
    const idleSince = new Date(now.getTime() - SESSION_IDLE_MS).toISOString();
    this.#store.db
      .delete(sessions)
      .where(
        or(
          lt(sessions.expiresAt, now.toISOString()),
          lt(sessions.lastSeenAt, idleSince),
        ),
      )
      .run();
  }
}
