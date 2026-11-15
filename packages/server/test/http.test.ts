import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blobHash } from '@looseleaf/sync';
import { startServer } from '../src/server.js';
import { tempDir, TestServer, TOKEN } from './harness.js';

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('HTTP routes', () => {
  it('answers info and health without a token, with CORS for any origin', async () => {
    const server = await TestServer.start();
    const info = await fetch(`${server.url}/api/info`);
    expect(info.headers.get('access-control-allow-origin')).toBe('*');
    expect(info.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await info.json()).toEqual({ name: 'looseleaf', version: '0.1.0', protocol: 1 });
    expect(await (await fetch(`${server.url}/api/health`)).json()).toEqual({ ok: true });
    const preflight = await fetch(`${server.url}/api/blobs`, {
      method: 'OPTIONS',
      headers: { Origin: 'app://looseleaf', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(/PUT/);
    expect(preflight.headers.get('x-content-type-options')).toBe('nosniff');
    const missing = await fetch(`${server.url}/api/nothing`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('requires the token for blobs', async () => {
    const server = await TestServer.start();
    expect((await fetch(`${server.url}/api/blobs`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/blobs`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${server.url}/api/blobs/${'0'.repeat(64)}`, { method: 'PUT', body: 'x' })).status).toBe(401);
  });

  it('stores an upload under its hash, lists it, serves it, and rejects a corrupt one', async () => {
    const server = await TestServer.start();
    const bytes = new TextEncoder().encode('an attached file');
    const hash = blobHash(bytes);
    const put = await fetch(`${server.url}/api/blobs/${hash}`, { method: 'PUT', headers: auth, body: bytes });
    expect(put.status).toBe(201);
    expect((await fetch(`${server.url}/api/blobs/${hash}`, { method: 'PUT', headers: auth, body: bytes })).status).toBe(200);
    expect(await (await fetch(`${server.url}/api/blobs`, { headers: auth })).json()).toEqual({ blobs: [hash] });
    const get = await fetch(`${server.url}/api/blobs/${hash}`, { headers: auth });
    expect(get.headers.get('cache-control')).toMatch(/immutable/);
    expect(get.headers.get('content-type')).toBe('application/octet-stream');
    expect(get.headers.get('content-disposition')).toBe('attachment');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    const head = await fetch(`${server.url}/api/blobs/${hash}`, { method: 'HEAD', headers: auth });
    expect(head.headers.get('content-disposition')).toBe('attachment');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

    const other = blobHash(new TextEncoder().encode('what the name promises'));
    const corrupt = await fetch(`${server.url}/api/blobs/${other}`, { method: 'PUT', headers: auth, body: bytes });
    expect(corrupt.status).toBe(400);
    expect((await fetch(`${server.url}/api/blobs/${other}`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${server.url}/api/blobs/not-a-hash`, { headers: auth })).status).toBe(400);
  });

  it('refuses uploads past the size limit', async () => {
    const server = await TestServer.start({ maxBlobBytes: 10 });
    const bytes = new Uint8Array(11);
    const response = await fetch(`${server.url}/api/blobs/${blobHash(bytes)}`, { method: 'PUT', headers: auth, body: bytes });
    expect(response.status).toBe(413);
    expect(await server.current.store.listBlobs()).toEqual([]);
  });

  it('serves the web client with cache headers and falls back to index.html for navigations', async () => {
    const webDir = await tempDir();
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Looseleaf</title>');
    await mkdir(join(webDir, 'assets'));
    await writeFile(join(webDir, 'assets', 'app-1234.js'), 'console.log(1)');
    const server = await TestServer.start({ webDir });

    const index = await fetch(`${server.url}/`);
    expect(index.headers.get('content-type')).toMatch(/text\/html/);
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    expect(index.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' ws: wss: http: https:; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
    const asset = await fetch(`${server.url}/assets/app-1234.js`);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('cache-control')).toMatch(/immutable/);
    expect(asset.headers.get('content-security-policy')).toBeNull();
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await asset.text()).toBe('console.log(1)');
    const navigation = await fetch(`${server.url}/notebooks/abc/page`);
    expect(await navigation.text()).toMatch(/<title>Looseleaf/);
    expect(navigation.headers.get('content-security-policy')).toMatch(/^default-src 'self'/);
    expect(await (await fetch(`${server.url}/%2e%2e/%2e%2e/etc`)).text()).toMatch(/<title>Looseleaf/);
    expect((await fetch(`${server.url}/assets/old-chunk.js`)).status).toBe(404);
    expect((await fetch(`${server.url}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${server.url}/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
  });

  it('answers with a plain-text notice when there is no web client', async () => {
    const server = await TestServer.start({ webDir: await tempDir() });
    const response = await fetch(`${server.url}/anything`);
    expect(response.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await response.text()).toMatch(/no web client/);
  });
});

describe('access token', () => {
  it('generates a token on first start, saves it with mode 0600, and reuses it', async () => {
    const dataDir = await tempDir();
    const first = await startServer({ dataDir, port: 0 });
    await first.close();
    expect(first.tokenGenerated).toBe(true);
    expect((await readFile(join(dataDir, 'token'), 'utf8')).trim()).toBe(first.token);
    expect((await stat(join(dataDir, 'token'))).mode & 0o777).toBe(0o600);
    const second = await startServer({ dataDir, port: 0 });
    await second.close();
    expect(second.tokenGenerated).toBe(false);
    expect(second.token).toBe(first.token);
  });
});
