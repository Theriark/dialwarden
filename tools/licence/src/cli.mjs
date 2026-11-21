#!/usr/bin/env node
// The licence tool (dev-work-plan P1-A step 8). Not in the image.
//   node tools/licence/src/cli.mjs issue --private-key FILE
//       --kind customer|internal-dev --customer-id ID --customer-name NAME
//       --updates-until YYYY-MM-DD [--max-servers N] [--issued-at ISO]
//       [--lid ULID] [--out FILE]
//   node tools/licence/src/cli.mjs verify --public-key FILE [--token-file FILE]
//   node tools/licence/src/cli.mjs test-keygen --out DIR
//   node tools/licence/src/cli.mjs revocation-hash --lid ULID
// issue is for the operator, with the key file the operator holds; the crew
// never runs it with a real key. test-keygen makes throwaway keys for CI and
// local tests and refuses the key slot folder of packages/entitlement. verify
// reads the token from a file or standard input, never from the command line.
/* eslint-disable security/detect-non-literal-fs-filename -- paths the operator passes on the command line */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildPayload,
  inspectLicence,
  lidHash8,
  LicenceToolError,
  newKeyPair,
  readPrivateKey,
  readPublicKey,
  revocationHash,
  signLicence,
  ULID,
} from "./lib.mjs";

const USAGE = `usage:
  licence issue --private-key FILE --kind customer|internal-dev --customer-id ID
                --customer-name NAME --updates-until YYYY-MM-DD
                [--max-servers N] [--issued-at ISO] [--lid ULID] [--out FILE]
  licence verify --public-key FILE [--token-file FILE]
  licence test-keygen --out DIR
  licence revocation-hash --lid ULID`;

const SLOT_FILES = [
  "production.pub",
  "development-current.pub",
  "development-next.pub",
];

const options = (args, names) =>
  parseArgs({
    args,
    options: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
    strict: true,
    allowPositionals: false,
  }).values;

function required(values, name) {
  const value = values[name]; // eslint-disable-line security/detect-object-injection -- a fixed option name
  if (value === undefined) {
    throw new LicenceToolError(`--${name} is required`);
  }
  return value;
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The compiled-in key slot folder: a test key never goes there. */
async function isSlotFolder(dir) {
  const parts = dir.split(/[\\/]+/);
  if (parts.at(-1) === "keys" && parts.at(-2) === "entitlement") {
    return true;
  }
  for (const name of SLOT_FILES) {
    if (await exists(join(dir, name))) {
      return true;
    }
  }
  return false;
}

async function issue(args, io) {
  const values = options(args, [
    "private-key",
    "kind",
    "customer-id",
    "customer-name",
    "updates-until",
    "max-servers",
    "issued-at",
    "lid",
    "out",
  ]);
  const keyFile = required(values, "private-key");
  const payload = buildPayload({
    kind: values.kind,
    customerId: values["customer-id"],
    customerName: values["customer-name"],
    updatesUntil: values["updates-until"],
    maxServers: values["max-servers"],
    issuedAt: values["issued-at"],
    lid: values.lid,
  });
  const token = signLicence(payload, readPrivateKey(await readFile(keyFile)));
  if (values.out === undefined) {
    io.stdout.write(`${token}\n`);
  } else {
    await writeFile(values.out, `${token}\n`, { mode: 0o600, flag: "wx" });
  }
  const hash = lidHash8(payload.lid);
  io.stderr.write(
    `issued a ${payload.kind} licence, lidHash8 ${hash}, updatesUntil ${payload.updatesUntil}\n`,
  );
  return 0;
}

async function verifyToken(args, io) {
  const values = options(args, ["public-key", "token-file"]);
  const key = readPublicKey(
    await readFile(required(values, "public-key"), "utf8"),
  );
  const tokenFile = values["token-file"];
  const token =
    tokenFile === undefined
      ? await readStdin(io.stdin)
      : await readFile(tokenFile, "utf8");
  const summary = inspectLicence(token, key);
  io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.signature === "valid" ? 0 : 1;
}

async function testKeygen(args, io) {
  const dir = resolve(required(options(args, ["out"]), "out"));
  if (await isSlotFolder(dir)) {
    throw new LicenceToolError(
      "test keys never go into the key slot folder packages/entitlement/keys",
    );
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pair = newKeyPair();
  const privateFile = join(dir, "test-private.pem");
  const publicFile = join(dir, "test-public.pem");
  const comment = [
    "# Throwaway TEST key from tools/licence test-keygen. Never a slot key.",
    `# fingerprint sha256 ${pair.fingerprint}`,
    "",
  ].join("\n");
  await writeFile(privateFile, pair.privatePem, { mode: 0o600, flag: "wx" });
  await writeFile(publicFile, comment + pair.publicPem, { flag: "wx" });
  const result = { privateFile, publicFile, fingerprint: pair.fingerprint };
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function revocation(args, io) {
  const lid = required(options(args, ["lid"]), "lid");
  if (!ULID.test(lid)) {
    throw new LicenceToolError("--lid must be a licence id (ULID)");
  }
  io.stdout.write(`${revocationHash(lid)}\n`);
  return 0;
}

const defaultIo = () => ({
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
});

/** Runs one command; 0 ok, 1 an invalid signature, 2 a usage or input error. */
export async function main(args, io = defaultIo()) {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "issue":
        return await issue(rest, io);
      case "verify":
        return await verifyToken(rest, io);
      case "test-keygen":
        return await testKeygen(rest, io);
      case "revocation-hash":
        return revocation(rest, io);
      default:
        io.stderr.write(`${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    io.stderr.write(`licence: ${error.message}\n`);
    return 2;
  }
}

const invoked = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
