// The contrast pairs of the semantic status layer (brand-assets-1 part 2):
// every colour pair the P6 status surfaces paint — the status chip, the
// pending badge, the activity rows, the save dialog states — must meet
// WCAG AA, 4.5:1, in both themes (references/ui-standard.md). The values
// mirror apps/web/src/styles/tokens.css: when a token changes there, the
// pair changes here with it.
import { describe, expect, it } from "vitest";

/** The light palette of tokens.css (:root). */
const LIGHT = {
  fg: "#141b2d",
  bg: "#eef2f7",
  surface: "#ffffff",
  muted: "#5b6880",
  primary: "#1f7a4d",
  primaryFg: "#eef2f7",
  error: "#b42318",
  errorSoft: "#f8e9e8",
  warning: "#b54708",
  warningSoft: "#f8ede6",
  pending: "#7a4b00",
  pendingSoft: "#f2ede6",
  success: "#1f7a4d",
  successSoft: "#e9f2ed",
  info: "#175cd3",
  infoSoft: "#e8effb",
  neutral: "#5b6880",
} as const;

/** The dark palette of tokens.css (html[data-theme="dark"]). */
const DARK = {
  fg: "#eef2f7",
  bg: "#141b2d",
  surface: "#1e2740",
  muted: "#8a97ad",
  primary: "#3fb97a",
  primaryFg: "#141b2d",
  error: "#f97066",
  errorSoft: "#342e44",
  warning: "#fdb022",
  warningSoft: "#34353d",
  pending: "#f5c451",
  pendingSoft: "#343742",
  success: "#3fb97a",
  successSoft: "#213646",
  info: "#84caff",
  infoSoft: "#283753",
  neutral: "#8a97ad",
} as const;

/** One palette: the same keys as the light one, plain string values. */
type Palette = { readonly [key in keyof typeof LIGHT]: string };

/** One named colour pair with its WCAG minimum. */
const pairsOf = (
  p: Palette,
): readonly (readonly [name: string, fore: string, back: string])[] => [
  ["text on the page", p.fg, p.bg],
  ["text on a card", p.fg, p.surface],
  ["muted text on the page", p.muted, p.bg],
  ["muted text on a card", p.muted, p.surface],
  ["a primary button on its label", p.primary, p.primaryFg],
  ["error text on its soft card", p.error, p.errorSoft],
  ["warning text on its soft card", p.warning, p.warningSoft],
  ["pending text on its soft card", p.pending, p.pendingSoft],
  ["success text on its soft card", p.success, p.successSoft],
  ["info text on its soft card", p.info, p.infoSoft],
  ["neutral text on a card", p.neutral, p.surface],
];

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const red = channel(Number.parseInt(value.slice(0, 2), 16));
  const green = channel(Number.parseInt(value.slice(2, 4), 16));
  const blue = channel(Number.parseInt(value.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The WCAG contrast ratio of two colours, 1 to 21. */
export function ratioOf(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  const high = Math.max(first, second);
  const low = Math.min(first, second);
  return (high + 0.05) / (low + 0.05);
}

describe("the status colours of brand-assets-1 part 2", () => {
  for (const [theme, palette] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    it(`keeps every pair of the ${theme} theme at AA or better`, () => {
      for (const [name, fore, back] of pairsOf(palette)) {
        const value = Math.round(ratioOf(fore, back) * 100) / 100;
        expect(value, `${name}: ${fore} on ${back}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  }

  it("keeps the dark neutral pair visible enough on a card", () => {
    // The steel neutral on the dark card is the tightest pair of the layer;
    // it must still pass with room for the badge border to fade it.
    expect(ratioOf(DARK.neutral, DARK.surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratioOf(DARK.muted, DARK.bg)).toBeGreaterThanOrEqual(4.5);
  });
});
