/**
 * Markdown into a text container body. It reads what the Markdown export
 * (`export/markdown.ts`) writes, so exported text reads back the same:
 * paragraphs, headings, bullet and ordered lists, task items (To Do tags),
 * `[Label]` tag markers, block quotes and fenced code (paragraph styles), pipe
 * tables, bold, italic, strike, underline, subscript, superscript, links and
 * hard breaks. Inline code keeps its text without a mark, since the schema
 * has none. Anything else stays as plain text, and no input throws. The
 * Markdown becomes import-tree blocks, and `blocksToJson` builds the body
 * the same way an import does.
 */
import type { ImportedBlock, ImportedListItem, ImportedParagraph, ImportedRun } from './import-tree.js';
import { blocksToJson } from './import.js';
import { emptyBody, TAG_LABELS, TAGS, type JSONContent } from './rich-text.js';

export interface MarkdownBody {
  /** A rich-text document; one empty paragraph when the Markdown holds nothing. */
  body: JSONContent;
  /** What could not be kept, such as a link to an address the exports refuse. */
  warnings: string[];
}

/** Converts Markdown to a text container body. */
export async function markdownToBody(markdown: string): Promise<MarkdownBody> {
  const warnings: string[] = [];
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  const content = await blocksToJson(parseBlocks(lines), noPictures, (text) => warnings.push(text));
  return { body: { type: 'doc', content: content.length > 0 ? content : emptyBody().content }, warnings };
}

async function noPictures(): Promise<string> {
  throw new Error('Markdown blocks never hold picture bytes');
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const TABLE_DELIMITER = /^\|?:?-+:?(?:\|:?-+:?)*\|?$/;
/** A bracketed label in front of a paragraph, such as `[Important] `; it is a tag when the label is a tag's. */
const TAG_MARKER = /^\[([^\]]+)\][ \t]+/;
const TAG_BY_LABEL = new Map(TAGS.map((tag) => [TAG_LABELS[tag], tag]));
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

function parseBlocks(lines: string[]): ImportedBlock[] {
  const blocks: ImportedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') i += 1;
    else if (fenceAt(line)) i = parseFence(lines, i, blocks);
    else if (HEADING.test(line)) {
      blocks.push(leafBlock(line));
      i += 1;
    } else if (QUOTE.test(line)) i = parseQuote(lines, i, blocks);
    else if (listItemAt(line)) i = parseList(lines, i, blocks);
    else if (isTableStart(lines, i)) i = parseTable(lines, i, blocks);
    else i = parseParagraph(lines, i, blocks);
  }
  return blocks;
}

function fenceAt(line: string): { marker: string } | null {
  const match = FENCE.exec(line);
  if (match === null) return null;
  // A backtick fence's info string cannot hold a backtick; "```a```" is inline code.
  if (match[1]!.startsWith('`') && match[2]!.includes('`')) return null;
  return { marker: match[1]! };
}

/** Each line of a fenced block is one paragraph in the code style, as the export writes them. */
function parseFence(lines: string[], start: number, blocks: ImportedBlock[]): number {
  const { marker } = fenceAt(lines[start]!)!;
  let i = start + 1;
  for (; i < lines.length; i++) {
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]!);
    if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
    const text = lines[i]!;
    blocks.push({ type: 'paragraph', style: 'code', runs: text === '' ? [] : [{ text }] });
  }
  return i + 1;
}

function parseQuote(lines: string[], start: number, blocks: ImportedBlock[]): number {
  const inner: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const quoted = QUOTE.exec(line);
    if (quoted) inner.push(quoted[1]!);
    else if (line.trim() !== '' && inner.at(-1)?.trim() && !startsBlock(lines, i)) inner.push(line);
    else break;
  }
  for (const block of parseBlocks(inner)) {
    if (block.type === 'paragraph' && block.style === undefined) block.style = 'quote';
    blocks.push(block);
  }
  return i;
}

interface ListLine {
  indent: number;
  ordered: boolean;
  number: number;
  /** The column where the item's text starts; continuation lines are indented to it. */
  contentColumn: number;
  content: string;
}

function listItemAt(line: string): ListLine | null {
  const match = LIST_ITEM.exec(line);
  if (match === null) return null;
  const [, indent, marker, spaces, content] = match as unknown as [string, string, string, string, string];
  const gap = spaces.length >= 1 && spaces.length <= 4 ? spaces.length : 1;
  return {
    indent: indent.length,
    ordered: /\d/.test(marker),
    number: parseInt(marker, 10),
    contentColumn: indent.length + marker.length + gap,
    content,
  };
}

/**
 * A run of list items of one kind. A task item (`- [ ]`, `- [x]`) becomes a
 * To Do paragraph, as the export writes one, so tasks split a list around them.
 */
function parseList(lines: string[], start: number, blocks: ImportedBlock[]): number {
  const kind = listItemAt(lines[start]!)!.ordered;
  const items: ImportedListItem[] = [];
  const flush = () => {
    if (items.length > 0) blocks.push({ type: 'list', ordered: kind, items: items.splice(0) });
  };
  let i = start;
  while (i < lines.length) {
    const item = listItemAt(lines[i]!);
    if (item === null || item.ordered !== kind) break;
    const body = [item.content];
    i = collectItem(lines, i + 1, item, body);
    const task = TASK.exec(body[0]!);
    if (task === null) {
      items.push({ blocks: parseBlocks(body) });
      continue;
    }
    body[0] = body[0]!.slice(task[0].length);
    const inner = parseBlocks(body);
    const first = inner[0];
    const todo: ImportedParagraph = first?.type === 'paragraph' ? first : { type: 'paragraph', runs: [] };
    if (todo !== first) inner.unshift(todo);
    todo.tag = 'todo';
    todo.checked = task[1] !== ' ';
    // What sits under a task is indented one step below it.
    for (const block of inner.slice(1)) if (block.type === 'paragraph') block.indent = (block.indent ?? 0) + 1;
    flush();
    blocks.push(...inner);
  }
  flush();
  return i;
}

/** Adds the item's continuation lines to `body`, without their indent, and returns the first line after the item. */
function collectItem(lines: string[], start: number, item: ListLine, body: string[]): number {
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = leadingSpaces(line);
    const nested = listItemAt(line);
    if (line.trim() === '') {
      const next = lines.slice(i + 1).find((candidate) => candidate.trim() !== '');
      const nextNested = next === undefined ? null : listItemAt(next);
      const continues = next !== undefined && (leadingSpaces(next) >= item.contentColumn || (nextNested !== null && nextNested.indent > item.indent));
      if (!continues) break;
      body.push('');
    } else if (indent >= item.contentColumn) body.push(line.slice(item.contentColumn));
    // A list indented less than the text column still nests when it is deeper than this item's marker.
    else if (nested !== null) {
      if (nested.indent <= item.indent) break;
      body.push(line.slice(indent));
    } else if (body.at(-1)?.trim() && !startsBlock(lines, i)) body.push(line.trimStart());
    else break;
  }
  return i;
}

function leadingSpaces(line: string): number {
  return /^ */.exec(line)![0].length;
}

function isTableStart(lines: string[], i: number): boolean {
  const next = lines[i + 1];
  return lines[i]!.includes('|') && next !== undefined && next.includes('|') && TABLE_DELIMITER.test(next.replace(/\s/g, ''));
}

/** A pipe table; the delimiter row is dropped and every row gets the header's number of cells. */
function parseTable(lines: string[], start: number, blocks: ImportedBlock[]): number {
  const header = tableCells(lines[start]!);
  const rows = [header];
  let i = start + 2;
  for (; i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|'); i++) rows.push(tableCells(lines[i]!));
  blocks.push({
    type: 'table',
    rows: rows.map((row) =>
      header.map((_, column) => {
        const text = row[column]?.trim() ?? '';
        return { blocks: text === '' ? [] : [{ type: 'paragraph', runs: parseInline(text) }] };
      }),
    ),
  });
  return i;
}

/** A row's cells, split on pipes that are not escaped; the escapes stay for the inline parse. */
function tableCells(line: string): string[] {
  const row = line.trim().replace(/^\|/, '');
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && i + 1 < row.length) {
      cell += row[i]! + row[i + 1]!;
      i += 1;
    } else if (row[i] === '|') {
      cells.push(cell);
      cell = '';
    } else cell += row[i];
  }
  if (cell.trim() !== '') cells.push(cell);
  return cells;
}

function parseParagraph(lines: string[], start: number, blocks: ImportedBlock[]): number {
  const parts = [lines[start]!];
  let i = start + 1;
  for (; i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines, i); i++) parts.push(lines[i]!);
  blocks.push(leafBlock(joinLines(parts)));
  return i;
}

/** Whether the line starts a block that ends a paragraph above it. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  const item = listItemAt(line);
  const interruptingItem = item !== null && item.content.trim() !== '' && (!item.ordered || item.number === 1);
  return fenceAt(line) !== null || HEADING.test(line) || QUOTE.test(line) || interruptingItem || isTableStart(lines, i);
}

/**
 * A paragraph's lines as one string: a line ending in two spaces or a
 * backslash is a hard break (a newline here), any other line break is a space.
 */
function joinLines(parts: string[]): string {
  return parts
    .map((line, i) => {
      const last = i === parts.length - 1;
      const hard = !last && /( {2,}|\\)$/.test(line);
      let text = line.trim();
      if (hard && text.endsWith('\\')) text = text.slice(0, -1);
      return last ? text : text + (hard ? '\n' : ' ');
    })
    .join('');
}

/** A paragraph or heading, with a tag marker in front of it read as the tag. */
function leafBlock(source: string): ImportedParagraph {
  let text = source.trim();
  const paragraph: ImportedParagraph = { type: 'paragraph', runs: [] };
  const marker = TAG_MARKER.exec(text);
  const tag = marker === null ? undefined : TAG_BY_LABEL.get(marker[1]!);
  if (tag !== undefined) {
    paragraph.tag = tag;
    text = text.slice(marker![0].length);
  }
  const heading = HEADING.exec(text);
  if (heading !== null) {
    paragraph.heading = heading[1]!.length as ImportedParagraph['heading'];
    text = heading[2] ?? '';
  }
  paragraph.runs = parseInline(text);
  return paragraph;
}

type Marks = Omit<ImportedRun, 'text'>;

/** Inline Markdown as runs. A newline in `text` is a hard break. */
function parseInline(text: string, marks: Marks = {}, runs: ImportedRun[] = []): ImportedRun[] {
  let plain = '';
  const flush = () => {
    if (plain !== '') runs.push({ ...marks, text: plain });
    plain = '';
  };
  const nested = (inner: string, added: Marks) => {
    flush();
    parseInline(inner, { ...marks, ...added }, runs);
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length && ASCII_PUNCTUATION.test(text[i + 1]!)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const span = codeSpanAt(text, i);
      plain += span.text;
      i = span.end;
      continue;
    }
    const html = ch === '<' ? htmlAt(text, i) : null;
    if (html !== null) {
      if (html.kind === 'break') plain += '\n';
      else if (html.kind === 'autolink') {
        flush();
        runs.push({ ...marks, text: html.href, link: html.href });
      } else nested(html.inner, html.marks);
      i = html.end;
      continue;
    }
    const link = ch === '[' ? linkAt(text, i) : ch === '!' && text[i + 1] === '[' ? linkAt(text, i + 1) : null;
    if (link !== null) {
      nested(link.label === '' ? link.href : link.label, { link: link.href });
      i = link.end;
      continue;
    }
    const emphasis = ch === '*' || ch === '_' || ch === '~' ? emphasisAt(text, i) : null;
    if (emphasis !== null) {
      nested(emphasis.inner, emphasis.marks);
      i = emphasis.end;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return runs;
}

/** A code span's text without its backticks, or the backticks themselves when the span never closes. */
function codeSpanAt(text: string, start: number): { text: string; end: number } {
  const ticks = /^`+/.exec(text.slice(start))![0];
  const close = new RegExp(`(?<!\`)${ticks}(?!\`)`, 'g');
  close.lastIndex = start + ticks.length;
  const found = close.exec(text);
  if (found === null) return { text: ticks, end: start + ticks.length };
  let inner = text.slice(start + ticks.length, found.index).replace(/\n/g, ' ');
  if (/^ .*[^ ].* $/.test(inner)) inner = inner.slice(1, -1);
  return { text: inner, end: found.index + ticks.length };
}

const HTML_MARKS: Record<string, Marks> = { u: { underline: true }, sub: { subscript: true }, sup: { superscript: true }, mark: {} };

type InlineHtml =
  | { kind: 'break'; end: number }
  | { kind: 'autolink'; href: string; end: number }
  | { kind: 'marks'; inner: string; marks: Marks; end: number };

/**
 * The inline HTML the export writes: `<br>`, and `<u>`, `<sub>`, `<sup>` and
 * `<mark>` around text (a highlight's colour is not in the Markdown, so
 * `<mark>` keeps only the text); and `<https://…>` autolinks. Null for
 * anything else, which stays as text.
 */
function htmlAt(text: string, start: number): InlineHtml | null {
  const rest = text.slice(start);
  const br = /^<br\s*\/?>/i.exec(rest);
  if (br !== null) return { kind: 'break', end: start + br[0].length };
  const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
  if (auto !== null) return { kind: 'autolink', href: auto[1]!, end: start + auto[0].length };
  const open = /^<(u|sub|sup|mark)>/i.exec(rest);
  if (open === null) return null;
  const tag = open[1]!.toLowerCase();
  const close = rest.toLowerCase().indexOf(`</${tag}>`, open[0].length);
  if (close === -1) return null;
  return { kind: 'marks', inner: rest.slice(open[0].length, close), marks: HTML_MARKS[tag]!, end: start + close + tag.length + 3 };
}

/** `[label](href "title")` starting at the `[`, or null when it is not a complete link. */
function linkAt(text: string, start: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '[') depth += 1;
    else if (text[i] === ']' && --depth === 0) break;
  }
  if (i >= text.length || text[i + 1] !== '(') return null;
  const label = text.slice(start + 1, i);
  // `(`, then `<href>` or an href with escapes and one level of balanced parentheses, an optional title, then `)`.
  const target = /^\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/.exec(text.slice(i + 1));
  if (target === null) return null;
  const href = (target[1] ?? target[2] ?? '').replace(/\\([!-/:-@[-`{-~])/g, '$1');
  return { label, href, end: i + 1 + target[0].length };
}

/**
 * `***both***`, `**bold**`, `*italic*` (or with underscores) and `~~strike~~`
 * starting at `start`, or null. An underscore inside a word is plain text.
 */
function emphasisAt(text: string, start: number): { inner: string; marks: Marks; end: number } | null {
  const ch = text[start]!;
  const run = new RegExp(`^\\${ch}+`).exec(text.slice(start))![0];
  if (ch === '~') {
    if (run.length !== 2) return null;
    const close = closerOf(text, start + 2, '~', 2);
    return close === null ? null : { inner: text.slice(start + 2, close), marks: { strike: true }, end: close + 2 };
  }
  const after = text[start + run.length];
  if (after === undefined || /\s/.test(after)) return null;
  if (ch === '_' && /[\p{L}\p{N}]/u.test(text[start - 1] ?? '')) return null;
  const size = Math.min(run.length, 3);
  const close = closerOf(text, start + size, ch, size);
  if (close === null) return null;
  const marks: Marks = size === 3 ? { bold: true, italic: true } : size === 2 ? { bold: true } : { italic: true };
  return { inner: text.slice(start + size, close), marks, end: close + size };
}

/**
 * Where a closing run of `size` delimiters starts, skipping escapes and code
 * spans. A longer run closes with its last `size` characters, so `**a *b***`
 * nests. The closer must follow a non-space and close a non-empty span.
 */
function closerOf(text: string, from: number, ch: string, size: number): number | null {
  for (let i = from; i < text.length; ) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      i = codeSpanAt(text, i).end;
      continue;
    }
    if (text[i] !== ch) {
      i += 1;
      continue;
    }
    const length = new RegExp(`^\\${ch}+`).exec(text.slice(i))![0].length;
    const at = i + length - size;
    const fits = length >= size && at > from && !/\s/.test(text[i - 1] ?? ' ');
    const wordAfter = ch === '_' && /[\p{L}\p{N}]/u.test(text[i + length] ?? '');
    if (fits && !wordAfter) return at;
    i += length;
  }
  return null;
}
