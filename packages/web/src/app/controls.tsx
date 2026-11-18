/**
 * The few shared building blocks of the chrome: icon buttons, a modal dialog
 * and an anchored popover. Each closes on Escape and on an outside press,
 * and returns focus where it came from.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { DismissRegular } from '@fluentui/react-icons';

export function IconButton({
  label,
  children,
  active,
  className = '',
  ...rest
}: { label: string; active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
  className = '',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, button:not(.dialog-close)');
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`dialog ${wide ? 'is-wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-header">
          <h2>{title}</h2>
          <IconButton label="Close" className="dialog-close" onClick={onClose}>
            <DismissRegular />
          </IconButton>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A panel anchored under an element, or above it when there is more room
 * there, kept inside the window and below the title bar and ribbon (it
 * scrolls when it is taller than the room); closes on outside press or Escape.
 */
export function Popover({
  anchor,
  onClose,
  children,
  align = 'start',
  className = '',
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const p = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === 'end' ? a.right - p.width : a.left;
    left = Math.max(8, Math.min(left, vw - p.width - 8));
    // A popover opened from the page stays below the title bar and ribbon; one opened from them may sit anywhere under them.
    const floor = Math.max(8, ...[...document.querySelectorAll('.title-bar, .ribbon')].map((el) => el.getBoundingClientRect().bottom + 4).filter((bottom) => bottom <= a.top));
    const below = vh - 8 - (a.bottom + 4);
    const above = a.top - 4 - floor;
    if (p.height <= below || below >= above) setPos({ left, top: a.bottom + 4, maxHeight: p.height > below ? below : undefined });
    else setPos({ left, top: Math.max(floor, a.top - 4 - p.height), maxHeight: p.height > above ? above : undefined });
  }, [anchor, align]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={ref}
      className={`popover ${className}`}
      style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight, overflowY: pos.maxHeight === undefined ? undefined : 'auto' } : { left: -9999, top: -9999 }}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('input, select, textarea')) e.preventDefault();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
