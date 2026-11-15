import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentTypeFor, findWebFile, isAppUrl, originOf, webFilePath } from '../src/web-client.js';

const ROOT = join(sep, 'srv', 'web');

describe('webFilePath', () => {
  it('maps a URL path to a file under the root', () => {
    expect(webFilePath(ROOT, '/assets/app.js')).toBe(join(ROOT, 'assets', 'app.js'));
    expect(webFilePath(ROOT, '/My%20Notes.html')).toBe(join(ROOT, 'My Notes.html'));
  });

  it('never leaves the root, whatever the traversal spelling', () => {
    const attempts = [
      '/../secret',
      '/../../etc/passwd',
      '/assets/../../etc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/%2E%2E%2Fetc%2Fpasswd',
      '/..%2f..%2fetc/passwd',
      '/..\\..\\windows\\win.ini',
      '/%5c..%5c..%5cetc',
      '//etc/passwd',
      '/./../etc',
    ];
    for (const attempt of attempts) {
      const resolved = webFilePath(ROOT, attempt);
      expect(resolved === null || resolved.startsWith(ROOT + sep), attempt).toBe(true);
      expect(resolved ?? '', attempt).not.toContain('..');
    }
  });

  it('names no file for the root, malformed escapes, NUL bytes and drive letters', () => {
    expect(webFilePath(ROOT, '/')).toBeNull();
    expect(webFilePath(ROOT, '/%E0%A4%A')).toBeNull();
    expect(webFilePath(ROOT, '/index.html%00.png')).toBeNull();
    expect(webFilePath(ROOT, '/C:/Windows/win.ini')).toBeNull();
  });
});

describe('findWebFile', () => {
  async function builtClient(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'looseleaf-web-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html>');
    await writeFile(join(root, 'assets', 'app.js'), '');
    return root;
  }

  it('serves a file that exists', async () => {
    const root = await builtClient();
    expect(await findWebFile(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
  });

  it('falls back to index.html for the root, unknown paths, folders and traversal', async () => {
    const root = await builtClient();
    const index = join(root, 'index.html');
    for (const path of ['/', '/notebooks/abc', '/assets', '/assets/missing.js', '/../../etc/passwd']) {
      expect(await findWebFile(root, path), path).toBe(index);
    }
  });

  it('finds nothing when the client is not built', async () => {
    const root = await mkdtemp(join(tmpdir(), 'looseleaf-web-'));
    expect(await findWebFile(root, '/')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('knows the web client file types and falls back to bytes', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a/b.JS')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('font.woff2')).toBe('font/woff2');
    expect(contentTypeFor('engine.wasm')).toBe('application/wasm');
    expect(contentTypeFor('notes.bin')).toBe('application/octet-stream');
  });
});

describe('isAppUrl', () => {
  it('accepts the app origin and nothing that only looks like it', () => {
    expect(isAppUrl('app://looseleaf/')).toBe(true);
    expect(isAppUrl('app://looseleaf/notebooks/1?x=1#y')).toBe(true);
    expect(isAppUrl('app://looseleaf.evil/')).toBe(false);
    expect(isAppUrl('app://evil/looseleaf')).toBe(false);
    expect(isAppUrl('https://looseleaf/')).toBe(false);
    expect(isAppUrl('file:///Users/me/index.html')).toBe(false);
    expect(isAppUrl('')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
  });

  it('accepts the development server origin only when one is set', () => {
    expect(isAppUrl('http://localhost:5173/page', 'http://localhost:5173/')).toBe(true);
    expect(isAppUrl('http://localhost:5174/page', 'http://localhost:5173/')).toBe(false);
    expect(isAppUrl('http://localhost:5173/page')).toBe(false);
  });

  it('builds origins for non-http schemes', () => {
    expect(originOf('app://looseleaf/a/b')).toBe('app://looseleaf');
    expect(originOf('http://nas:8421/api')).toBe('http://nas:8421');
    expect(originOf('about:blank')).toBeNull();
  });
});
