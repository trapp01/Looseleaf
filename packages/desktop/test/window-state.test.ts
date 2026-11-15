import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWindowState, MIN_HEIGHT, MIN_WIDTH, restoreWindowState, saveWindowState } from '../src/window-state.js';

const LAPTOP = { x: 0, y: 25, width: 1512, height: 920 };
const MONITOR = { x: 1512, y: 0, width: 2560, height: 1415 };

describe('restoreWindowState', () => {
  it('uses a default size and no position when nothing was saved', () => {
    for (const saved of [null, undefined, 'junk', 7]) {
      expect(restoreWindowState(saved, [LAPTOP])).toEqual({ width: 1280, height: 820, maximized: false });
    }
  });

  it('keeps a saved position on an attached display', () => {
    const saved = { x: 1700, y: 100, width: 1400, height: 900, maximized: true };
    expect(restoreWindowState(saved, [LAPTOP, MONITOR])).toEqual(saved);
  });

  it('drops the position when the title bar would be off every display', () => {
    const saved = { x: 1700, y: 100, width: 1200, height: 800, maximized: false };
    expect(restoreWindowState(saved, [LAPTOP])).toEqual({ width: 1200, height: 800, maximized: false });
    expect(restoreWindowState({ ...saved, x: 1450 }, [LAPTOP])).toEqual({ width: 1200, height: 800, maximized: false });
    expect(restoreWindowState({ ...saved, x: 100, y: -500 }, [LAPTOP])).toEqual({ width: 1200, height: 800, maximized: false });
  });

  it('holds the size between the minimum and the largest display', () => {
    expect(restoreWindowState({ width: 100, height: 100 }, [LAPTOP])).toMatchObject({ width: MIN_WIDTH, height: MIN_HEIGHT });
    expect(restoreWindowState({ width: 9000, height: 9000 }, [LAPTOP, MONITOR])).toMatchObject({ width: 2560, height: 1415 });
    expect(restoreWindowState({ width: Number.NaN, height: '600' }, [LAPTOP])).toMatchObject({ width: 1280, height: 820 });
  });
});

describe('window state file', () => {
  it('round-trips and survives a damaged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'looseleaf-window-'));
    const file = join(dir, 'window-state.json');
    expect(loadWindowState(file, [LAPTOP])).toEqual({ width: 1280, height: 820, maximized: false });
    saveWindowState(file, { x: 40, y: 60, width: 1000, height: 700 }, false);
    expect(loadWindowState(file, [LAPTOP])).toEqual({ x: 40, y: 60, width: 1000, height: 700, maximized: false });
  });
});
