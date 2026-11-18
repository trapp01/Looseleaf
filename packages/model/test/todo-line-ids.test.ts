import { describe, expect, it } from 'vitest';
import { extensions, getAttributesFromExtensions, type CommandProps } from '@tiptap/core';
import { joinBackward, setBlockType } from '@tiptap/pm/commands';
import { liftListItem, sinkListItem, wrapInList } from '@tiptap/pm/schema-list';
import { EditorState, TextSelection, type Command, type Transaction } from '@tiptap/pm/state';
import { Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';
import { copyTodoLine, importTree, listTodoLines, markdownToBody, pageDocId, readTree, notebookDocId, richTextExtensions, richTextSchema, stampTodoLines, tagTodoLine, todoLinePlugin, type JSONContent } from '../src/index.js';
import { MemoryReplica, fixedStamp } from './helpers.js';

function stateOf(content: JSONContent[], stamp = fixedStamp()): EditorState {
  return EditorState.create({
    schema: richTextSchema,
    doc: richTextSchema.nodeFromJSON({ type: 'doc', content }),
    plugins: [todoLinePlugin(stamp)],
  });
}

const line = (text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'paragraph',
  attrs,
  content: [{ type: 'text', text }],
});

/** Each block's text with its line attributes. */
function lines(state: EditorState): Array<[string, string | null, number | null]> {
  const found: Array<[string, string | null, number | null]> = [];
  state.doc.descendants((node) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
    found.push([node.textContent, node.attrs.lineId, node.attrs.taggedAt]);
    return false;
  });
  return found;
}

/** Applies a change the way a view dispatch does, appended transactions included. */
function apply(state: EditorState, change: (state: EditorState) => ReturnType<EditorState['tr']['setNodeMarkup']>): EditorState {
  return state.applyTransaction(change(state)).state;
}

describe('the To Do line rule', () => {
  it('gives a newly tagged line an id and a tagged-at time, and keeps both when it is tagged again', () => {
    const stamp = fixedStamp();
    const tagged = tagTodoLine({ tag: null, checked: false }, stamp);
    expect(tagged).toMatchObject({ tag: 'todo', lineId: 'line-1', taggedAt: 1000 });
    expect(tagTodoLine({ ...tagged, tag: null }, stamp)).toMatchObject({ lineId: 'line-1', taggedAt: 1000 });
    expect(copyTodoLine(tagged, stamp)).toMatchObject({ lineId: 'line-2', taggedAt: 1000 });
  });

  it('stamps every To Do line in a body and leaves other blocks alone', () => {
    const body = stampTodoLines({ type: 'doc', content: [line('a', { tag: 'todo' }), line('b'), line('c', { tag: 'important' })] }, fixedStamp());
    expect(body.content!.map((block) => block.attrs?.lineId ?? null)).toEqual(['line-1', null, null]);
  });

  it('stamps To Do lines that Markdown makes, with the stamp it is given', async () => {
    const { body } = await markdownToBody('- [ ] call the venue\n- [x] book a room\n\nplain', { stamp: fixedStamp() });
    expect(body.content!.map((block) => [block.attrs?.lineId ?? null, block.attrs?.taggedAt ?? null])).toEqual([
      ['line-1', 1000],
      ['line-2', 1001],
      [null, null],
    ]);
  });

  it('leaves the lines of an import tree without an id or a tagged-at time', async () => {
    const replica = new MemoryReplica();
    const { notebookId } = await importTree(
      {
        name: 'Imported',
        children: [{ kind: 'section', name: 'S', pages: [{ title: 'P', level: 0, containers: [{ kind: 'text', x: 0, y: 0, width: 300, blocks: [{ type: 'paragraph', tag: 'todo', runs: [{ text: 'old task' }] }] }], strokes: [], warnings: [] }] }],
      },
      replica,
    );
    const section = readTree(replica.doc(notebookDocId(notebookId))).children[0]!;
    const pageId = section.kind === 'section' ? section.pages[0]!.id : '';
    expect(listTodoLines(replica.doc(pageDocId(pageId)))).toEqual([{ id: null, text: 'old task', checked: false, taggedAt: null, inbox: true }]);
  });
});

describe('todoLinePlugin', () => {
  it('stamps a line when the To Do tag is put on it', () => {
    let state = stateOf([line('water the plants')]);
    state = apply(state, (s) => s.tr.setNodeMarkup(0, undefined, { ...s.doc.firstChild!.attrs, tag: 'todo' }));
    expect(lines(state)).toEqual([['water the plants', 'line-1', 1000]]);
  });

  it('leaves an imported To Do line without an id when it is ticked or typed in', () => {
    let state = stateOf([line('imported', { tag: 'todo' })]);
    state = apply(state, (s) => s.tr.setNodeMarkup(0, undefined, { ...s.doc.firstChild!.attrs, checked: true }));
    state = apply(state, (s) => s.tr.insertText('!', 9));
    expect(lines(state)).toEqual([['imported!', null, null]]);
  });

  it('gives the line made by Enter its own id', () => {
    let state = stateOf([line('first', { tag: 'todo', lineId: 'kept', taggedAt: 5 })]);
    state = apply(state, (s) => s.tr.split(6, 1, [{ type: richTextSchema.nodes.paragraph!, attrs: { tag: 'todo' } }]));
    expect(lines(state)).toEqual([
      ['first', 'kept', 5],
      ['', 'line-1', 1000],
    ]);
  });

  it('gives a new line under an imported To Do line an id', () => {
    let state = stateOf([line('imported', { tag: 'todo' })]);
    state = apply(state, (s) => s.tr.split(9, 1, [{ type: richTextSchema.nodes.paragraph!, attrs: { tag: 'todo' } }]));
    expect(lines(state)).toEqual([
      ['imported', null, null],
      ['', 'line-1', 1000],
    ]);
  });

  it('gives the second half of a line split in the middle a new id', () => {
    let state = stateOf([line('onetwo', { tag: 'todo', lineId: 'kept', taggedAt: 5 })]);
    state = apply(state, (s) => s.tr.split(4));
    expect(lines(state)).toEqual([
      ['one', 'kept', 5],
      ['two', 'line-1', 1000],
    ]);
  });

  it('gives pasted lines new ids and keeps their tagged-at time', () => {
    const state = stateOf([line('here')]);
    const plugin = state.plugins[0]!;
    const pasted = new Slice(
      richTextSchema.nodeFromJSON({ type: 'doc', content: [line('copied', { tag: 'todo', lineId: 'source', taggedAt: 5 }), line('old import', { tag: 'todo' })] }).content,
      0,
      0,
    );
    const result = plugin.props.transformPasted!.call(plugin, pasted, {} as EditorView, false);
    const attrs: Array<Record<string, unknown>> = [];
    result.content.forEach((node) => attrs.push(node.attrs));
    expect(attrs.map((a) => [a.lineId, a.taggedAt])).toEqual([
      ['line-1', 5],
      ['line-2', null],
    ]);
  });

  it('leaves changes that arrive from Yjs alone', () => {
    const state = stateOf([line('from another replica')]);
    const tr = state.tr.setNodeMarkup(0, undefined, { ...state.doc.firstChild!.attrs, tag: 'todo' });
    tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    expect(lines(state.applyTransaction(tr).state)).toEqual([['from another replica', null, null]]);
  });

  it('does nothing for a selection change', () => {
    const state = stateOf([line('still', { tag: 'todo' })]);
    const next = apply(state, (s) => s.tr.setSelection(TextSelection.create(s.doc, 3)));
    expect(lines(next)).toEqual([['still', null, null]]);
  });
});

/** TipTap's own Enter command, run without a view, with the attributes of the editor's extensions. */
const tiptapSplitBlock = (extensions.Commands.config.addCommands!.call({} as never) as { splitBlock: () => (props: CommandProps) => boolean }).splitBlock();
const tiptapEditor = { extensionManager: { attributes: getAttributesFromExtensions(richTextExtensions), splittableMarks: [] } };

const enter: Command = (state, dispatch) => {
  const tr = state.tr;
  if (!tiptapSplitBlock({ tr, state, dispatch, editor: tiptapEditor } as unknown as CommandProps)) return false;
  dispatch?.(tr);
  return true;
};

/** The heading command's change: the block keeps its attributes and becomes a heading. */
const toHeading: Command = (state, dispatch) => setBlockType(richTextSchema.nodes.heading!, { ...state.selection.$from.parent.attrs, level: 2 })(state, dispatch);
const bullets = wrapInList(richTextSchema.nodes.bulletList!);
const sink = sinkListItem(richTextSchema.nodes.listItem!);
const lift = liftListItem(richTextSchema.nodes.listItem!);

/** Selects from `pos` to `to` (a cursor when left out) and runs `command`, the way a key press or a ribbon button does. */
function run(state: EditorState, pos: number, command: Command, to = pos): EditorState {
  let next = state.applyTransaction(state.tr.setSelection(TextSelection.create(state.doc, pos, to))).state;
  let ran: Transaction | null = null;
  expect(command(next, (tr) => (ran = tr))).toBe(true);
  next = next.applyTransaction(ran!).state;
  return next;
}

/** The start of the text of the line holding `text`. */
function startOf(state: EditorState, text: string): number {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
    return found < 0;
  });
  return found;
}

describe('todoLinePlugin with the editor’s commands', () => {
  const stamped = () => stateOf([line('Call the plumber', { tag: 'todo', lineId: 'kept', taggedAt: 5 }), line('Fix the gate', { tag: 'todo', lineId: 'other', taggedAt: 6 })]);
  const imported = () => stateOf([line('Call the plumber', { tag: 'todo' }), line('Fix the gate', { tag: 'todo' })]);

  it('Enter at the start of a line keeps the text’s id and time and gives the empty line above new ones', () => {
    expect(lines(run(stamped(), 1, enter)).slice(0, 2)).toEqual([
      ['', 'line-1', 1000],
      ['Call the plumber', 'kept', 5],
    ]);
    expect(lines(run(imported(), 1, enter)).slice(0, 2)).toEqual([
      ['', 'line-1', 1000],
      ['Call the plumber', null, null],
    ]);
  });

  it('Enter in the middle or at the end gives the new line the new id', () => {
    expect(lines(run(stamped(), 5, enter)).slice(0, 2)).toEqual([
      ['Call', 'kept', 5],
      [' the plumber', 'line-1', 1000],
    ]);
    expect(lines(run(imported(), 5, enter)).slice(0, 2)).toEqual([
      ['Call', null, null],
      [' the plumber', 'line-1', 1000],
    ]);
    expect(lines(run(stamped(), 17, enter)).slice(0, 2)).toEqual([
      ['Call the plumber', 'kept', 5],
      ['', 'line-1', 1000],
    ]);
    expect(lines(run(imported(), 17, enter)).slice(0, 2)).toEqual([
      ['Call the plumber', null, null],
      ['', 'line-1', 1000],
    ]);
  });

  it('joining two lines keeps the first line’s id, or its lack of one', () => {
    expect(lines(run(stamped(), startOf(stamped(), 'Fix the gate'), joinBackward))).toEqual([['Call the plumberFix the gate', 'kept', 5]]);
    expect(lines(run(imported(), startOf(imported(), 'Fix the gate'), joinBackward))).toEqual([['Call the plumberFix the gate', null, null]]);
  });

  it('wrapping in a list, sinking, lifting and making a heading leave ids as they were', () => {
    for (const [make, expected] of [
      [stamped, [['Call the plumber', 'kept', 5], ['Fix the gate', 'other', 6]]],
      [imported, [['Call the plumber', null, null], ['Fix the gate', null, null]]],
    ] as const) {
      let state = run(make(), 1, bullets, make().doc.content.size - 1);
      state = run(state, startOf(state, 'Fix the gate'), sink);
      expect(state.doc.firstChild!.type.name).toBe('bulletList');
      expect(lines(state)).toEqual(expected);
      state = run(state, startOf(state, 'Fix the gate'), lift);
      state = run(state, startOf(state, 'Fix the gate'), lift);
      state = run(state, startOf(state, 'Call the plumber'), lift);
      expect(state.doc.firstChild!.type.name).toBe('paragraph');
      expect(lines(state)).toEqual(expected);
      state = run(state, startOf(state, 'Fix the gate'), toHeading);
      expect(state.doc.lastChild!.type.name).toBe('heading');
      expect(lines(state)).toEqual(expected);
    }
  });

  it('stamps an imported line once the person removes the tag and puts it back', () => {
    let state = imported();
    state = apply(state, (s) => s.tr.setNodeMarkup(0, undefined, { ...s.doc.firstChild!.attrs, tag: null }));
    state = apply(state, (s) => s.tr.setNodeMarkup(0, undefined, { ...s.doc.firstChild!.attrs, tag: 'todo' }));
    expect(lines(state)).toEqual([
      ['Call the plumber', 'line-1', 1000],
      ['Fix the gate', null, null],
    ]);
  });
});

/**
 * Drops the blocks between `from` and `to` at `at` through the hooks
 * ProseMirror's drop handler calls on a drag inside one editor, then deletes
 * the source when the drag moves and inserts the slice, as that handler does.
 */
function drop(state: EditorState, from: number, to: number, at: number, move: boolean): EditorState {
  const plugin = state.plugins[0]!;
  let slice = state.doc.slice(from, to);
  const view = { dragging: { slice, move } } as unknown as EditorView;
  slice = plugin.props.transformPasted!.call(plugin, slice, view, false);
  expect(plugin.props.handleDrop!.call(plugin, view, {} as never, slice, move)).toBe(false);
  const tr = state.tr;
  if (move) tr.delete(from, to);
  const pos = tr.mapping.map(at);
  tr.replaceRange(pos, pos, slice);
  return state.applyTransaction(tr.setMeta('uiEvent', 'drop')).state;
}

describe('todoLinePlugin with drag and drop', () => {
  const stamped = () => stateOf([line('Call the plumber', { tag: 'todo', lineId: 'kept', taggedAt: 5 }), line('Fix the gate', { tag: 'todo', lineId: 'other', taggedAt: 6 })]);
  const imported = () => stateOf([line('Call the plumber', { tag: 'todo' }), line('Fix the gate', { tag: 'todo' })]);
  const end = (state: EditorState) => state.doc.content.size;

  it('keeps a moved line’s id and time, or its lack of one', () => {
    expect(lines(drop(stamped(), 0, 18, end(stamped()), true))).toEqual([
      ['Fix the gate', 'other', 6],
      ['Call the plumber', 'kept', 5],
    ]);
    expect(lines(drop(imported(), 0, 18, end(imported()), true))).toEqual([
      ['Fix the gate', null, null],
      ['Call the plumber', null, null],
    ]);
  });

  it('gives a copy made by dragging a new id, below or above the line it copies', () => {
    expect(lines(drop(stamped(), 0, 18, end(stamped()), false))).toEqual([
      ['Call the plumber', 'kept', 5],
      ['Fix the gate', 'other', 6],
      ['Call the plumber', 'line-1', 5],
    ]);
    expect(lines(drop(stamped(), 18, end(stamped()), 0, false))).toEqual([
      ['Fix the gate', 'line-1', 6],
      ['Call the plumber', 'kept', 5],
      ['Fix the gate', 'other', 6],
    ]);
    expect(lines(drop(imported(), 0, 18, end(imported()), false))).toEqual([
      ['Call the plumber', null, null],
      ['Fix the gate', null, null],
      ['Call the plumber', 'line-1', null],
    ]);
  });

  it('renews lines dropped or pasted from another editor', () => {
    const state = stateOf([line('here')]);
    const plugin = state.plugins[0]!;
    const from = new Slice(richTextSchema.nodeFromJSON({ type: 'doc', content: [line('copied', { tag: 'todo', lineId: 'source', taggedAt: 5 })] }).content, 0, 0);
    const result = plugin.props.transformPasted!.call(plugin, from, { dragging: null } as unknown as EditorView, false);
    expect(result.content.firstChild!.attrs).toMatchObject({ lineId: 'line-1', taggedAt: 5 });
  });
});
