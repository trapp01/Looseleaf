/**
 * The text forms that point at things on a board: a card ref (`DEE-12`), and
 * a link target, which is a URL or `looseleaf:<pageId>` for a page.
 */
import { BOARD_KEY_MAX_LENGTH } from './keys.js';

/** `DEE-12` for card 12 on the board whose key is DEE. */
export function formatCardRef(boardKey: string, cardNumber: number): string {
  return `${boardKey}-${cardNumber}`;
}

/**
 * Reads a card ref out of what a person or an agent typed: `DEE-12`,
 * `dee-12`, `#DEE-12`, or an address ending in `/DEE-12`. Null when the text
 * holds no ref. A key longer than a board key can be is no ref, so a page id
 * that happens to end in a dash and digits is not read as one.
 */
export function parseCardRef(text: string): { key: string; number: number } | null {
  const match = /(?:^|[/#\s])([A-Za-z][A-Za-z0-9]*)-(\d+)\/?$/.exec(text.trim());
  if (match === null || match[1]!.length > BOARD_KEY_MAX_LENGTH) return null;
  return { key: match[1]!.toUpperCase(), number: Number(match[2]) };
}

const PAGE_PREFIX = 'looseleaf:';

/** The link target for a page. */
export function looseleafTarget(pageId: string): string {
  return `${PAGE_PREFIX}${pageId}`;
}

export type LinkTarget = { kind: 'page'; pageId: string } | { kind: 'url'; url: string };

/** What a link target points at, or null when it is neither a page nor an http(s) URL. */
export function parseLinkTarget(target: string): LinkTarget | null {
  const trimmed = target.trim();
  if (trimmed.startsWith(PAGE_PREFIX)) {
    const pageId = trimmed.slice(PAGE_PREFIX.length);
    return /^[A-Za-z0-9_-]+$/.test(pageId) ? { kind: 'page', pageId } : null;
  }
  return /^https?:\/\/\S+$/i.test(trimmed) ? { kind: 'url', url: trimmed } : null;
}
