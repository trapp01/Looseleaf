// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLink, safeHref, stripUnsafeLinks } from '../src/canvas/links.js';

afterEach(() => vi.restoreAllMocks());

describe('safeHref', () => {
  it('lets http, https, mailto and tel through', () => {
    expect(safeHref('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeHref('http://nas:8421/')).toBe('http://nas:8421/');
    expect(safeHref('mailto:someone@example.org')).toBe('mailto:someone@example.org');
    expect(safeHref('tel:+15551234567')).toBe('tel:+15551234567');
  });

  it('refuses javascript:, data: and anything that is not a full URL', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref(' JavaScript:alert(1)')).toBeNull();
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('example.org')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

describe('openLink', () => {
  it('opens allowed links and does nothing for javascript: or data: links', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    openLink('javascript:alert(1)');
    openLink('data:text/html,hi');
    expect(open).not.toHaveBeenCalled();
    openLink('https://example.org');
    expect(open).toHaveBeenCalledWith('https://example.org/', '_blank', 'noopener');
  });
});

describe('stripUnsafeLinks', () => {
  it('removes javascript: and data: hrefs from a rendered container and keeps the rest', () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="javascript:alert(1)">a</a><a href="data:text/html,hi">b</a><a href="https://example.org">c</a>';
    stripUnsafeLinks(root);
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([null, null, 'https://example.org/']);
  });
});
