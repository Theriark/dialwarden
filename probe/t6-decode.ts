/** Strict base64url: the text must re-encode to itself (no padding, no slack bits). */
function decodeBase64Url(part: string): Buffer | null {
  if (!BASE64URL.test(part)) {
    return null;
  }
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

export { decodeBase64Url };
