// The built web app (contract C8, web-serving-decision on THE-2195). WEB_DIST
// is read once at start into a map keyed by URL path, with brotli and gzip
// forms of compressible files computed before the server listens. One route,
// GET /* (Fastify adds HEAD), answers from that map: there is no file system
// access per request and a path is never joined to a folder, so there is
// nothing to traverse. An unknown client route gets index.html (the SPA shows
// its own not-found screen); a missing asset is a 404, never HTML.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { ApiError } from "./errors.js";

/* eslint-disable security/detect-non-literal-fs-filename -- the files of WEB_DIST, read once at start */

const CONTENT_TYPES = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json"],
  ["map", "application/json"],
  ["webmanifest", "application/manifest+json"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["ico", "image/x-icon"],
  ["woff2", "font/woff2"],
  ["woff", "font/woff"],
  ["ttf", "font/ttf"],
  ["txt", "text/plain; charset=utf-8"],
]);

const COMPRESSIBLE = new Set([
  "html",
  "js",
  "mjs",
  "css",
  "svg",
  "json",
  "webmanifest",
  "txt",
]);

/** A path with one of these extensions is a file, never a client route. */
const STATIC_EXTENSIONS = new Set([
  "js",
  "mjs",
  "css",
  "map",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "json",
  "webmanifest",
  "txt",
]);

/** Compressed forms exist for compressible files of 1 KiB or more. */
const MIN_COMPRESS_BYTES = 1024;
const ASSETS = "/assets/";
const INDEX = "/index.html";
const NO_CACHE = "no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTRIBUTE = /(?:^|\s)src\s*=/i;

type Encoding = "br" | "gzip";

interface Variant {
  body: Buffer;
  etag: string;
}

interface EncodedVariant extends Variant {
  encoding: Encoding;
}

export interface WebFile {
  type: string;
  cacheControl: string;
  /** A compressible type: the answer varies with Accept-Encoding. */
  vary: boolean;
  identity: Variant;
  /** br first, then gzip; empty for small or incompressible files. */
  encoded: readonly EncodedVariant[];
}

export interface WebDist {
  /** URL path (for example /assets/index-4f9a.js) to file. */
  files: ReadonlyMap<string, WebFile>;
  index: WebFile;
  /** 'sha256-...' of each inline script of index.html, for the HTML CSP. */
  scriptHashes: readonly string[];
}

function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

/** The extension of the last path segment, lower case ("" when none). */
function extensionOf(path: string): string {
  const segment = path.slice(path.lastIndexOf("/") + 1);
  const dot = segment.lastIndexOf(".");
  return dot === -1 ? "" : segment.slice(dot + 1).toLowerCase();
}

/** Under /assets/ or with a static extension: a file, never a client route. */
function isFilePath(path: string): boolean {
  return path.startsWith(ASSETS) || STATIC_EXTENSIONS.has(extensionOf(path));
}

function webFile(path: string, bytes: Buffer): WebFile {
  const extension = extensionOf(path);
  // A strong ETag: the first 16 bytes of the sha256, base64url.
  const tag = sha256(bytes).subarray(0, 16).toString("base64url");
  const compressible = COMPRESSIBLE.has(extension);
  const encoded: EncodedVariant[] = [];
  if (compressible && bytes.length >= MIN_COMPRESS_BYTES) {
    const br = brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    });
    encoded.push({ body: br, etag: `"${tag}-br"`, encoding: "br" });
    const gzip = gzipSync(bytes, { level: 9 });
    encoded.push({ body: gzip, etag: `"${tag}-gz"`, encoding: "gzip" });
  }
  return {
    type: CONTENT_TYPES.get(extension) ?? "application/octet-stream",
    cacheControl: path.startsWith(ASSETS) ? IMMUTABLE : NO_CACHE,
    vary: compressible,
    identity: { body: bytes, etag: `"${tag}"` },
    encoded,
  };
}

/** Reads a regular file without following a symbolic link. */
function readRegularFile(path: string): Buffer | null {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : null;
  } finally {
    closeSync(fd);
  }
}

/** Every regular file under dir by URL path; skips dot names and symlinks. */
function walk(dir: string, prefix: string, out: Map<string, Buffer>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry.name);
    const url = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(path, url, out);
    } else if (entry.isFile()) {
      const bytes = readRegularFile(path);
      if (bytes !== null) {
        out.set(url, bytes);
      }
    }
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The CSP source of each inline script element (no src attribute) of the
 * built index.html: the sha256 of the exact text between the tags. The HTML
 * parser turns CR LF into LF before the browser hashes, so this does too.
 */
export function inlineScriptHashes(html: string): string[] {
  const text = html.replace(/\r\n?/g, "\n").replace(HTML_COMMENT, "");
  const hashes = new Set<string>();
  const elements = text.matchAll(SCRIPT_ELEMENT);
  for (const [, attributes = "", body = ""] of elements) {
    if (!SRC_ATTRIBUTE.test(attributes)) {
      hashes.add(`'sha256-${sha256(body).toString("base64")}'`);
    }
  }
  return [...hashes];
}

/**
 * Reads WEB_DIST into memory. Without an index.html there is no web UI: one
 * warning, no web route, and the server answers the API only (tests and
 * API-only runs).
 */
export function loadWebDist(
  dir: string,
  log: FastifyBaseLogger,
): WebDist | null {
  const raw = new Map<string, Buffer>();
  try {
    walk(dir, "", raw);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    raw.clear();
  }
  const html = raw.get(INDEX);
  if (html === undefined) {
    log.warn(`no web UI at ${dir}, serving the API only`);
    return null;
  }
  const index = webFile(INDEX, html);
  const files = new Map<string, WebFile>();
  let bytes = 0;
  for (const [path, content] of raw) {
    files.set(path, path === INDEX ? index : webFile(path, content));
    bytes += content.length;
  }
  log.info({ files: files.size, bytes }, "web UI loaded into memory");
  return {
    files,
    index,
    scriptHashes: inlineScriptHashes(html.toString("utf8")),
  };
}

/** A q=0 parameter: the client refuses that encoding. */
function refuses(param: string): boolean {
  return param.startsWith("q=") && Number(param.slice(2)) === 0;
}

/** The encodings an Accept-Encoding header lists. */
function acceptedEncodings(header: string | undefined): Set<string> {
  const accepted = new Set<string>();
  for (const item of (header ?? "").toLowerCase().split(",")) {
    const [name = "", ...params] = item.split(";").map((part) => part.trim());
    if (name !== "" && !params.some(refuses)) {
      accepted.add(name);
    }
  }
  return accepted;
}

/** If-None-Match lists this ETag (weak comparison, RFC 9110). */
function notModified(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header.split(",").some((item) => {
    const tag = item.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: WebFile,
): FastifyReply {
  const accepted = acceptedEncodings(request.headers["accept-encoding"]);
  const encoded = file.encoded.find((form) => accepted.has(form.encoding));
  const variant = encoded ?? file.identity;
  void reply.header("content-type", file.type);
  void reply.header("cache-control", file.cacheControl);
  void reply.header("etag", variant.etag);
  if (file.vary) {
    void reply.header("vary", "Accept-Encoding");
  }
  if (notModified(request.headers["if-none-match"], variant.etag)) {
    return reply.code(304).send();
  }
  if (encoded !== undefined) {
    void reply.header("content-encoding", encoded.encoding);
  }
  return reply.send(variant.body);
}

/** GET /* (Fastify adds HEAD): the built web app, from memory. */
export function webRoutes(app: FastifyInstance, dist: WebDist): void {
  app.get(
    "/*",
    { config: { auth: "public", web: true }, schema: { hide: true } },
    async (request, reply) => {
      const params = request.params as { "*"?: string };
      const path = `/${params["*"] ?? ""}`;
      // The API keeps its own answers: 503 during a first-run import, else
      // the same 404 JSON as any unknown route.
      if (path === "/api" || path.startsWith("/api/")) {
        if (app.ctx.maintenance) {
          throw new ApiError(503, "maintenance");
        }
        reply.callNotFound();
        return reply;
      }
      const file = dist.files.get(path);
      if (file !== undefined) {
        return sendFile(request, reply, file);
      }
      if (isFilePath(path)) {
        reply.callNotFound();
        return reply;
      }
      return sendFile(request, reply, dist.index);
    },
  );
}
