/**
 * The import tree: the neutral, plain-object form of a notebook that every
 * importer produces and `importTree` turns into docs. It carries no ids; ids
 * are assigned on import. Lengths are CSS px, font sizes are pt, colours are
 * `#rrggbb`, times are epoch ms.
 */

export interface ImportedNotebook {
  name: string;
  color?: string;
  children: Array<ImportedSectionGroup | ImportedSection>;
}

export interface ImportedSectionGroup {
  kind: 'group';
  name: string;
  children: Array<ImportedSectionGroup | ImportedSection>;
}

export interface ImportedSection {
  kind: 'section';
  name: string;
  color?: string;
  pages: ImportedPage[];
}

export interface ImportedPage {
  title: string;
  /** 0 for a top page, 1 or 2 for a subpage. */
  level: 0 | 1 | 2;
  createdAt?: number;
  modifiedAt?: number;
  containers: ImportedContainer[];
  strokes: ImportedStroke[];
  /** Things the importer saw and could not represent, for the import report. */
  warnings: string[];
}

export type ImportedContainer =
  | ImportedTextContainer
  | ImportedBlobContainer;

export interface ImportedTextContainer {
  kind: 'text';
  x: number;
  y: number;
  width: number;
  blocks: ImportedBlock[];
}

/** A picture or attached file placed directly on the page. */
export interface ImportedBlobContainer {
  kind: 'image' | 'file';
  x: number;
  y: number;
  width: number;
  height?: number;
  data: Uint8Array;
  mime: string;
  name: string;
}

export type ImportedBlock =
  | ImportedParagraph
  | ImportedList
  | ImportedTable
  | ImportedInlineImage;

export interface ImportedParagraph {
  type: 'paragraph';
  /** 1–6 for a heading; absent for body text. */
  heading?: 1 | 2 | 3 | 4 | 5 | 6;
  style?: 'quote' | 'code' | 'citation';
  align?: 'left' | 'center' | 'right';
  /** Indent steps for a paragraph outside a list. Absent means 0. */
  indent?: number;
  tag?: 'todo' | 'important' | 'question' | 'remember' | 'definition';
  /** Only meaningful with tag 'todo'. */
  checked?: boolean;
  runs: ImportedRun[];
}

export interface ImportedRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  subscript?: boolean;
  superscript?: boolean;
  color?: string;
  highlight?: string;
  fontFamily?: string;
  fontSize?: number;
  link?: string;
}

/** One list. Nested lists sit inside an item's blocks. */
export interface ImportedList {
  type: 'list';
  ordered: boolean;
  items: ImportedListItem[];
}

export interface ImportedListItem {
  blocks: ImportedBlock[];
}

export interface ImportedTable {
  type: 'table';
  /** Column widths in px, when the source has them. */
  columnWidths?: number[];
  rows: ImportedTableCell[][];
}

export interface ImportedTableCell {
  blocks: ImportedBlock[];
  background?: string;
}

/** A picture that sits in the flow of a text container. */
export interface ImportedInlineImage {
  type: 'image';
  data: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface ImportedStroke {
  tool: 'pen' | 'marker' | 'highlighter';
  color: string;
  width: number;
  /** `[x0, y0, x1, y1, …]` in px from the canvas origin. */
  points: number[];
}
