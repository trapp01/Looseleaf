/**
 * The rule for a To Do line's id and tagged-at time, in one place for the
 * editor and the Markdown importer. Tagging a paragraph or heading To Do
 * gives it a `lineId` and a `taggedAt` time; removing the tag clears neither,
 * so tagging it again keeps both. A pasted, copied or split-off line gets a
 * new id; a line moved by dragging keeps its own. Importers of other formats
 * leave both empty, so their lines never reach a board's Inbox, and editing
 * such a line never gives it an id. The editor applies the rule through
 * `todoLinePlugin`, which `richTextExtensions` includes.
 */
import type { JSONContent } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { ySyncPluginKey } from 'y-prosemirror';
import { newId } from './ids.js';

/** Where new line ids and tagged-at times come from. Tests pass fixed ones. */
export interface TodoLineStamp {
  /** Epoch ms. */
  now: () => number;
  newId: () => string;
}

export const SYSTEM_STAMP: TodoLineStamp = { now: () => Date.now(), newId };

/** The node types that can carry a tag, and so a line id. */
const LINE_TYPES = new Set(['paragraph', 'heading']);

type Attrs = Record<string, unknown>;

/**
 * The attributes a paragraph or heading gets when the To Do tag is put on it:
 * an id and a tagged-at time when it has none yet. A line tagged again after
 * its tag was removed keeps both.
 */
export function tagTodoLine(attrs: Attrs, stamp: TodoLineStamp = SYSTEM_STAMP): Attrs {
  return {
    ...attrs,
    tag: 'todo',
    lineId: typeof attrs.lineId === 'string' && attrs.lineId !== '' ? attrs.lineId : stamp.newId(),
    taggedAt: typeof attrs.taggedAt === 'number' ? attrs.taggedAt : stamp.now(),
  };
}

/** The attributes of a pasted or duplicated line: a new id, with its tagged-at time and Inbox choice kept. */
export function copyTodoLine(attrs: Attrs, stamp: TodoLineStamp = SYSTEM_STAMP): Attrs {
  return { ...attrs, lineId: stamp.newId() };
}

function isLine(type: string | undefined): boolean {
  return type !== undefined && LINE_TYPES.has(type);
}

/**
 * A body with every To Do line tagged by `tagTodoLine`, for content made new
 * by an importer that stamps its lines. Does not change the input.
 */
export function stampTodoLines(body: JSONContent, stamp: TodoLineStamp = SYSTEM_STAMP): JSONContent {
  const walk = (node: JSONContent): JSONContent => {
    const content = node.content?.map(walk);
    const next = content === undefined ? { ...node } : { ...node, content };
    if (isLine(node.type) && node.attrs?.tag === 'todo') next.attrs = tagTodoLine(node.attrs, stamp);
    return next;
  };
  return walk(body);
}

/** Pasted content with every line that has an id, or is a To Do line, given a new id. */
function renewPasted(fragment: Fragment, stamp: TodoLineStamp): Fragment {
  const children: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      children.push(node);
      return;
    }
    const content = renewPasted(node.content, stamp);
    const renew = isLine(node.type.name) && (node.attrs.tag === 'todo' || typeof node.attrs.lineId === 'string');
    children.push(node.type.create(renew ? copyTodoLine(node.attrs, stamp) : node.attrs, content, node.marks));
  });
  return Fragment.from(children);
}

/**
 * Applies the rule in an editor. After each local change: of two lines
 * sharing an id (a split or a drag that copies makes them), the one holding
 * the old line's content keeps it and the other gets its own, so Enter at the
 * start of a line leaves the text with its id and a dragged copy gets a new
 * one. A To Do line with no id keeps none while it is the same line
 * as before the change, however it was moved, wrapped, lifted or split; a To
 * Do line the change made or tagged gets one. Pasted lines get new ids; a
 * line dragged within the editor keeps its id, unless the drag copies it.
 * Changes that arrive from Yjs (another replica, undo, the first load) are
 * left alone.
 */
export function todoLinePlugin(stamp: TodoLineStamp = SYSTEM_STAMP): Plugin {
  // Whether the drop about to be dispatched moves its content rather than copying it.
  let dropMoves = false;
  return new Plugin({
    key: new PluginKey('todoLineIds'),
    props: {
      handleDrop: (_view, _event, _slice, moved) => {
        dropMoves = moved;
        return false;
      },
      // A drag inside this editor has `view.dragging` set; its lines keep their ids here, and a copy's are renewed below.
      transformPasted: (slice, view) => (view.dragging ? slice : new Slice(renewPasted(slice.content, stamp), slice.openStart, slice.openEnd)),
    },
    appendTransaction: (transactions, oldState, newState) => {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      if (transactions.some((tr) => tr.getMeta(ySyncPluginKey)?.isChangeOrigin)) return null;
      const mapping = new Mapping();
      for (const tr of transactions) mapping.appendMapping(tr.mapping);
      const back = mapping.invert();
      const dropped = transactions.some((tr) => tr.getMeta('uiEvent') === 'drop');
      const moved = dropped && dropMoves;
      dropMoves = false;
      const fixes = [
        ...renewSharedIds(oldState.doc, newState.doc, back, stamp, dropped && !moved),
        ...stampNewLines(oldState.doc, newState.doc, back, stamp, dropped ? (moved ? 'moved' : 'copied') : null),
      ];
      if (fixes.length === 0) return null;
      const fix = newState.tr;
      for (const { pos, attrs } of fixes) fix.setNodeMarkup(pos, undefined, attrs);
      return fix;
    },
  });
}

interface Line {
  pos: number;
  node: PMNode;
}

function linesIn(doc: PMNode): Line[] {
  const lines: Line[] = [];
  doc.descendants((node, pos) => {
    if (!isLine(node.type.name)) return true;
    lines.push({ pos, node });
    return false;
  });
  return lines;
}

/**
 * Of lines sharing an id, the first whose content maps back to an old line
 * keeps it, else the first holding content, else the first. Every other one
 * gets a new id and time, or none when it is no longer To Do; after a drop
 * that `copied`, it gets a new id and keeps its time, as a pasted line does.
 */
function renewSharedIds(oldDoc: PMNode, doc: PMNode, back: Mapping, stamp: TodoLineStamp, copied: boolean): Array<{ pos: number; attrs: Attrs }> {
  const byId = new Map<string, Line[]>();
  for (const line of linesIn(doc)) {
    const id = line.node.attrs.lineId;
    if (typeof id !== 'string') continue;
    byId.set(id, [...(byId.get(id) ?? []), line]);
  }
  const fixes: Array<{ pos: number; attrs: Attrs }> = [];
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    const keeper =
      group.find((line) => originOf(oldDoc, back, line)?.byContent === true) ?? group.find((line) => line.node.content.size > 0) ?? group[0];
    for (const { pos, node } of group) {
      if (node === keeper?.node && pos === keeper.pos) continue;
      const cleared = { ...node.attrs, lineId: null, taggedAt: null };
      const attrs = copied ? copyTodoLine(node.attrs, stamp) : node.attrs.tag === 'todo' ? tagTodoLine(cleared, stamp) : cleared;
      fixes.push({ pos, attrs });
    }
  }
  return fixes;
}

/**
 * Stamps each To Do line with no id that is not the same line as an
 * unstamped To Do line before the change. A line is the same line as the old
 * one its first content maps back into, else the old one its start maps back
 * to; when a split leaves two lines claiming one old line, the one holding
 * its content is it and the other is new. After a drop, a line traced to no
 * old line is the dropped one: a moved line keeps no id, and a copied one
 * gets an id and keeps no time, as a pasted one does.
 */
function stampNewLines(
  oldDoc: PMNode,
  doc: PMNode,
  back: Mapping,
  stamp: TodoLineStamp,
  drop: 'moved' | 'copied' | null,
): Array<{ pos: number; attrs: Attrs }> {
  const unstamped = linesIn(doc).filter(({ node }) => node.attrs.tag === 'todo' && typeof node.attrs.lineId !== 'string');
  const traced = unstamped.map((line) => ({ line, origin: originOf(oldDoc, back, line) }));
  traced.sort((a, b) => Number(b.origin?.byContent ?? false) - Number(a.origin?.byContent ?? false) || a.line.pos - b.line.pos);
  const claimed = new Set<number>();
  const fixes: Array<{ pos: number; attrs: Attrs }> = [];
  for (const { line, origin } of traced) {
    if (origin === null && drop === 'moved') continue;
    if (origin === null && drop === 'copied') {
      fixes.push({ pos: line.pos, attrs: copyTodoLine(line.node.attrs, stamp) });
      continue;
    }
    const old = origin === null ? null : oldDoc.nodeAt(origin.at);
    if (origin !== null && !claimed.has(origin.at) && old !== null && old.attrs.tag === 'todo' && typeof old.attrs.lineId !== 'string') {
      claimed.add(origin.at);
      continue;
    }
    fixes.push({ pos: line.pos, attrs: tagTodoLine(line.node.attrs, stamp) });
  }
  return fixes;
}

/** The start of the old line a line came from, and whether its content says so; null for a line the change made. */
function originOf(oldDoc: PMNode, back: Mapping, { pos, node }: Line): { at: number; byContent: boolean } | null {
  if (node.content.size > 0) {
    const inside = back.mapResult(pos + 1, 1);
    if (!inside.deleted) {
      const $old = oldDoc.resolve(inside.pos);
      if ($old.depth > 0 && isLine($old.parent.type.name)) return { at: $old.before(), byContent: true };
    }
  }
  for (const assoc of [1, -1]) {
    const start = back.mapResult(pos, assoc);
    if (!start.deleted && isLine(oldDoc.nodeAt(start.pos)?.type.name)) return { at: start.pos, byContent: false };
  }
  return null;
}
