/**
 * The window's size and position, kept in a small JSON file between launches.
 * A saved position is used only when the window's title bar would land on a
 * display that is still attached.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** Absent when the saved position is off every display; the window is then centred. */
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const MIN_WIDTH = 480;
export const MIN_HEIGHT = 600;
const DEFAULT_STATE: WindowState = { width: 1280, height: 820, maximized: false };
// How much of the title bar must be on screen for the saved position to be kept.
const TITLE_BAR_HEIGHT = 36;
const MIN_VISIBLE_TITLE_BAR = 100;

/** A usable window state from whatever was saved (or nothing), fitted to the displays' work areas. */
export function restoreWindowState(saved: unknown, workAreas: Rect[]): WindowState {
  if (typeof saved !== 'object' || saved === null) return { ...DEFAULT_STATE };
  const s = saved as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
  const maxWidth = Math.max(MIN_WIDTH, ...workAreas.map((a) => a.width));
  const maxHeight = Math.max(MIN_HEIGHT, ...workAreas.map((a) => a.height));
  const width = Math.min(Math.max(num(s.width) ?? DEFAULT_STATE.width, MIN_WIDTH), maxWidth);
  const height = Math.min(Math.max(num(s.height) ?? DEFAULT_STATE.height, MIN_HEIGHT), maxHeight);
  const state: WindowState = { width, height, maximized: s.maximized === true };
  const x = num(s.x);
  const y = num(s.y);
  if (x !== undefined && y !== undefined && titleBarVisible({ x, y, width, height: TITLE_BAR_HEIGHT }, workAreas)) {
    state.x = x;
    state.y = y;
  }
  return state;
}

function titleBarVisible(bar: Rect, workAreas: Rect[]): boolean {
  return workAreas.some((area) => {
    const overlapX = Math.min(bar.x + bar.width, area.x + area.width) - Math.max(bar.x, area.x);
    const overlapY = Math.min(bar.y + bar.height, area.y + area.height) - Math.max(bar.y, area.y);
    return overlapX >= MIN_VISIBLE_TITLE_BAR && overlapY > 0;
  });
}

export function loadWindowState(file: string, workAreas: Rect[]): WindowState {
  let saved: unknown = null;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // A missing or damaged file means the default size.
  }
  return restoreWindowState(saved, workAreas);
}

export function saveWindowState(file: string, bounds: Rect, maximized: boolean): void {
  writeFileSync(file, `${JSON.stringify({ ...bounds, maximized })}\n`);
}
