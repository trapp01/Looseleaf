/**
 * A label as a chip: its colour and its name, since labels name things and
 * the colour alone would not say which. Colours come from board-tokens.css
 * through the `label-<colour>` class.
 */
import type { Label, LabelColor } from '@looseleaf/model';

export function LabelChip({ label, small = false }: { label: Pick<Label, 'name' | 'color'>; small?: boolean }) {
  return <span className={`label-chip label-${label.color} ${small ? 'is-small' : ''}`}>{label.name || 'Unnamed'}</span>;
}

/** The colour's name for screen readers and tooltips: "Green". */
export function colorLabel(color: LabelColor): string {
  return color[0]!.toUpperCase() + color.slice(1);
}
