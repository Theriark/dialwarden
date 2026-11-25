// The demo drift job (P10 correction, Risks 20 of dev-work-plan-2). DEMO ONLY:
// it runs only when DEMO_SEED is true, and does nothing on any other
// instance. Once a day it changes one comment line of the demo Rust server's
// server.cfg (DEMO_SERVERS_DIR/rust/server/rustserver/cfg/server.cfg),
// straight to the file the way a text editor would, and then reads the
// server's files so the change is recorded as an outside edit: a history
// entry of cause external by "outside the app (demo simulation)" and the
// activity event drift.detected with the note demo simulation. Development
// and Stage so always show a fresh outside edit, labelled as simulated.
//
// The owner can run it once at once (POST /api/v1/system/demo-drift/run),
// so a live check does not wait a day. Only a comment line changes, so no
// setting of the demo server changes and nothing else is touched.
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";
import type { ChangeSetService } from "../changes/service.js";
import { ApiError } from "../http/errors.js";
import type { ServerService } from "./service.js";

/** The demo server the job edits. */
export const DEMO_DRIFT_SERVER = "demo-rust";

/** The pack file of that server whose comment line changes. */
export const DEMO_DRIFT_FILE = "servercfg";

/** The note on the outside edit and its drift.detected event. */
export const DEMO_DRIFT_NOTE = "demo simulation";

/** The start of the comment line the job owns. */
export const DEMO_DRIFT_MARKER = "# Dialwarden demo simulation:";

/** Once a day, at 04:10 Lisbon time (after the backup and retention jobs). */
export const DEMO_DRIFT_SCHEDULE = "10 4 * * *";
export const DEMO_DRIFT_TIMEZONE = "Europe/Lisbon";

export interface DemoDriftResult {
  readonly serverId: string;
  /** The history entry of the outside edit (cause external). */
  readonly changeSetId: string | null;
  readonly line: string;
}

/**
 * The text with the job's comment line set to line: the marker line is
 * replaced when it is there, else the line goes after the leading comment
 * block. Every other line stays as it was.
 */
export function withDemoLine(text: string, line: string): string {
  const lines = text.split("\n");
  const found = lines.findIndex((item) => item.startsWith(DEMO_DRIFT_MARKER));
  if (found >= 0) {
    lines.splice(found, 1, line);
    return lines.join("\n");
  }
  let index = 0;
  while (index < lines.length && (lines.at(index) ?? "").startsWith("#")) {
    index += 1;
  }
  lines.splice(index, 0, line);
  return lines.join("\n");
}

export interface DemoDriftOptions {
  readonly demoSeed: boolean;
  readonly servers: ServerService;
  readonly changes: ChangeSetService;
  readonly log: FastifyBaseLogger;
  readonly now?: () => Date;
}

export class DemoDriftJob {
  readonly #options: DemoDriftOptions;
  readonly #now: () => Date;
  #job: Cron | null = null;

  constructor(options: DemoDriftOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.#options.demoSeed;
  }

  /**
   * Changes the comment line once and records the outside edit. Without
   * DEMO_SEED it answers 404 demo_seed_off and touches nothing.
   */
  async run(): Promise<DemoDriftResult> {
    if (!this.enabled) throw new ApiError(404, "demo_seed_off");
    const { servers, changes } = this.#options;
    const server = servers.get(DEMO_DRIFT_SERVER);
    if (server === null || !server.demo) {
      throw new ApiError(404, "server_not_found");
    }
    const states = await changes.read(server);
    const state = states.get(DEMO_DRIFT_FILE);
    const current = state?.bytes ?? null;
    if (state === undefined || current === null) {
      throw new ApiError(409, "file_not_on_server", {
        fileId: DEMO_DRIFT_FILE,
      });
    }
    const line = `${DEMO_DRIFT_MARKER} ${this.#now().toISOString()}`;
    const text = new TextDecoder().decode(current);
    const bytes = new TextEncoder().encode(withDemoLine(text, line));
    await servers.use(server, (connector) =>
      connector.writeAtomic(state.path, bytes, {
        expectedSha256: state.sha256,
      }),
    );
    const origin = { via: "demo" as const, note: DEMO_DRIFT_NOTE };
    const changeSetId = await changes.checkDrift(server, origin);
    return { serverId: server.id, changeSetId, line };
  }

  /** Starts the daily job; nothing without DEMO_SEED. */
  start(): void {
    if (!this.enabled) return;
    const run = async () => {
      try {
        const result = await this.run();
        this.#options.log.info(
          { server: result.serverId, changeSetId: result.changeSetId },
          "demo drift simulated",
        );
      } catch (error) {
        this.#options.log.warn({ err: error }, "demo drift job failed");
      }
    };
    this.#job = new Cron(
      DEMO_DRIFT_SCHEDULE,
      { timezone: DEMO_DRIFT_TIMEZONE, protect: true },
      run,
    );
  }

  stop(): void {
    this.#job?.stop();
    this.#job = null;
  }
}
