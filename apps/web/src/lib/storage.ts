// localStorage behind try/catch: private windows and locked-down browsers
// throw on access, and the app must still work without a preference store.

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the preference lives for this page only.
  }
}
