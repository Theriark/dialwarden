// APP_SECRET_KEY (dev-work-plan P1-A step 3): from the environment, or generated
// once into DATA_DIR/app-secret.key with mode 0600. A generated key shows a
// back-it-up banner until the owner confirms it is saved: a /data backup
// restores only with the same key.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APP_KEY_FILE = "app-secret.key";

export interface AppKey {
  key: Buffer;
  source: "environment" | "file";
  /** True when this start generated the file. */
  generated: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

/* eslint-disable security/detect-non-literal-fs-filename -- the file name is fixed inside the data folder */
export function loadAppKey(dataDir: string, fromEnv: string | null): AppKey {
  if (fromEnv !== null) {
    return {
      key: Buffer.from(fromEnv, "hex"),
      source: "environment",
      generated: false,
    };
  }
  const path = join(dataDir, APP_KEY_FILE);
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8").trim().toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (text !== null) {
    if (!HEX64.test(text)) {
      throw new Error(`${APP_KEY_FILE} must hold 64 hexadecimal characters`);
    }
    if ((statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
    }
    return { key: Buffer.from(text, "hex"), source: "file", generated: false };
  }
  const key = randomBytes(32);
  // wx: never overwrite a key another process wrote in the meantime.
  writeFileSync(path, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  return { key, source: "file", generated: true };
}
/* eslint-enable security/detect-non-literal-fs-filename */
