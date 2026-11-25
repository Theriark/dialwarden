// The comparison matrix (dev-work-plan P9-A step 5, Paid feature
// fleet.matrix): the settings of one game by the servers of that game, a row
// per setting and a column per server, with the rows whose values differ
// flagged. Only the servers the caller may read are columns. The values come
// from the same settings read the editor uses, so secrets stay masked; a
// secret row never says whether two servers share a value. A server whose
// files cannot be read is a column with its error, and the others still
// compare.
import type { JsonValue, Pack } from "@dialwarden/packs-schema";
import type { ChangeSetService } from "../changes/service.js";
import { ConnectorError } from "../connectors/types.js";
import { ApiError } from "../http/errors.js";
import type { ServerRecord, ServerService } from "../servers/service.js";

/** How many servers are read at once. */
const READ_CONCURRENCY = 4;

export interface MatrixServer {
  readonly id: string;
  readonly name: string;
  readonly editable: boolean;
  /** The code of a failed read (connector or app), else null. */
  readonly error: string | null;
}

export interface MatrixRow {
  readonly key: string;
  readonly label: string;
  readonly group: string | null;
  readonly secret: boolean;
  /** The value per server id; a server that could not be read is absent. */
  readonly values: Record<string, JsonValue>;
  /** True when the servers that were read hold different values. */
  readonly differs: boolean;
}

export interface Matrix {
  readonly packId: string;
  readonly displayName: string;
  /** Every settings group of the game, in pack order. */
  readonly groups: string[];
  /** The group the rows were filtered by, or null for all. */
  readonly group: string | null;
  readonly servers: MatrixServer[];
  readonly rows: MatrixRow[];
  /** How many rows differ. */
  readonly differing: number;
}

export interface MatrixQuery {
  readonly packId: string;
  readonly group?: string | undefined;
  /** Only these server ids, if given (still only readable ones). */
  readonly servers?: readonly string[] | undefined;
}

type Read = { values: Record<string, JsonValue> } | { error: string };

function groupsOf(pack: Pack): string[] {
  const groups: string[] = [];
  for (const setting of pack.settings) {
    if (setting.group !== undefined && !groups.includes(setting.group)) {
      groups.push(setting.group);
    }
  }
  return groups;
}

/** Runs the tasks with at most limit of them at once, keeping the order. */
async function inBatches<T>(
  items: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const batch = items.slice(start, start + limit);
    out.push(...(await Promise.all(batch.map((task) => task()))));
  }
  return out;
}

export class MatrixService {
  readonly #packs: ReadonlyMap<string, Pack>;
  readonly #servers: ServerService;
  readonly #changes: ChangeSetService;

  constructor(options: {
    packs: ReadonlyMap<string, Pack>;
    servers: ServerService;
    changes: ChangeSetService;
  }) {
    this.#packs = options.packs;
    this.#servers = options.servers;
    this.#changes = options.changes;
  }

  async #read(server: ServerRecord): Promise<Read> {
    try {
      const settings = await this.#changes.settings(server);
      return { values: settings.values };
    } catch (error) {
      if (error instanceof ConnectorError || error instanceof ApiError) {
        return { error: error.code };
      }
      throw error;
    }
  }

  /** GET /api/v1/fleet/matrix for one game. */
  async build(
    query: MatrixQuery,
    visible: (serverId: string) => boolean,
  ): Promise<Matrix> {
    const pack = this.#packs.get(query.packId);
    if (pack === undefined) {
      throw new ApiError(422, "unknown_game", { id: query.packId });
    }
    const groups = groupsOf(pack);
    const group = query.group ?? null;
    if (group !== null && !groups.includes(group)) {
      throw new ApiError(422, "unknown_group", { group });
    }
    const wanted = query.servers === undefined ? null : new Set(query.servers);
    const servers = this.#servers
      .list()
      .filter((server) => server.packId === pack.id && visible(server.id))
      .filter((server) => wanted === null || wanted.has(server.id));
    const reads = await inBatches(
      servers.map((server) => () => this.#read(server)),
      READ_CONCURRENCY,
    );
    const columns: MatrixServer[] = [];
    const values = new Map<string, Map<string, JsonValue>>();
    servers.forEach((server, index) => {
      const read = reads.at(index) ?? { error: "internal" };
      columns.push({
        id: server.id,
        name: server.name,
        editable: this.#servers.isEditable(server.id),
        error: "error" in read ? read.error : null,
      });
      if ("values" in read) {
        values.set(server.id, new Map(Object.entries(read.values)));
      }
    });
    const settings = pack.settings.filter(
      (setting) => group === null || setting.group === group,
    );
    const rows = settings.map((setting): MatrixRow => {
      const byServer = new Map<string, JsonValue>();
      for (const [serverId, read] of values) {
        byServer.set(serverId, read.get(setting.key) ?? null);
      }
      const secret = setting.secret === true;
      const distinct = new Set(
        [...byServer.values()].map((value) => JSON.stringify(value)),
      );
      return {
        key: setting.key,
        label: setting.label ?? setting.key,
        group: setting.group ?? null,
        secret,
        values: Object.fromEntries(byServer),
        differs: !secret && distinct.size > 1,
      };
    });
    return {
      packId: pack.id,
      displayName: pack.displayName,
      groups,
      group,
      servers: columns,
      rows,
      differing: rows.filter((row) => row.differs).length,
    };
  }
}
