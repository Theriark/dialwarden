export function a(parsed: { success: boolean }, field: string) {
  if (!parsed.success) {
    return { ok: false, reason: field === "" ? "payload" : `payload.${field}` };
  }
  return null;
}
