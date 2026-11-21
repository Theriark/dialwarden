// App backup export and import (it-input-1 3.1): a tar.gz of one backup folder,
// encrypted with a passphrase the owner enters (scrypt, AES-256-GCM).
//
// File layout: header (36 bytes) | ciphertext | GCM tag (16 bytes).
// Header: "DWBX" | version 1 | log2 N | r | p | salt (16) | IV (12); the whole
// header is the associated data. The tar holds only the names in
// ARCHIVE_NAME, so an archive can never write outside its staging folder.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  type ScryptOptions,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/* eslint-disable security/detect-non-literal-fs-filename -- paths are a backup folder, a staging folder under the data folder, and names checked against ARCHIVE_NAME */

export const ARCHIVE_MAGIC = "DWBX";
export const ARCHIVE_VERSION = 1;
const HEADER_LENGTH = 36;
const TAG_LENGTH = 16;
const SCRYPT = { logN: 15, r: 8, p: 1 };
export const MIN_PASSPHRASE_LENGTH = 12;
/** Largest archive accepted, and largest tar it may expand to. */
export const MAX_ARCHIVE_BYTES = 8 * 1024 ** 3;

/** Names an archive may contain (forward slashes, no other paths). */
export const ARCHIVE_NAME =
  /^(manifest\.json|dialwarden\.db|app-secret\.key|snapshots\/[0-9a-f]{2}\/[0-9a-f]{64}\.gz)$/;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { logN: number; r: number; p: number },
): Promise<Buffer> {
  const options: ScryptOptions = {
    N: 2 ** params.logN,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, options, (error, key) => {
      if (error === null) {
        resolve(key);
      } else {
        reject(error);
      }
    });
  });
}

// ---- tar (ustar), regular files only ----

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

export function tarHeader(name: string, size: number, mtime: Date): Buffer {
  if (Buffer.byteLength(name) > 100) {
    throw new ArchiveError(`tar name too long: ${name}`);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function padding(size: number): Buffer {
  const rest = size % 512;
  return Buffer.alloc(rest === 0 ? 0 : 512 - rest);
}

/** Relative file names under dir, with forward slashes. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      names.push(...(await listFiles(dir, name)));
    } else if (entry.isFile()) {
      names.push(name);
    }
  }
  return names.sort();
}

async function* tarStream(
  dir: string,
  extra: { name: string; data: Buffer }[],
): AsyncGenerator<Buffer> {
  for (const name of await listFiles(dir)) {
    if (!ARCHIVE_NAME.test(name)) {
      continue;
    }
    const path = join(dir, name);
    const info = await stat(path);
    yield tarHeader(name, info.size, info.mtime);
    for await (const chunk of createReadStream(path)) {
      yield chunk as Buffer;
    }
    yield padding(info.size);
  }
  for (const file of extra) {
    yield tarHeader(file.name, file.data.length, new Date());
    yield file.data;
    yield padding(file.data.length);
  }
  yield Buffer.alloc(1024);
}

/** The encrypted export of a backup folder, as a stream of chunks. */
export async function* exportArchive(
  dir: string,
  appKey: Buffer,
  passphrase: string,
): AsyncGenerator<Buffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([
    Buffer.from(ARCHIVE_MAGIC, "ascii"),
    Buffer.from([ARCHIVE_VERSION, SCRYPT.logN, SCRYPT.r, SCRYPT.p]),
    salt,
    iv,
  ]);
  const key = await deriveKey(passphrase, salt, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  yield header;
  const keyFile = Buffer.from(`${appKey.toString("hex")}\n`, "ascii");
  const tar = Readable.from(
    tarStream(dir, [{ name: "app-secret.key", data: keyFile }]),
  );
  const gzip = tar.pipe(createGzip());
  for await (const chunk of gzip) {
    const out = cipher.update(chunk as Buffer);
    if (out.length > 0) {
      yield out;
    }
  }
  const last = cipher.final();
  if (last.length > 0) {
    yield last;
  }
  yield cipher.getAuthTag();
}

/** Passes bytes through and fails once more than max went by. */
export function byteLimit(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > max) {
        callback(new ArchiveError("the archive expands beyond the size limit"));
      } else {
        callback(null, chunk);
      }
    },
  });
}

/** Decrypts and unpacks an archive file into a new folder. */
export async function importArchive(
  file: string,
  passphrase: string,
  target: string,
): Promise<{ appKeyHex: string | null }> {
  const info = await stat(file);
  if (info.size < HEADER_LENGTH + TAG_LENGTH || info.size > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError("not a Dialwarden backup export");
  }
  const handle = await open(file, "r");
  const header = Buffer.alloc(HEADER_LENGTH);
  const tag = Buffer.alloc(TAG_LENGTH);
  try {
    await handle.read(header, 0, HEADER_LENGTH, 0);
    await handle.read(tag, 0, TAG_LENGTH, info.size - TAG_LENGTH);
  } finally {
    await handle.close();
  }
  const magic = header.subarray(0, 4).toString("ascii");
  const [version = 0, logN = 0, r = 0, p = 0] = header.subarray(4, 8);
  if (magic !== ARCHIVE_MAGIC || version !== ARCHIVE_VERSION) {
    throw new ArchiveError("not a Dialwarden backup export");
  }
  // Bounded parameters: a crafted header cannot make scrypt use huge memory.
  if (logN < 14 || logN > 20 || r < 1 || r > 16 || p < 1 || p > 4) {
    throw new ArchiveError("unsupported key derivation parameters");
  }
  const salt = header.subarray(8, 24);
  const iv = header.subarray(24, 36);
  const key = await deriveKey(passphrase, salt, { logN, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const tarPath = join(target, "archive.tar");
  try {
    await pipeline(
      createReadStream(file, {
        start: HEADER_LENGTH,
        end: info.size - TAG_LENGTH - 1,
      }),
      decipher,
      createGunzip(),
      byteLimit(MAX_ARCHIVE_BYTES),
      createWriteStream(tarPath, { mode: 0o600 }),
    );
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw error;
    }
    throw new ArchiveError("wrong passphrase or damaged file");
  }
  const folder = join(target, "backup");
  const appKeyHex = await untar(tarPath, folder);
  return { appKeyHex };
}

/** A NUL-terminated header field as text. */
function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function parseOctal(field: Buffer): number {
  const text = cString(field).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new ArchiveError("damaged tar header");
  }
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** Unpacks the tar; returns the app key it carried (hex) or null. */
async function untar(tarPath: string, folder: string): Promise<string | null> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const { size } = await stat(tarPath);
  const handle = await open(tarPath, "r");
  let appKeyHex: string | null = null;
  try {
    let offset = 0;
    const header = Buffer.alloc(512);
    while (offset + 512 <= size) {
      await handle.read(header, 0, 512, offset);
      if (header.every((byte) => byte === 0)) {
        break;
      }
      const name = cString(header.subarray(0, 100));
      const type = header.subarray(156, 157).toString("ascii");
      const length = parseOctal(header.subarray(124, 136));
      const start = offset + 512;
      if ((type !== "0" && type !== "\0") || !ARCHIVE_NAME.test(name)) {
        throw new ArchiveError(`unexpected entry in the archive: ${name}`);
      }
      if (start + length > size) {
        throw new ArchiveError("truncated archive");
      }
      if (name === "app-secret.key") {
        const data = Buffer.alloc(length);
        await handle.read(data, 0, length, start);
        appKeyHex = data.toString("ascii").trim().toLowerCase();
      } else {
        const path = join(folder, ...name.split("/"));
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        if (length === 0) {
          await writeFile(path, Buffer.alloc(0), { mode: 0o600 });
        } else {
          await pipeline(
            createReadStream(tarPath, { start, end: start + length - 1 }),
            createWriteStream(path, { mode: 0o600 }),
          );
        }
      }
      offset = start + length + padding(length).length;
    }
  } finally {
    await handle.close();
  }
  return appKeyHex;
}
