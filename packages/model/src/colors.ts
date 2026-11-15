/**
 * The colour palette for notebooks and sections. Docs store the colour name;
 * the hex value is how clients and exports draw it.
 */
export const COLORS = [
  { name: 'blue', hex: '#3b7dd8' },
  { name: 'sky', hex: '#4fa8de' },
  { name: 'teal', hex: '#2a9d8f' },
  { name: 'mint', hex: '#5cbf9b' },
  { name: 'green', hex: '#4f9d4a' },
  { name: 'olive', hex: '#8a9a3b' },
  { name: 'yellow', hex: '#e9c46a' },
  { name: 'amber', hex: '#f0a202' },
  { name: 'orange', hex: '#e76f51' },
  { name: 'red', hex: '#d1495b' },
  { name: 'rose', hex: '#e07a9a' },
  { name: 'plum', hex: '#9c4f96' },
  { name: 'violet', hex: '#7b61c4' },
  { name: 'indigo', hex: '#4b5bb5' },
  { name: 'brown', hex: '#9a6b4f' },
  { name: 'slate', hex: '#6b7a8f' },
] as const;

export type ColorName = (typeof COLORS)[number]['name'];

export function isColorName(value: unknown): value is ColorName {
  return COLORS.some((c) => c.name === value);
}

/** The hex value for a colour name. */
export function colorHex(name: ColorName): string {
  return COLORS.find((c) => c.name === name)!.hex;
}

/** The palette colour for the n-th new notebook or section, so neighbours differ. */
export function colorForIndex(n: number): ColorName {
  return COLORS[((n % COLORS.length) + COLORS.length) % COLORS.length]!.name;
}

/** The palette colour closest to a `#rrggbb` value, for importers. */
export function nearestColor(hex: string): ColorName {
  const target = parseHex(hex);
  if (!target) return COLORS[0].name;
  let best: ColorName = COLORS[0].name;
  let bestDistance = Infinity;
  for (const c of COLORS) {
    const [r, g, b] = parseHex(c.hex)!;
    const d = (r - target[0]) ** 2 + (g - target[1]) ** 2 + (b - target[2]) ** 2;
    if (d < bestDistance) {
      best = c.name;
      bestDistance = d;
    }
  }
  return best;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}
