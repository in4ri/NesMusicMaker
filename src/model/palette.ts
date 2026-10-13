// The app's colours come from the NES's own palette. Everything else in the UI is a neutral grey.

/** NES palette colours available to the app. */
export const NES = {
  black: '#000000',
  white: '#ffffff',
  grey: '#747474',
  lightGrey: '#bcbcbc',
  darkRed: '#7c0700',
  red: '#d82800',
  burnt: '#c84c0c',
  orange: '#fb9839',
  green: '#80d010',
  darkGreen: '#00a800',
  teal: '#008088',
  sky: '#42befc',
  blue: '#5c94fc',
  royal: '#2038ec',
  navy: '#183c5c',
  pink: '#fc74b4',
  cyan: '#9cfcf0',
  rose: '#ffcccc',
  peach: '#fcd8a8',
  mint: '#a8fabc',
  olive: '#887000',
} as const;

/** UI accent roles. */
export const PALETTE = {
  red: NES.red,
  burnt: NES.burnt,
  orange: NES.orange,
  white: NES.white,
  blue: NES.blue,
  green: NES.green,
  pink: NES.pink,
  cyan: NES.cyan,
} as const;

/** Colours offered for instruments (notes are drawn in them, with dark text). */
export const INSTRUMENT_PALETTE: string[] = [
  NES.orange, NES.blue, NES.green, NES.red, NES.pink, NES.sky, NES.burnt, NES.darkGreen, NES.cyan,
  NES.peach, NES.mint, NES.rose, NES.olive, NES.teal, NES.royal, NES.darkRed, NES.white, NES.lightGrey,
];

/** Colours offered for patterns (clip names are drawn in white on them, so no pale colours). */
export const PATTERN_PALETTE: string[] = [NES.royal, NES.teal, NES.darkGreen, NES.burnt, NES.red, NES.darkRed, NES.olive, NES.blue, NES.pink];

function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour in `choices` closest to `hex` (used to bring older projects' colours into the palette). */
export function nearestPaletteColor(hex: string, choices: string[] = INSTRUMENT_PALETTE): string {
  const lower = hex.toLowerCase();
  if (choices.includes(lower)) return lower;
  const c = rgb(lower);
  if (c.some(Number.isNaN)) return choices[0];
  let best = choices[0], bestD = Infinity;
  for (const p of choices) {
    const q = rgb(p);
    const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
    if (d < bestD) [best, bestD] = [p, d];
  }
  return best;
}
