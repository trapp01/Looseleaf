/**
 * Markdown to safe HTML for comments. The text is written by other people and
 * by agents, so beyond stripping anything that could run: no `style`, `class`
 * or `id` (they could dress the text up as part of the app), every link opens
 * in a new tab without handing this page to it, and a picture that lives on
 * another site becomes a link, so reading a card never calls out to an
 * address the text chose.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

let hooked = false;

function hookElements(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      if (/^(blob:|data:image\/(png|jpeg|gif|webp);)/i.test(src)) return;
      const link = node.ownerDocument.createElement('a');
      link.textContent = node.getAttribute('alt') || src;
      if (/^https?:\/\//i.test(src)) {
        link.setAttribute('href', src);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
      node.replaceWith(link);
    }
  });
}

export function renderMarkdown(text: string): string {
  hookElements();
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style', 'class', 'id'] });
}
