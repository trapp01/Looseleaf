/**
 * Writes docs into a test server from Node, through a real sync client over
 * a WebSocket, so a test can start from content the UI did not make.
 */
import WebSocket from 'ws';
import type * as Y from 'yjs';
import { MemoryStore, SyncClient, type SocketConstructor } from '@looseleaf/sync';
import { TOKEN } from './server.js';

export async function seed(url: string, build: (open: (docId: string) => Promise<Y.Doc>) => Promise<void>): Promise<void> {
  const client = await SyncClient.create({ store: new MemoryStore(), WebSocket: WebSocket as unknown as SocketConstructor });
  await client.connect({ url, token: TOKEN });
  await until(() => client.status.state === 'synced');
  await build((docId) => client.openDoc(docId));
  await until(() => client.status.state === 'synced' && client.status.unsentDocs === 0 && client.status.unsentBlobs === 0);
  // The last updates are sent as they are stored; give the socket a moment to flush them.
  await new Promise((r) => setTimeout(r, 500));
  await client.close();
}

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the seeding client to sync');
    await new Promise((r) => setTimeout(r, 50));
  }
}
