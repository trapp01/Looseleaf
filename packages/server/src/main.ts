/**
 * The server process: reads its settings from the environment (listed in
 * packages/server/README.md), starts the server and stops it cleanly on
 * SIGTERM or SIGINT.
 */
import { resolve } from 'node:path';
import { DEFAULT_MAX_BLOB_BYTES, DEFAULT_PORT, SERVER_VERSION, startServer } from './server.js';
import { DEFAULT_SNAPSHOT_KEEP } from './snapshots.js';

function numberFromEnv(name: string, fallback: number, { min }: { min: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of at least ${min}, got "${raw}"`);
  }
  return value;
}

function switchFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw.trim() === 'on') return true;
  if (raw.trim() === 'off') return false;
  throw new Error(`${name} must be "on" or "off", got "${raw}"`);
}

async function main(): Promise<void> {
  const dataDir = resolve(process.env.LOOSELEAF_DATA ?? './data');
  const server = await startServer({
    dataDir,
    port: numberFromEnv('LOOSELEAF_PORT', DEFAULT_PORT, { min: 0 }),
    token: process.env.LOOSELEAF_TOKEN,
    webDir: process.env.LOOSELEAF_WEB_DIR ? resolve(process.env.LOOSELEAF_WEB_DIR) : null,
    maxBlobBytes: numberFromEnv('LOOSELEAF_MAX_BLOB_BYTES', DEFAULT_MAX_BLOB_BYTES, { min: 1 }),
    snapshotKeep: numberFromEnv('LOOSELEAF_SNAPSHOT_KEEP', DEFAULT_SNAPSHOT_KEEP, { min: 1 }),
    mirror: switchFromEnv('LOOSELEAF_MIRROR', true),
  });
  console.log(`Looseleaf server ${SERVER_VERSION} listening on port ${server.port}, data in ${dataDir}`);
  console.log(server.mirror === null ? 'The mirror is off (LOOSELEAF_MIRROR=off)' : `Mirroring the notes as Markdown in ${server.mirror.root}`);
  console.log(server.webDir === null ? 'No web client is served' : `Serving the web client from ${server.webDir}`);
  if (server.tokenGenerated) {
    console.log(`Generated an access token and saved it to ${server.tokenSource}:\n\n  ${server.token}\n`);
  } else {
    console.log(`Access token from ${server.tokenSource}`);
  }

  const stop = (signal: string) => {
    console.log(`${signal} received; storing pending updates and closing connections`);
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Shutdown failed', error);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
