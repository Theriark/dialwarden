// The client address of the audit log (dev-work-plan P8-A step 4). Fastify
// computes request.ip with trustProxy set to TRUSTED_PROXIES: the right-most
// address of X-Forwarded-For that is not a trusted proxy. Only what node:net
// accepts as an address is stored. The audit IP setting keeps it in full,
// truncated (/24 for IPv4, /48 for IPv6) or not at all.
import { isIP, isIPv4 } from "node:net";

export const IP_MODES = ["full", "truncated", "none"] as const;
export type IpMode = (typeof IP_MODES)[number];

const MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** An address without an IPv6 zone id, or null when it is no address. */
export function cleanAddress(value: string | undefined): string | null {
  if (value === undefined) return null;
  const address = value.split("%")[0] ?? "";
  return isIP(address) === 0 ? null : address;
}

/** The eight 16-bit groups of an IPv6 address (no embedded IPv4 here). */
function groupsOf(address: string): number[] {
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  const zeros = Array.from({ length: missing }, () => "0");
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16));
}

/** RFC 5952 text of eight groups: the longest run of zeros as ::. */
function textOf(groups: readonly number[]): string {
  let start = -1;
  let length = 0;
  let run = 0;
  for (const [index, group] of groups.entries()) {
    run = group === 0 ? run + 1 : 0;
    // The first of the longest runs wins; a single zero group stays.
    if (run > length && run > 1) {
      start = index - run + 1;
      length = run;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (start < 0) return hex.join(":");
  const head = hex.slice(0, start).join(":");
  const tail = hex.slice(start + length).join(":");
  return `${head}::${tail}`;
}

/** The /24 of an IPv4 address or the /48 of an IPv6 address. */
export function truncateAddress(address: string): string {
  const mapped = MAPPED.exec(address)?.[1];
  const v4 = mapped ?? (isIPv4(address) ? address : null);
  if (v4 !== null) {
    const parts = v4.split(".");
    return `${parts.slice(0, 3).join(".")}.0`;
  }
  const groups = groupsOf(address).slice(0, 3);
  return textOf([...groups, 0, 0, 0, 0, 0]);
}

/** The address as the audit IP setting keeps it. */
export function auditAddress(
  value: string | undefined,
  mode: IpMode,
): string | null {
  const address = cleanAddress(value);
  if (address === null || mode === "none") return null;
  return mode === "truncated" ? truncateAddress(address) : address;
}
