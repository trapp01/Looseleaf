/// <reference lib="webworker" />
/**
 * Parses one notebook's `.one` files off the main thread. It asks the page
 * for each file as the reader needs it, so only one section's bytes are here
 * at a time, and sends the finished import tree back with its bytes transferred.
 */
import { readNotebookFolderLazily } from '@looseleaf/onenote';
import type { ImportedNotebook } from '@looseleaf/model';
import type { WorkerReply, WorkerRequest } from './import-run.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const waiting = new Map<string, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>();

const reply = (message: WorkerReply, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'file') waiting.get(message.path)?.resolve(message.bytes);
  else if (message.type === 'file-error') waiting.get(message.path)?.reject(new Error(message.message));
  else void read(message.name, message.paths);
};

async function read(name: string, paths: string[]): Promise<void> {
  try {
    const notebook = await readNotebookFolderLazily(
      paths.map((path) => ({
        path,
        read: () =>
          new Promise<Uint8Array>((resolve, reject) => {
            waiting.set(path, { resolve, reject });
            reply({ type: 'need', path });
          }).finally(() => waiting.delete(path)),
      })),
      { name },
    );
    reply({ type: 'done', notebook }, buffersIn(notebook));
  } catch (error) {
    const e = error as Error;
    reply({ type: 'failed', name: e.name, message: e.message });
  }
}

/** Every distinct ArrayBuffer under the tree's pictures and files. */
function buffersIn(notebook: ImportedNotebook): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(notebook);
  return [...buffers];
}
