// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/board/render-markdown.js';

describe('renderMarkdown', () => {
  it('keeps formatting and strips anything that could run, dress up or call out', () => {
    const html = renderMarkdown(
      [
        'Plain **bold** text.',
        '<div class="modal" style="position:fixed" id="overlay">Sign in again</div>',
        '![tracker](https://example.com/pixel.png)',
        '<img src="x" onerror="alert(1)">',
        '[click](javascript:alert(1))',
        '[seeds](https://example.com/seeds)',
      ].join('\n\n'),
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.querySelectorAll('[style], [class], [id], [onerror]')).toHaveLength(0);
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
    const tracker = [...root.querySelectorAll('a')].find((a) => a.textContent === 'tracker');
    expect(tracker?.getAttribute('href')).toBe('https://example.com/pixel.png');
    const seeds = [...root.querySelectorAll('a')].find((a) => a.textContent === 'seeds');
    expect(seeds?.getAttribute('target')).toBe('_blank');
    expect(seeds?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
