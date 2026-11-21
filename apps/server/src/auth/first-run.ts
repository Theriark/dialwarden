// The one-time setup token (R&D decision THE-2141, security review THE-2134
// M3). While no user exists, POST /api/v1/setup and POST /api/v1/setup/import
// need the header X-Dialwarden-Setup-Token with the token from
// DATA_DIR/setup-token (mode 0600). The server prints it to standard output at
// every start until an owner exists, and deletes the file once one does. The
// token is 32 random bytes as 64 lowercase hex characters.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* eslint-disable security/detect-non-literal-fs-filename -- a fixed name in the data folder */

export const SETUP_TOKEN_FILE = "setup-token";
export const SETUP_TOKEN_HEADER = "x-dialwarden-setup-token";
const TOKEN = /^[0-9a-f]{64}$/;

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

/** True when a presented value has the form of a setup token. */
export function isSetupTokenShape(value: string): boolean {
  return TOKEN.test(value);
}

export class SetupToken {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, SETUP_TOKEN_FILE);
  }

  #read(): string | null {
    try {
      const text = readFileSync(this.path, "utf8").trim();
      return TOKEN.test(text) ? text : null;
    } catch {
      return null;
    }
  }

  /**
   * The token in the file, or a new one. A new token is written to a
   * temporary file in the data folder and renamed into place, so a crash never
   * leaves half a token; a malformed file is replaced.
   */
  ensure(): string {
    const existing = this.#read();
    if (existing !== null) {
      return existing;
    }
    const token = randomBytes(32).toString("hex");
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    return token;
  }

  /** True when the presented value is the token in the file (timing-safe). */
  matches(presented: string): boolean {
    const stored = this.#read();
    if (stored === null) {
      return false;
    }
    return timingSafeEqual(digest(presented), digest(stored));
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}
