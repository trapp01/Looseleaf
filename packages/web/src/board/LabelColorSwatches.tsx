/** The ten label colours as radio buttons. */
import { CheckmarkRegular } from '@fluentui/react-icons';
import { LABEL_COLORS, type LabelColor } from '@looseleaf/model';
import { colorLabel } from './LabelChip.js';

export function LabelColorSwatches({ value, onChange }: { value: LabelColor; onChange: (color: LabelColor) => void }) {
  return (
    <fieldset className="field">
      <legend>Colour</legend>
      <div className="swatches" role="radiogroup" aria-label="Colour">
        {LABEL_COLORS.map((color) => (
          <button
            type="button"
            key={color}
            role="radio"
            aria-checked={color === value}
            aria-label={colorLabel(color)}
            title={colorLabel(color)}
            className={`swatch label-swatch label-${color}`}
            onClick={() => onChange(color)}
          >
            {color === value && <CheckmarkRegular aria-hidden="true" />}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
