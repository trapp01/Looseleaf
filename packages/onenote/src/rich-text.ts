/**
 * One rich text outline element ([MS-ONE] 2.2.23) to one import-tree
 * paragraph: the text, its runs and their formatting, hyperlinks, paragraph
 * style and alignment, and note tags.
 */
import type { ImportedParagraph, ImportedRun } from '../../model/src/import-tree.js';
import { decodeExtendedAscii, type ExGuid } from './bytes.js';
import { PropertyId as P } from './property-ids.js';
import type { PropertySet } from './property-set.js';
import type { StoreObject } from './revision-store.js';

export interface ContentContext {
  object(id: ExGuid): StoreObject | undefined;
  /** Records a page warning; repeated messages are counted, not repeated. */
  warn(message: string): void;
}

/** A run before formatting is applied: its text and its jcidParagraphStyleObjectForText. */
export interface RawRun {
  text: string;
  format: PropertySet | undefined;
}

/** The paragraph's text: RichEditTextUnicode when set, else TextExtendedAscii (2.2.23). */
export function paragraphText(props: PropertySet): string {
  const unicode = props.string(P.RichEditTextUnicode);
  if (unicode !== undefined) return unicode;
  const ascii = props.bytes(P.TextExtendedAscii);
  return ascii ? decodeExtendedAscii(ascii) : '';
}

/**
 * Splits text at the TextRunIndex character positions (2.2.76). Run n spans
 * ends[n-1]..ends[n]; the last run ends at the end of the text. Positions are
 * clamped to the text so a bad index cannot drop or repeat characters.
 */
export function splitRuns(text: string, ends: number[], formats: Array<PropertySet | undefined>): RawRun[] {
  const runs: RawRun[] = [];
  let start = 0;
  for (let i = 0; i <= ends.length; i++) {
    const end = i < ends.length ? Math.min(Math.max(ends[i] ?? 0, start), text.length) : text.length;
    runs.push({ text: text.slice(start, end), format: formats[i] });
    start = end;
  }
  return runs;
}

const FIELD_START = '﷟';

/**
 * Parses the field-code form OneNote stores links in: a hidden run holding
 * U+FDDF, `HYPERLINK "target"`, then the display text in the following runs.
 * Returns the target and any display text that shares the run, or undefined
 * when the run is a field code of another kind.
 */
export function parseHyperlinkField(text: string): { url: string; rest: string } | undefined {
  const match = /^﷟\s*HYPERLINK\s+(?:"([^"]*)"|(\S+))\s?/i.exec(text);
  if (!match) return undefined;
  return { url: (match[1] ?? match[2] ?? '').trim(), rest: text.slice(match[0].length) };
}

/** The target of a run OneNote marked as a link without a field code: its own text, when that is a URL. */
function autoLinkTarget(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^(https?|ftp|mailto|onenote|file):\S+$/i.test(trimmed)) return trimmed;
  if (/^www\.\S+$/i.test(trimmed)) return `http://${trimmed}`;
  return undefined;
}

/** A COLORREF ([MS-ONE] 2.2.8) as #rrggbb; undefined for the automatic colour. */
export function colorRefToHex(value: number | undefined): string | undefined {
  if (value === undefined || value >>> 24 !== 0) return undefined;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(value & 0xff)}${hex((value >>> 8) & 0xff)}${hex((value >>> 16) & 0xff)}`;
}

function formatRun(text: string, format: PropertySet | undefined, link: string | undefined): ImportedRun {
  const run: ImportedRun = { text };
  if (format) {
    if (format.bool(P.Bold)) run.bold = true;
    if (format.bool(P.Italic)) run.italic = true;
    if (format.bool(P.Underline)) run.underline = true;
    if (format.bool(P.Strikethrough)) run.strike = true;
    if (format.bool(P.Superscript)) run.superscript = true;
    if (format.bool(P.Subscript)) run.subscript = true;
    // Black text and white highlight are dropped so imported text follows the app's theme.
    const color = colorRefToHex(format.uint(P.FontColor));
    if (color && color !== '#000000') run.color = color;
    const highlight = colorRefToHex(format.uint(P.Highlight));
    if (highlight && highlight !== '#ffffff') run.highlight = highlight;
    const font = format.string(P.Font);
    if (font) run.fontFamily = font;
    // FontSize is in half-points (2.3.16).
    const halfPoints = format.uint(P.FontSize);
    if (halfPoints) run.fontSize = halfPoints / 2;
  }
  if (link) run.link = link;
  return run;
}

const sameFormatting = (a: ImportedRun, b: ImportedRun): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('text');
  for (const key of keys) if (a[key as keyof ImportedRun] !== b[key as keyof ImportedRun]) return false;
  return true;
};

/**
 * Applies formatting and links to raw runs. Field-code runs are consumed,
 * hidden runs dropped, soft line breaks (U+000B) become "\n", and neighbours
 * with identical formatting are merged.
 */
export function buildRuns(raw: RawRun[], ctx: ContentContext): ImportedRun[] {
  const runs: ImportedRun[] = [];
  let fieldTarget: string | undefined;
  for (const { text: rawText, format } of raw) {
    let text = rawText;
    const isLink = format?.bool(P.Hyperlink) === true || format?.bool(P.HyperlinkProtected) === true;
    if (text.startsWith(FIELD_START)) {
      const field = parseHyperlinkField(text);
      if (!field) {
        ctx.warn('A field code other than a link was dropped');
        continue;
      }
      fieldTarget = field.url;
      text = field.rest;
    } else if (!isLink) {
      fieldTarget = undefined;
    }
    if (format?.bool(P.Hidden) || text === '') continue;
    if (format?.bool(P.MathFormatting)) ctx.warn('Equation imported as plain text');
    if (format?.bool(P.TextRunIsEmbeddedObject) || text.includes('￼')) {
      ctx.warn('An object embedded in text was not imported');
      text = text.replace(/￼/g, '');
      if (text === '') continue;
    }
    text = text.replace(/\u000b/g, '\n');
    const run = formatRun(text, format, isLink ? (fieldTarget ?? autoLinkTarget(text)) : undefined);
    const last = runs[runs.length - 1];
    if (last && sameFormatting(last, run)) last.text += run.text;
    else runs.push(run);
  }
  return runs;
}

const HEADING_STYLES: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const BLOCK_STYLES: Record<string, 'quote' | 'code' | 'citation'> = {
  blockquote: 'quote',
  quote: 'quote',
  code: 'code',
  cite: 'citation',
  citation: 'citation',
};

/** Reads a jcidRichTextOENode as a paragraph. */
export function readParagraph(node: StoreObject, ctx: ContentContext): ImportedParagraph {
  const props = node.props;
  const text = paragraphText(props);
  const formats = props.objectIds(P.TextRunFormatting).map((id) => ctx.object(id)?.props);
  const raw = splitRuns(text, props.uint32s(P.TextRunIndex) ?? [], formats);
  const paragraph: ImportedParagraph = { type: 'paragraph', runs: buildRuns(raw, ctx) };

  const styleId = props.objectId(P.ParagraphStyle);
  const style = styleId ? ctx.object(styleId)?.props : undefined;
  const styleName = style?.string(P.ParagraphStyleId)?.toLowerCase() ?? '';
  const heading = HEADING_STYLES[styleName];
  if (heading) paragraph.heading = heading;
  const blockStyle = BLOCK_STYLES[styleName];
  if (blockStyle) paragraph.style = blockStyle;

  // ParagraphAlignment (2.3.94): 0 left, 1 center, 2 right; set on the node or its style.
  const alignment = props.uint(P.ParagraphAlignment) ?? style?.uint(P.ParagraphAlignment);
  if (alignment === 1) paragraph.align = 'center';
  else if (alignment === 2) paragraph.align = 'right';

  applyNoteTags(props, paragraph, ctx);
  return paragraph;
}

type TagKind = NonNullable<ImportedParagraph['tag']>;

// NoteTagShape values (2.3.86) that draw a check box.
const CHECKABLE_SHAPES = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 28, 30, 32, 48, 50, 52, 69, 71, 73, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98,
  99,
]);
const SHAPE_YELLOW_STAR = 13;
const SHAPE_QUESTION_MARK = 15;
const LABELS: Record<string, TagKind> = {
  'to do': 'todo',
  important: 'important',
  question: 'question',
  'remember for later': 'remember',
  definition: 'definition',
};

/**
 * Maps a note tag (2.1.9) to an import-tree tag. Task tags and check-box shapes
 * are to-dos; otherwise the shape, then the English default label decide.
 */
export function classifyNoteTag(shape: number | undefined, label: string | undefined, isTask: boolean): TagKind | undefined {
  if (isTask || (shape !== undefined && CHECKABLE_SHAPES.has(shape))) return 'todo';
  if (shape === SHAPE_YELLOW_STAR) return 'important';
  if (shape === SHAPE_QUESTION_MARK) return 'question';
  return label ? LABELS[label.trim().toLowerCase()] : undefined;
}

/** Applies NoteTagStates (2.2.88). A paragraph holds one tag; the first that maps wins. */
function applyNoteTags(props: PropertySet, paragraph: ImportedParagraph, ctx: ContentContext): void {
  for (const state of props.sets(P.NoteTagStates)) {
    const definitionId = state.objectId(P.NoteTagDefinitionOid);
    const definition = definitionId ? ctx.object(definitionId)?.props : undefined;
    const status = state.uint(P.ActionItemStatus) ?? 0;
    const isTask = (status & 0x4) !== 0;
    const shape = definition?.uint(P.NoteTagShape) ?? state.uint(P.NoteTagShape);
    const label = definition?.string(P.NoteTagLabel);
    const kind = classifyNoteTag(shape, label, isTask);
    if (!kind || paragraph.tag) {
      ctx.warn(label ? `Tag "${label}" not imported` : 'A tag was not imported');
      continue;
    }
    paragraph.tag = kind;
    // ActionItemStatus bit 0 is Completed (2.3.91); it is always set on tags without a check box.
    if (kind === 'todo') paragraph.checked = (status & 0x1) !== 0;
  }
}

/** Warns about note tags on content that cannot carry one (pictures, tables, files). */
export function warnUntaggable(props: PropertySet, what: string, ctx: ContentContext): void {
  if (props.sets(P.NoteTagStates).length > 0) ctx.warn(`Tag on a ${what} not imported`);
}
