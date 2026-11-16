// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MirrorRunner, type MirrorBridge, type MirrorClient } from '../src/mirror/mirror-runner.js';
import { MirrorSettings } from '../src/mirror/MirrorSettings.js';

afterEach(cleanup);

function runner() {
  const bridge: MirrorBridge = {
    chooseMirrorFolder: vi.fn(async () => ({ status: 'cancelled' as const })),
    mirrorFolder: async () => null,
    stopMirroring: vi.fn(async () => undefined),
    readMirrorManifest: async () => null,
    applyMirrorBatch: async () => ({ written: 0, removed: 0, refused: [] }),
  };
  const client = { onDocStored: () => () => undefined, onBlobStored: () => () => undefined } as unknown as MirrorClient;
  return { bridge, mirror: new MirrorRunner({ bridge, client }) };
}

describe('Mirror folder row', () => {
  it('offers to choose a folder when none is set', async () => {
    const { bridge, mirror } = runner();
    render(<MirrorSettings mirror={mirror} />);
    expect(screen.getByRole('heading', { name: 'Mirror folder' })).toBeTruthy();
    expect(
      screen.getByText(
        'Keeps a copy of every page as a Markdown file in a folder on this computer. The files are rewritten when a page changes; edits made to them are not read back.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop mirroring' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await vi.waitFor(() => expect(bridge.chooseMirrorFolder).toHaveBeenCalledTimes(1));
  });

  it('shows the folder, its status and the Change… and Stop mirroring buttons', async () => {
    const { bridge, mirror } = runner();
    mirror.state.set({ folder: '/Users/ann/Notes mirror', status: 'up-to-date', error: null });
    render(<MirrorSettings mirror={mirror} />);
    expect(screen.getByText('/Users/ann/Notes mirror')).toBeTruthy();
    expect(screen.getByText('Up to date')).toBeTruthy();
    mirror.state.set({ folder: '/Users/ann/Notes mirror', status: 'writing', error: null });
    expect(await screen.findByText('Writing…')).toBeTruthy();
    mirror.state.set({ folder: '/Users/ann/Notes mirror', status: 'failed', error: '/Volumes/Stick does not exist' });
    expect(await screen.findByText('Could not write to this folder: /Volumes/Stick does not exist')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop mirroring' }));
    await vi.waitFor(() => expect(bridge.stopMirroring).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Choose folder…' })).toBeTruthy();
  });

  it('says why a folder holding other files was refused', () => {
    const { mirror } = runner();
    mirror.state.set({ folder: null, status: 'not-empty', error: null });
    render(<MirrorSettings mirror={mirror} />);
    expect(screen.getByText('Choose an empty folder, or one that already holds a Looseleaf mirror.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeTruthy();
  });
});
