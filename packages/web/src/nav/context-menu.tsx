/**
 * Context menus for rows: opened by right-click or long-press (touch and pen),
 * one at a time, positioned inside the window. `useRowMenu` gives a row the
 * handlers for both; `ContextMenuHost` draws the open menu.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Store, useStore } from '../app/store.js';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** A row of colour swatches instead of a plain item. */
  swatches?: Array<{ name: string; hex: string; selected: boolean; onSelect: () => void }>;
}

/** A line of grey text naming the items under it, such as "Make it a card in". */
export interface MenuHeading {
  heading: string;
}

export type MenuEntry = MenuItem | MenuHeading | 'separator';

interface OpenMenu {
  x: number;
  y: number;
  entries: MenuEntry[];
}

const openMenu = new Store<OpenMenu | null>(null);

export function showMenu(x: number, y: number, entries: MenuEntry[]): void {
  openMenu.set({ x, y, entries });
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/** Handlers that open a menu from right-click and from a long press. */
export function useRowMenu(entries: () => MenuEntry[]) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const handlers = {
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      if (fired.current) return;
      showMenu(event.clientX, event.clientY, entries());
    },
    onPointerDown: (event: React.PointerEvent) => {
      fired.current = false;
      if (event.pointerType === 'mouse') return;
      start.current = { x: event.clientX, y: event.clientY };
      const { clientX, clientY } = event;
      timer.current = setTimeout(() => {
        fired.current = true;
        showMenu(clientX, clientY, entries());
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: React.PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(event.clientX - s.x, event.clientY - s.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
  return {
    handlers,
    /** True right after a long press opened the menu, so the row skips its click. */
    consumedLongPress: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}

export function ContextMenuHost() {
  const menu = useStore(openMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
    ref.current.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event.type === 'pointerdown' && ref.current?.contains(event.target as Node)) return;
      openMenu.set(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') openMenu.set(null);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        next?.focus();
      }
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!menu) return null;
  const run = (action?: () => void) => {
    openMenu.set(null);
    action?.();
  };
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={pos ?? { left: -9999, top: -9999 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={i} className="menu-separator" role="separator" />
        ) : 'heading' in entry ? (
          <div key={i} className="menu-heading" role="presentation">
            {entry.heading}
          </div>
        ) : entry.swatches ? (
          <div key={i} className="menu-swatches" role="group" aria-label={entry.label}>
            {entry.swatches.map((s) => (
              <button
                key={s.name}
                className={`swatch ${s.selected ? 'is-selected' : ''}`}
                style={{ background: s.hex }}
                aria-label={`${entry.label}: ${s.name}`}
                onClick={() => run(s.onSelect)}
              />
            ))}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${entry.danger ? 'is-danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => run(entry.onSelect)}
          >
            <span className="menu-icon">{entry.icon}</span>
            {entry.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
