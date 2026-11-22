// Path confinement shared by the Local and SFTP connectors (contract C4).
// A caller's path is checked twice: first as text (this file), then by the
// connector against the real path the file system reports, so a symbolic
// link cannot lead out of the server root either.
import { posix } from "node:path";
import { ConnectorError, LIMITS } from "./types.js";

/**
 * The parts of a relative path, checked as text: no absolute path (a leading
 * / or \, or a drive letter), no backslash, no NUL or other control
 * character and no .. part. Empty and . parts are dropped, so "" and "."
 * name the root itself. Throws PathEscape.
 */
export function relativeParts(rel: string): string[] {
  const refuse = (why: string): never => {
    throw new ConnectorError("PathEscape", `the path ${why}`);
  };
  if (rel.length > LIMITS.maxPathLength) refuse("is too long");
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  if (/[\x00-\x1f\x7f]/.test(rel)) refuse("holds a control character");
  if (rel.startsWith("/")) refuse("is absolute");
  if (rel.includes("\\")) refuse("holds a backslash");
  if (/^[A-Za-z]:/.test(rel)) refuse("is absolute");
  const parts = rel.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) refuse("leaves the server root");
  return parts;
}

/** True when target is root itself or a path below it (POSIX paths). */
export function insideRoot(root: string, target: string): boolean {
  const base = root.endsWith("/") ? root : `${root}/`;
  return target === root || target.startsWith(base);
}

/** The POSIX path of rel under root, after the text check. */
export function joinUnder(root: string, rel: string): string {
  const parts = relativeParts(rel);
  return parts.length === 0 ? root : posix.join(root, ...parts);
}

/** The temp file name a write uses next to its target. */
export function tempName(target: string, token: string): string {
  return posix.join(
    posix.dirname(target),
    `.${posix.basename(target)}.dialwarden-${token}.tmp`,
  );
}

/** The name the plain-rename fallback moves the old file to. */
export function asideName(target: string, token: string): string {
  return posix.join(
    posix.dirname(target),
    `.${posix.basename(target)}.dialwarden-${token}.old`,
  );
}
