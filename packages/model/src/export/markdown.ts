/**
 * One page as Markdown in reading order, with its pictures and files as
 * separate asset files. To Do tags become task list items; other tags become
 * a `[Label]` marker. Tables become GFM tables, with the first row as header.
 * Paragraph indent is dropped: leading spaces would turn it into a code block.
 * A card link becomes a link to the desktop app's page address, showing the
 * page title when the export has it.
 */
import { appPageAddress } from '../page-address.js';
import { TAG_LABELS, inlineText, safeHref, type JSONContent, type TagName } from '../rich-text.js';
import type { PageForExport } from './bundle.js';
import { assetFileName } from './names.js';

export interface MarkdownPage {
  markdown: string;
  /** Files to write into the assets folder, by file name. Missing blobs are left out. */
  assets: Map<string, Uint8Array>;
}

/**
 * `assetDir` is the assets folder relative to the Markdown file, such as
 * `assets` or `../../assets`.
 */
export function pageToMarkdown(page: PageForExport, assetDir: string): MarkdownPage {
  const assets = new Map<string, Uint8Array>();
  const asset = (hash: string, mime: string, name: string): string | null => {
    const bytes = page.blobs.get(hash);
    if (!bytes) return null;
    const file = assetFileName(hash, mime, name);
    assets.set(file, bytes);
    return `${assetDir}/${file}`;
  };
  const links: Links = {
    asset,
    cardLink: (pageId) => `[${escapeInline(cardLinkText(page, pageId))}](${encodeHref(appPageAddress(pageId))})`,
  };
  const created = new Date(page.createdAt).toISOString();
  const parts = [`# ${escapeInline(page.title || 'Untitled page')}`, `Created: ${created}`];
  for (const c of page.snapshot.containers) {
    if (c.kind === 'text') {
      const md = blocksToMarkdown(c.body.content ?? [], links);
      if (md.trim()) parts.push(md);
    } else if (c.kind === 'image') {
      const href = asset(c.blob, c.mime, c.name);
      parts.push(href ? `![${escapeInline(c.name)}](${encodeHref(href)})` : `[Missing picture: ${escapeInline(c.name)}]`);
    } else {
      const href = asset(c.blob, c.mime, c.name);
      parts.push(href ? `[${escapeInline(c.name)}](${encodeHref(href)})` : `[Missing file: ${escapeInline(c.name)}]`);
    }
  }
  return { markdown: parts.join('\n\n') + '\n', assets };
}

type AssetLink = (hash: string, mime: string, name: string) => string | null;

/** How the blocks of one page write its asset links and card links. */
interface Links {
  asset: AssetLink;
  cardLink: (pageId: string) => string;
}

/** The text a card link shows in an export: the page title, or a stand-in when the export does not know the page. */
export function cardLinkText(page: { pageTitles?: ReadonlyMap<string, string> }, pageId: string): string {
  const title = page.pageTitles?.get(pageId);
  return title === undefined ? 'Linked card' : title || 'Untitled page';
}


function blocksToMarkdown(blocks: JSONContent[], links: Links): string {
  const out: string[] = [];
  let codeLines: string[] | null = null;
  const flushCode = () => {
    if (codeLines) out.push('```\n' + codeLines.join('\n') + '\n```');
    codeLines = null;
  };
  for (const block of blocks) {
    if (block.type === 'paragraph' && block.attrs?.style === 'code') {
      (codeLines ??= []).push(inlineText(block));
      continue;
    }
    flushCode();
    out.push(blockToMarkdown(block, links));
  }
  flushCode();
  return out.filter((b) => b !== '').join('\n\n');
}

function blockToMarkdown(block: JSONContent, links: Links): string {
  const a = block.attrs ?? {};
  switch (block.type) {
    case 'paragraph':
    case 'heading': {
      let text = inlineToMarkdown(block.content ?? [], links);
      if (a.style === 'citation' && text) text = `*${text}*`;
      if (block.type === 'heading') text = `${'#'.repeat(Number(a.level ?? 1))} ${text}`;
      const tag = a.tag as TagName | null;
      if (tag === 'todo') text = `- [${a.checked ? 'x' : ' '}] ${text}`;
      else if (tag && TAG_LABELS[tag]) text = `[${TAG_LABELS[tag]}] ${text}`;
      if (a.style === 'quote') text = `> ${text}`;
      return text;
    }
    case 'bulletList':
    case 'orderedList':
      return (block.content ?? [])
        .map((item, i) => {
          const marker = block.type === 'orderedList' ? `${Number(a.start ?? 1) + i}. ` : '- ';
          return marker + indent(listItemToMarkdown(item.content ?? [], links), ' '.repeat(marker.length));
        })
        .join('\n');
    case 'table':
      return tableToMarkdown(block, links);
    case 'image':
      return imageMarkdown(a, links);
    default:
      return inlineToMarkdown(block.content ?? [], links);
  }
}

/** A nested list follows its item's text on the next line, which keeps the list tight. */
function listItemToMarkdown(blocks: JSONContent[], links: Links): string {
  return blocks
    .map((b, i) => {
      const md = blockToMarkdown(b, links);
      if (i === 0) return md;
      return (b.type === 'bulletList' || b.type === 'orderedList' ? '\n' : '\n\n') + md;
    })
    .join('');
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : pad + line))
    .join('\n');
}

function tableToMarkdown(table: JSONContent, links: Links): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((b) => blockToMarkdown(b, links).replace(/\n+/g, ' '))
        .filter(Boolean)
        .join('<br>'),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length), 1);
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

function imageMarkdown(a: Record<string, unknown>, links: Links): string {
  const alt = escapeInline(String(a.alt ?? ''));
  const href = a.blob ? links.asset(String(a.blob), String(a.mime ?? ''), '') : null;
  return href ? `![${alt}](${encodeHref(href)})` : `[Missing picture${alt ? `: ${alt}` : ''}]`;
}

function inlineToMarkdown(nodes: JSONContent[], links: Links): string {
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '<br>';
      if (node.type === 'image') return imageMarkdown(node.attrs ?? {}, links);
      if (node.type === 'cardLink') return typeof node.attrs?.pageId === 'string' ? links.cardLink(node.attrs.pageId) : '';
      if (node.type !== 'text') return '';
      return markText(node);
    })
    .join('');
}

/** Wraps a text node in the Markdown (or inline HTML) for its marks, keeping edge spaces outside. */
function markText(node: JSONContent): string {
  const raw = node.text ?? '';
  const lead = /^\s*/.exec(raw)![0];
  const trail = raw.length > lead.length ? /\s*$/.exec(raw)![0] : '';
  let text = escapeInline(raw.slice(lead.length, raw.length - trail.length));
  if (!text) return raw;
  let href: string | null = null;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        text = `**${text}**`;
        break;
      case 'italic':
        text = `*${text}*`;
        break;
      case 'strike':
        text = `~~${text}~~`;
        break;
      case 'underline':
        text = `<u>${text}</u>`;
        break;
      case 'subscript':
        text = `<sub>${text}</sub>`;
        break;
      case 'superscript':
        text = `<sup>${text}</sup>`;
        break;
      case 'highlight':
        text = `<mark>${text}</mark>`;
        break;
      case 'link':
        href = safeHref(String(mark.attrs?.href ?? ''));
        break;
    }
  }
  if (href) text = `[${text}](${encodeHref(href)})`;
  return lead + text + trail;
}

/** Escapes characters Markdown would read as syntax. */
function escapeInline(text: string): string {
  return text
    .replace(/([\\`*_[\]<>~|])/g, '\\$1')
    .replace(/^(\s*)([#+-])/, '$1\\$2')
    .replace(/^(\s*\d+)\./, '$1\\.');
}

function encodeHref(href: string): string {
  return href.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}
