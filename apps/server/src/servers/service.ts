// Game servers (dev-work-plan P4-B step 1). A server has a slug id (SERVER_ID
// of plan/editable.ts), a name, its game pack and operating system, and a
// connection spec (contract C4). The spec is stored as JSON without its
// password; the password of panel SFTP is kept encrypted (servers.password).
// A connector is opened for one operation and closed again, so a host key
// confirmed or replaced in between is used at once.
//
// Limits (contract C1): limit(servers) is 3 on Free and the licence
// maxServers on Paid. On Free only the editable three can be changed
// (EntitlementGate.isServerEditable); the others stay readable.
import type { EntitlementGate } from "@dialwarden/entitlement";
import type { Os, Pack } from "@dialwarden/packs-schema";
import { eq } from "drizzle-orm";
import type {
  ConnectionSpec,
  ConnectorService,
} from "../connectors/service.js";
import type { Connector } from "../connectors/types.js";
import type { Aead } from "../crypto/aead.js";
import { servers } from "../db/schema.js";
import type { Store } from "../db/store.js";
import { ApiError, limitReached } from "../http/errors.js";

/** The AEAD context of a stored password (its ENCRYPTED_COLUMNS entry). */
export const PASSWORD_CONTEXT = "servers.password";

/** A connection spec as stored and shown: never with the password. */
export type StoredSpec =
  | { readonly kind: "local"; readonly root: string }
  | {
      readonly kind: "sftp";
      readonly host: string;
      readonly port: number;
      readonly username: string;
      readonly root: string;
      readonly panel: boolean;
    };

export interface ServerRecord {
  readonly id: string;
  readonly name: string;
  readonly packId: string;
  readonly os: Os;
  readonly connector: StoredSpec;
  readonly hasPassword: boolean;
  readonly demo: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEditedAt: string | null;
}

export interface NewServer {
  readonly id: string;
  readonly name: string;
  readonly packId: string;
  readonly os: Os;
  readonly spec: ConnectionSpec;
  readonly demo?: boolean;
}

export interface ServerChange {
  readonly name?: string;
  readonly spec?: ConnectionSpec;
}

export interface ServerServiceOptions {
  readonly store: Store;
  readonly aead: Aead;
  readonly connectors: ConnectorService;
  readonly packs: ReadonlyMap<string, Pack>;
  readonly entitlement: EntitlementGate;
  readonly now?: () => Date;
}

type ServerRow = typeof servers.$inferSelect;

function recordOf(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    packId: row.packId,
    os: row.os === "windows" ? "windows" : "linux",
    connector: JSON.parse(row.connector) as StoredSpec,
    hasPassword: row.passwordEnc !== null,
    demo: row.demo === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastEditedAt: row.lastEditedAt,
  };
}

/** The spec without its password, as the servers table keeps it. */
export function storedSpec(spec: ConnectionSpec): StoredSpec {
  if (spec.kind === "local") return { kind: "local", root: spec.root };
  const { host, port, username, root, panel } = spec;
  return { kind: "sftp", host, port, username, root, panel };
}

/** Most recently edited first; never edited ones after them, oldest first. */
function byRecentEdit(a: ServerRecord, b: ServerRecord): number {
  const left = a.lastEditedAt ?? "";
  const right = b.lastEditedAt ?? "";
  if (left !== right) return left < right ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export class ServerService {
  readonly #store: Store;
  readonly #aead: Aead;
  readonly #connectors: ConnectorService;
  readonly #packs: ReadonlyMap<string, Pack>;
  readonly #entitlement: EntitlementGate;
  readonly #now: () => Date;

  constructor(options: ServerServiceOptions) {
    this.#store = options.store;
    this.#aead = options.aead;
    this.#connectors = options.connectors;
    this.#packs = options.packs;
    this.#entitlement = options.entitlement;
    this.#now = options.now ?? (() => new Date());
  }

  /** Every server, oldest first. */
  list(): ServerRecord[] {
    const rows = this.#store.db
      .select()
      .from(servers)
      .orderBy(servers.createdAt, servers.id)
      .all();
    return rows.map(recordOf);
  }

  get(id: string): ServerRecord | null {
    const row = this.#store.db
      .select()
      .from(servers)
      .where(eq(servers.id, id))
      .get();
    return row === undefined ? null : recordOf(row);
  }

  /** The server, or 404 server_not_found. */
  require(id: string): ServerRecord {
    const found = this.get(id);
    if (found === null) throw new ApiError(404, "server_not_found");
    return found;
  }

  exists(id: string): boolean {
    return this.get(id) !== null;
  }

  count(): number {
    return this.list().length;
  }

  /** Server ids for the Free fallback, most recently edited first. */
  recentlyEdited(): string[] {
    const ordered = this.list().sort(byRecentEdit);
    return ordered.map((server) => server.id);
  }

  /** The server's game pack, or 409 game_pack_missing. */
  pack(server: ServerRecord): Pack {
    const pack = this.#packs.get(server.packId);
    if (pack === undefined) {
      throw new ApiError(409, "game_pack_missing", { packId: server.packId });
    }
    return pack;
  }

  /** Refuses a new server past limit(servers): 402 on Free, 409 on Paid. */
  assertCanAdd(): void {
    const entitlement = this.#entitlement.getEntitlement();
    const max = entitlement.limits.servers;
    const current = this.count();
    if (max === null || current < max) return;
    if (entitlement.plan === "free") {
      throw limitReached("servers", current, max);
    }
    throw new ApiError(409, "server_limit_reached", { max });
  }

  isEditable(id: string): boolean {
    return this.#entitlement.isServerEditable(id);
  }

  /** Refuses a change to a server beyond the editable three on Free (402). */
  assertEditable(id: string): void {
    if (this.isEditable(id)) return;
    const max = this.#entitlement.limit("servers") ?? 0;
    throw limitReached("servers", this.count(), max);
  }

  insert(input: NewServer): ServerRecord {
    if (this.exists(input.id)) {
      throw new ApiError(409, "server_exists", { id: input.id });
    }
    const at = this.#now().toISOString();
    this.#store.db
      .insert(servers)
      .values({
        id: input.id,
        name: input.name,
        packId: input.packId,
        os: input.os,
        connector: JSON.stringify(storedSpec(input.spec)),
        passwordEnc: this.#passwordEnc(input.spec),
        demo: input.demo === true ? 1 : 0,
        createdAt: at,
        updatedAt: at,
        lastEditedAt: null,
      })
      .run();
    return this.require(input.id);
  }

  update(id: string, change: ServerChange): ServerRecord {
    const current = this.require(id);
    const values: Partial<ServerRow> = {
      name: change.name ?? current.name,
      updatedAt: this.#now().toISOString(),
    };
    if (change.spec !== undefined) {
      values.connector = JSON.stringify(storedSpec(change.spec));
      values.passwordEnc = this.#passwordEnc(change.spec);
    }
    this.#store.db.update(servers).set(values).where(eq(servers.id, id)).run();
    return this.require(id);
  }

  /** Deletes the server with its change sets and snapshot records. */
  remove(id: string): void {
    this.require(id);
    this.#store.db.delete(servers).where(eq(servers.id, id)).run();
  }

  /** Records that a change of the app was applied (the Free fallback). */
  touchEdited(id: string, at: string): void {
    this.#store.db
      .update(servers)
      .set({ lastEditedAt: at })
      .where(eq(servers.id, id))
      .run();
  }

  #passwordEnc(spec: ConnectionSpec): string | null {
    if (spec.kind !== "sftp" || spec.password === undefined) return null;
    return this.#aead.encrypt(spec.password, PASSWORD_CONTEXT);
  }

  /** The full spec of a server, with its password decrypted. */
  specOf(server: ServerRecord): ConnectionSpec {
    const stored = server.connector;
    if (stored.kind === "local") return stored;
    const row = this.#store.db
      .select({ passwordEnc: servers.passwordEnc })
      .from(servers)
      .where(eq(servers.id, server.id))
      .get();
    const encrypted = row?.passwordEnc ?? null;
    if (encrypted === null) return stored;
    const password = this.#aead.decryptText(encrypted, PASSWORD_CONTEXT);
    return { ...stored, password };
  }

  /** Opens the server's connector for one task and closes it after. */
  async use<T>(
    server: ServerRecord,
    task: (connector: Connector) => Promise<T>,
  ): Promise<T> {
    const connector = this.#connectors.open(this.specOf(server));
    try {
      return await task(connector);
    } finally {
      await connector.close();
    }
  }
}
