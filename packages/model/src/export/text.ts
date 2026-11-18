import { bodyToText } from '../rich-text.js';
import type { PageForExport } from './bundle.js';
import { cardLinkText } from './markdown.js';

/**
 * One page as plain text: title, created time, then each container in
 * reading order separated by a blank line. Tags show as `[ ]`, `[x]` or
 * `[Label]`, each indent step as two spaces; pictures and files show as their
 * names; a card link shows the page title.
 */
export function pageToText(page: PageForExport): string {
  const parts = [page.title || 'Untitled page', `Created: ${new Date(page.createdAt).toISOString()}`];
  for (const c of page.snapshot.containers) {
    if (c.kind === 'text') {
      const text = bodyToText(c.body, { tags: true, indent: true, cardLinkText: (pageId) => cardLinkText(page, pageId) });
      if (text.trim()) parts.push(text);
    } else {
      parts.push(`[${c.kind === 'image' ? 'Picture' : 'File'}: ${c.name}]`);
    }
  }
  return parts.join('\n\n') + '\n';
}
