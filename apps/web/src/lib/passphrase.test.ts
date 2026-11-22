import { describe, expect, it } from "vitest";
import {
  isPrintableAscii,
  MIN_PASSPHRASE,
  passphraseProblem,
  passphraseReady,
} from "./passphrase";

describe("passphrase rule", () => {
  it("accepts printable ASCII of the minimum length", () => {
    expect(isPrintableAscii("export passphrase 2026 !~")).toBe(true);
    expect(isPrintableAscii("")).toBe(true);
    expect(passphraseProblem("export passphrase 2026")).toBeNull();
    expect(passphraseReady("export passphrase 2026")).toBe(true);
    expect(passphraseReady("a".repeat(MIN_PASSPHRASE))).toBe(true);
    expect(passphraseReady("a".repeat(MIN_PASSPHRASE - 1))).toBe(false);
  });

  it("refuses accents, other scripts, control characters and emoji", () => {
    const refused = [
      "pässwörd-1234-long",
      "密码密码密码密码密码密码",
      "tab\there",
      "😀".repeat(12),
    ];
    for (const value of refused) {
      expect(isPrintableAscii(value), value).toBe(false);
      expect(passphraseProblem(value), value).not.toBeNull();
      expect(passphraseReady(value), value).toBe(false);
    }
  });
});
