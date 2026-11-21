// The backup passphrase rule of the server (apps/server/src/backup/archive.ts):
// at least 12 printable ASCII characters, for the export and the first-run
// import alike. The import sends it in a request header, which holds only
// Latin-1, so the browser would refuse any other character with its own error.

export const MIN_PASSPHRASE = 12;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export const PASSPHRASE_HELP = `At least ${MIN_PASSPHRASE} characters: letters, digits, spaces and the punctuation of a US keyboard.`;

const CHARACTER_PROBLEM =
  "Only letters, digits, spaces and the punctuation of a US keyboard are allowed.";

export function isPrintableAscii(value: string): boolean {
  return PRINTABLE_ASCII.test(value);
}

/** The sentence under the field, or null when every character is allowed. */
export function passphraseProblem(value: string): string | null {
  return isPrintableAscii(value) ? null : CHARACTER_PROBLEM;
}

/** True when the server will accept the passphrase as typed. */
export function passphraseReady(value: string): boolean {
  return value.length >= MIN_PASSPHRASE && isPrintableAscii(value);
}
