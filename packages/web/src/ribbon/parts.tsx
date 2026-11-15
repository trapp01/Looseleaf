/**
 * Ribbon building blocks. Every command button reads its enabled and active
 * state and its tooltip from the command table and runs through it. Buttons
 * never take focus from the editor, so formatting applies to the selection.
 * `Unavailable` is a disabled button for a command that is not built.
 */
import { useRef, useState, type ReactNode } from 'react';
import { ChevronDownRegular } from '@fluentui/react-icons';
import { Popover } from '../app/controls.js';
import { useServices } from '../app/services.js';
import type { CommandId } from '../commands/command-table.js';

export const NOT_AVAILABLE = 'Not available yet';

const keepFocus = (event: React.MouseEvent) => event.preventDefault();

export function Group({ children, label, className = '' }: { children: ReactNode; label: string; className?: string }) {
  return (
    <div className={`ribbon-group ${className}`} role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** Two rows of small controls. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="ribbon-rows">{children}</div>;
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="ribbon-row">{children}</div>;
}

export function Cmd({
  id,
  icon,
  large,
  label,
  arg,
  showLabel,
}: {
  id: CommandId;
  icon: ReactNode;
  large?: boolean;
  label?: string;
  arg?: unknown;
  showLabel?: boolean;
}) {
  const { commands } = useServices();
  const enabled = commands.isEnabled(id, arg);
  const active = commands.isActive(id, arg);
  const text = label ?? commands.get(id).label;
  return (
    <button
      type="button"
      className={`ribbon-button ${large ? 'is-large' : ''} ${active ? 'is-active' : ''} ${showLabel ? 'has-label' : ''}`}
      disabled={!enabled}
      aria-pressed={commands.get(id).active ? active : undefined}
      aria-label={text}
      title={label ? text : commands.tooltip(id)}
      data-command={id}
      onMouseDown={keepFocus}
      onClick={() => commands.run(id, arg)}
    >
      <span className="ribbon-icon">{icon}</span>
      {(large || showLabel) && <span className="ribbon-label">{text}</span>}
    </button>
  );
}

export function Unavailable({ icon, label, large, why = NOT_AVAILABLE }: { icon: ReactNode; label: string; large?: boolean; why?: string }) {
  return (
    <span className="ribbon-unavailable" title={`${label}: ${why}`}>
      <button type="button" className={`ribbon-button ${large ? 'is-large' : ''}`} disabled aria-label={`${label} (${why})`}>
        <span className="ribbon-icon">{icon}</span>
        {large && <span className="ribbon-label">{label}</span>}
      </button>
    </span>
  );
}

/** A button with a panel under it; the panel gets `close`. */
export function MenuButton({
  icon,
  label,
  large,
  disabled,
  active,
  showLabel,
  children,
  testId,
}: {
  icon: ReactNode;
  label: string;
  large?: boolean;
  disabled?: boolean;
  active?: boolean;
  showLabel?: boolean;
  children: (close: () => void) => ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`ribbon-button has-menu ${large ? 'is-large' : ''} ${active ? 'is-active' : ''} ${showLabel ? 'has-label' : ''}`}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="true"
        data-testid={testId}
        onMouseDown={keepFocus}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ribbon-icon">{icon}</span>
        {(large || showLabel) && (
          <span className="ribbon-label">
            {label}
            <ChevronDownRegular className="menu-chevron" />
          </span>
        )}
        {!large && !showLabel && <ChevronDownRegular className="menu-chevron" />}
      </button>
      {open && (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} className="ribbon-popover">
          {children(() => setOpen(false))}
        </Popover>
      )}
    </>
  );
}

export const HIGHLIGHT_COLORS = ['#fff59d', '#c5e1a5', '#80deea', '#f8bbd0', '#90caf9', '#ffcc80', '#e0e0e0', '#ce93d8'];
export const FONT_COLORS = ['#1f1f1f', '#616161', '#c62828', '#ef6c00', '#f9a825', '#2e7d32', '#1565c0', '#6a1b9a'];

/** A swatch grid with "No colour" and a custom colour input. */
export function ColorGrid({
  colors,
  noneLabel,
  onPick,
}: {
  colors: string[];
  noneLabel: string;
  onPick: (color: string | null) => void;
}) {
  return (
    <div className="color-grid">
      <div className="swatches">
        {colors.map((c) => (
          <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={c} onClick={() => onPick(c)} />
        ))}
      </div>
      <div className="color-grid-actions">
        <button type="button" className="button small" onClick={() => onPick(null)}>
          {noneLabel}
        </button>
        <label className="button small color-custom">
          More colours…
          <input type="color" onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </div>
  );
}
