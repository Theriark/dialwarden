// pnpm --filter @dialwarden/server openapi (after a build): prints the OpenAPI
// 3.1 document without a running server, for the typed web client (P1-B). It
// builds the app on a throwaway data folder and closes it again.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { buildApp } from "./app.js";

/* eslint-disable security/detect-non-literal-fs-filename -- a throwaway folder under the system temporary folder */

const dir = await mkdtemp(join(tmpdir(), "dialwarden-openapi-"));
try {
  // The first-run setup line goes nowhere: standard output carries the JSON.
  const out = new Writable({ write: (_chunk, _encoding, done) => done() });
  const env = { LOG_LEVEL: "silent", DATA_DIR: dir };
  const app = await buildApp({ env, out });
  try {
    process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
  } finally {
    await app.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
