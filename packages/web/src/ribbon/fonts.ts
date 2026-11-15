/**
 * The fonts the font list offers. Carlito is bundled and is the default note
 * font; the others are the system's generic families. A note whose font is
 * not installed (an imported "Calibri") falls back through @font-face aliases
 * in rich-text.css to a metric-compatible face.
 */
export const DEFAULT_FONT = 'Carlito';
export const DEFAULT_FONT_SIZE = 11;

export const FONTS: Array<{ value: string; label: string }> = [
  { value: 'Carlito', label: 'Carlito' },
  { value: 'sans-serif', label: 'Sans serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Monospace' },
];

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
