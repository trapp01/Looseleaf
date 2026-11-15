/**
 * Starts packages/server from source on a spare port over a temp data folder,
 * serving the built web client, for one test file. `stop` and `start` let a
 * test take the server away mid-session and bring it back on the same port.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../dist');
const serverMain = resolve(here, '../../server/src/main.ts');
const tsx = resolve(here, '../../../node_modules/.bin/tsx');

export const TOKEN = 'e2e-test-token';

async function sparePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => done(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

export class TestServer {
  private child: ChildProcess | null = null;
  private constructor(
    readonly port: number,
    readonly dataDir: string,
  ) {}

  static async create(): Promise<TestServer> {
    const server = new TestServer(await sparePort(), await mkdtemp(join(tmpdir(), 'looseleaf-e2e-')));
    await server.start();
    return server;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const child = spawn(tsx, [serverMain], {
      env: {
        ...process.env,
        LOOSELEAF_PORT: String(this.port),
        LOOSELEAF_DATA: this.dataDir,
        LOOSELEAF_TOKEN: TOKEN,
        LOOSELEAF_WEB_DIR: webDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let output = '';
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`Server did not start:\n${output}`)), 20_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('listening on port')) {
          clearTimeout(timer);
          done();
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`Server exited with ${code}:\n${output}`));
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.child = null;
    await new Promise<void>((done) => {
      child.once('exit', () => done());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    });
  }

  async dispose(): Promise<void> {
    await this.stop();
    await rm(this.dataDir, { recursive: true, force: true });
  }
}
