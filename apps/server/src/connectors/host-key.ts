// SSH host key fingerprints in the OpenSSH form (ssh-keygen -l): "SHA256:"
// and the unpadded base64 SHA-256 of the key blob, so the value Dialwarden
// shows can be compared with what the server's administrator sees.
import { createHash } from "node:crypto";

export interface HostKeyId {
  readonly algorithm: string;
  readonly fingerprint: string;
}

export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function fingerprintOf(blob: Uint8Array): string {
  const digest = createHash("sha256").update(blob).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** The algorithm name at the start of an SSH public key blob. */
export function algorithmOf(blob: Uint8Array): string {
  if (blob.length < 4) return "unknown";
  const view = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const length = view.readUInt32BE(0);
  if (length === 0 || length > 64 || 4 + length > view.length) return "unknown";
  const name = view.toString("latin1", 4, 4 + length);
  return /^[a-z0-9@.-]+$/.test(name) ? name : "unknown";
}

export function hostKeyId(blob: Uint8Array): HostKeyId {
  return { algorithm: algorithmOf(blob), fingerprint: fingerprintOf(blob) };
}

/** The fingerprint of an OpenSSH public key line ("ssh-ed25519 AAAA... c"). */
export function publicKeyFingerprint(line: string): string {
  const blob = line.trim().split(/\s+/)[1] ?? "";
  return fingerprintOf(Buffer.from(blob, "base64"));
}
