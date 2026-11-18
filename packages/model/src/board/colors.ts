/**
 * The colour names a label can take. Labels have their own palette, separate
 * from the notebook and section colours in `../colors.ts`; the web client owns
 * the hex values.
 */
export const LABEL_COLORS = ['green', 'lime', 'yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'gray'] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export const DEFAULT_LABEL_COLOR: LabelColor = 'blue';

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === 'string' && (LABEL_COLORS as readonly string[]).includes(value);
}

/** The stored colour, or the default when a newer or damaged replica wrote a name this build does not know. */
export function labelColorOr(value: unknown): LabelColor {
  return isLabelColor(value) ? value : DEFAULT_LABEL_COLOR;
}

/** The colour used least among `taken`, so new labels spread across the palette. */
export function leastUsedLabelColor(taken: readonly LabelColor[]): LabelColor {
  let best: LabelColor = LABEL_COLORS[0];
  let bestCount = Infinity;
  for (const name of LABEL_COLORS) {
    const count = taken.filter((color) => color === name).length;
    if (count < bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}
