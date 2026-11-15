/**
 * The rich-text schema for text container bodies, defined once as the TipTap
 * extension list that the editor, the exporters and the importers share, and
 * the conversions between ProseMirror JSON and the Y.XmlFragment a body is
 * stored in. Builds in plain Node; nothing here touches the DOM until an
 * editor runs the extensions' parse and render hooks.
 */
import { Extension, getSchema, type AnyExtension, type JSONContent } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Highlight from '@tiptap/extension-highlight';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';

export type { JSONContent } from '@tiptap/core';

export const TAGS = ['todo', 'important', 'question', 'remember', 'definition'] as const;
export type TagName = (typeof TAGS)[number];

/** The name each tag shows under in the UI and in exports. */
export const TAG_LABELS: Record<TagName, string> = {
  todo: 'To Do',
  important: 'Important',
  question: 'Question',
  remember: 'Remember for later',
  definition: 'Definition',
};

export const PARAGRAPH_STYLES = ['quote', 'code', 'citation'] as const;
export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      /** Sets the font size of the selection, in pt. */
      setFontSize: (pt: number) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
    blockAttributes: {
      /** Indents the selected paragraphs and headings outside lists by one step. */
      increaseIndent: () => ReturnType;
      /** Outdents them by one step; false when none can move. */
      decreaseIndent: () => ReturnType;
    };
  }
}

/** Font size in pt as a text style attribute. Pasted px sizes become pt. */
const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => parseFontSize(element.style.fontSize),
            renderHTML: (attrs) =>
              typeof attrs.fontSize === 'number' ? { style: `font-size: ${attrs.fontSize}pt` } : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (pt) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: pt }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    };
  },
});

function parseFontSize(css: string): number | null {
  const m = /^([\d.]+)(pt|px)$/.exec(css.trim());
  if (!m) return null;
  const value = parseFloat(m[1]!);
  return m[2] === 'px' ? Math.round(value * 0.75 * 2) / 2 : value;
}

/** One indent step in CSS px. The editor and the HTML export both indent by this. */
export const INDENT_STEP_PX = 36;

/**
 * Adds `delta` indent steps (floored at 0) to every paragraph and heading the
 * selection touches, skipping those inside list items, which indent as list
 * levels. Writes into `tr` and returns whether anything changed, so a Tab key
 * binding can fall through to the list's own handling.
 */
export function changeIndent(tr: Transaction, delta: number): boolean {
  let changed = false;
  const { from, to } = tr.selection;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'listItem') return false;
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
    const current = Number(node.attrs.indent) || 0;
    const next = Math.max(0, current + delta);
    if (next !== current) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
      changed = true;
    }
    return false;
  });
  return changed;
}

function parseIndent(element: { getAttribute(name: string): string | null; style?: { marginLeft?: string } }): number {
  const data = Number(element.getAttribute('data-indent'));
  if (Number.isInteger(data) && data > 0) return data;
  const margin = /^([\d.]+)px$/.exec(element.style?.marginLeft?.trim() ?? '');
  return margin ? Math.round(parseFloat(margin[1]!) / INDENT_STEP_PX) : 0;
}

/** Tag, To Do state, paragraph style and indent on paragraphs and headings. */
const BlockAttributes = Extension.create({
  name: 'blockAttributes',
  addCommands() {
    return {
      increaseIndent:
        () =>
        ({ tr }) =>
          changeIndent(tr, 1),
      decreaseIndent:
        () =>
        ({ tr }) =>
          changeIndent(tr, -1),
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          tag: {
            default: null,
            parseHTML: (element) => oneOf(element.getAttribute('data-tag'), TAGS),
            renderHTML: (attrs) => (attrs.tag ? { 'data-tag': attrs.tag } : {}),
          },
          checked: {
            default: false,
            parseHTML: (element) => element.getAttribute('data-checked') === 'true',
            renderHTML: (attrs) => (attrs.checked ? { 'data-checked': 'true' } : {}),
          },
          style: {
            default: null,
            parseHTML: (element) => oneOf(element.getAttribute('data-style'), PARAGRAPH_STYLES),
            renderHTML: (attrs) => (attrs.style ? { 'data-style': attrs.style } : {}),
          },
          indent: {
            default: 0,
            parseHTML: parseIndent,
            renderHTML: (attrs) =>
              attrs.indent > 0
                ? { 'data-indent': String(attrs.indent), style: `margin-left: ${attrs.indent * INDENT_STEP_PX}px` }
                : {},
          },
        },
      },
    ];
  },
});

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

/** The part of a DOM element that parse hooks read; the package builds without the DOM types. */
interface ElementLike {
  getAttribute(name: string): string | null;
}

/** A background colour on table cells, as `#rrggbb` or null. */
const cellBackground = {
  background: {
    default: null,
    parseHTML: (element: ElementLike) => element.getAttribute('data-background'),
    renderHTML: (attrs: Record<string, unknown>) =>
      typeof attrs.background === 'string'
        ? { 'data-background': attrs.background, style: `background-color: ${attrs.background}` }
        : {},
  },
};

/**
 * A picture in the flow of a text container. It references a blob by its
 * SHA-256 hex; the editor supplies the picture's URL through a node view.
 */
const BlobImage = Image.extend({
  inline: false,
  group: 'block',
  addAttributes() {
    const dataAttr = (name: string, parse: (v: string) => unknown = (v) => v) => ({
      default: null,
      parseHTML: (element: ElementLike) => {
        const v = element.getAttribute(`data-${name}`) ?? element.getAttribute(name);
        return v === null ? null : parse(v);
      },
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs[name] === null || attrs[name] === undefined ? {} : { [`data-${name}`]: String(attrs[name]) },
    });
    const toNumber = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      blob: dataAttr('blob'),
      mime: dataAttr('mime'),
      width: dataAttr('width', toNumber),
      height: dataAttr('height', toNumber),
      alt: {
        default: null,
        parseHTML: (element: ElementLike) => element.getAttribute('alt'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.alt ? { alt: attrs.alt } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'img[data-blob]' }];
  },
  addInputRules() {
    return [];
  },
});

/**
 * THE extension list for text container bodies. History is off because Yjs
 * owns undo; quotes and code are paragraph styles, so the blockquote and code
 * block nodes are left out, as are the inline code mark and horizontal rule.
 */
export const richTextExtensions: AnyExtension[] = [
  StarterKit.configure({
    history: false,
    blockquote: false,
    codeBlock: false,
    code: false,
    horizontalRule: false,
  }),
  BlockAttributes,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Underline,
  Subscript,
  Superscript,
  Highlight.configure({ multicolor: true }),
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  Link.configure({ openOnClick: false, autolink: true }),
  Table,
  TableRow,
  TableCell.extend({
    addAttributes() {
      return { ...this.parent?.(), ...cellBackground };
    },
  }),
  TableHeader.extend({
    addAttributes() {
      return { ...this.parent?.(), ...cellBackground };
    },
  }),
  BlobImage,
];

export const richTextSchema = getSchema(richTextExtensions);

/** A body with one empty paragraph. */
export function emptyBody(): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** Throws a descriptive error when the JSON is not a document in the rich-text schema. */
export function assertValidBody(json: JSONContent): void {
  try {
    if (json.type !== 'doc') throw new Error(`the top node is "${json.type}", not "doc"`);
    PMNode.fromJSON(richTextSchema, json).check();
  } catch (error) {
    throw new Error(`Body does not fit the rich-text schema: ${(error as Error).message}`);
  }
}

/**
 * Fills an empty fragment with a ProseMirror JSON document. The fragment must
 * already be part of a Y.Doc. Throws when the JSON does not fit the schema.
 */
export function writeBody(fragment: Y.XmlFragment, json: JSONContent): void {
  if (!fragment.doc) throw new Error('writeBody needs a fragment that is already part of a Y.Doc');
  if (fragment.length > 0) throw new Error('writeBody needs an empty fragment');
  assertValidBody(json);
  prosemirrorJSONToYXmlFragment(richTextSchema, json, fragment);
}

/**
 * The fragment's content as ProseMirror JSON with every attribute filled in.
 * Never changes the doc. Content that no longer fits the schema (from a newer
 * client) comes back as stored rather than failing.
 */
export function readBody(fragment: Y.XmlFragment): JSONContent {
  const raw = yXmlFragmentToProsemirrorJSON(fragment) as JSONContent;
  try {
    return PMNode.fromJSON(richTextSchema, raw).toJSON() as JSONContent;
  } catch {
    return raw;
  }
}

/**
 * Plain text of a body: one line per paragraph or heading, `- ` or `1. ` for
 * list items (indented two spaces per level), tab-separated table cells, and
 * `[Picture: alt]` for pictures. With `tags`, tagged lines start with `[ ]`,
 * `[x]` or the tag's label in brackets; with `indent`, indented paragraphs
 * start with two spaces per step. No trailing newline.
 */
export function bodyToText(body: JSONContent, options: { tags?: boolean; indent?: boolean } = {}): string {
  const lines: string[] = [];
  const walk = (node: JSONContent, indent: string, marker: string): void => {
    switch (node.type) {
      case 'paragraph':
      case 'heading': {
        const steps = options.indent ? '  '.repeat(Number(node.attrs?.indent) || 0) : '';
        lines.push(indent + steps + marker + (options.tags ? tagPrefix(node) : '') + inlineText(node));
        return;
      }
      case 'image':
        lines.push(indent + marker + `[Picture${node.attrs?.alt ? `: ${node.attrs.alt}` : ''}]`);
        return;
      case 'bulletList':
      case 'orderedList':
        (node.content ?? []).forEach((item, i) => {
          const itemMarker = node.type === 'orderedList' ? `${(node.attrs?.start ?? 1) + i}. ` : '- ';
          (item.content ?? []).forEach((child, j) => {
            const nested = child.type === 'bulletList' || child.type === 'orderedList';
            walk(child, nested ? indent + '  ' : indent, j === 0 ? itemMarker : nested ? '' : '  ');
          });
        });
        return;
      case 'table':
        for (const row of node.content ?? []) {
          const cells = (row.content ?? []).map((cell) => bodyToText(cell, options).replace(/\n/g, ' '));
          lines.push(indent + cells.join('\t'));
        }
        return;
      default:
        for (const child of node.content ?? []) walk(child, indent, marker);
    }
  };
  walk(body, '', '');
  return lines.join('\n');
}

/** `[ ] `, `[x] ` or `[Label] ` for a tagged paragraph or heading; '' otherwise. */
export function tagPrefix(node: JSONContent): string {
  const tag = node.attrs?.tag as TagName | null | undefined;
  if (!tag || !TAG_LABELS[tag]) return '';
  if (tag === 'todo') return node.attrs?.checked ? '[x] ' : '[ ] ';
  return `[${TAG_LABELS[tag]}] `;
}

/** The text of an inline run of content; hard breaks become newlines. */
export function inlineText(node: JSONContent): string {
  return (node.content ?? [])
    .map((child) => (child.type === 'text' ? (child.text ?? '') : child.type === 'hardBreak' ? '\n' : ''))
    .join('');
}

/**
 * The link target exports and imports keep: web, mail, phone and in-page links,
 * trimmed. Null for anything else, such as a script URL.
 */
export function safeHref(href: string): string | null {
  return /^(https?:|mailto:|tel:|#)/i.test(href.trim()) ? href.trim() : null;
}
