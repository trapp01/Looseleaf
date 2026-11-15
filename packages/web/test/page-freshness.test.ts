import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { addTextContainer, createPage, createSection, getNode } from '@looseleaf/model';
import { PageSession } from '../src/canvas/page-session.js';
import { followPageText } from '../src/search/follow-page-text.js';

function openPage() {
  const notebookDoc = new Y.Doc();
  const section = createSection(notebookDoc, { name: 'S', parent: null });
  const pageId = createPage(notebookDoc, { section, title: 'P', createdAt: 0, modifiedAt: 0 });
  return { notebookDoc, pageId, doc: new Y.Doc() };
}

const write = (doc: Y.Doc, text: string) =>
  addTextContainer(doc, { x: 0, y: 0, width: 100, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => vi.useRealTimers());

describe('PageSession modified time', () => {
  it('touches at the first edit and again when the minute ends after more edits', () => {
    const { notebookDoc, pageId, doc } = openPage();
    const session = new PageSession('nb', pageId, doc, notebookDoc);
    write(doc, 'first');
    expect(getNode(notebookDoc, pageId)!.modifiedAt).toBe(1_000_000);
    vi.advanceTimersByTime(20_000);
    write(doc, 'end of the burst');
    expect(getNode(notebookDoc, pageId)!.modifiedAt).toBe(1_000_000);
    vi.advanceTimersByTime(40_000);
    expect(getNode(notebookDoc, pageId)!.modifiedAt).toBe(1_060_000);
    session.destroy();
  });

  it('touches on close when an edit is still waiting for its minute', () => {
    const { notebookDoc, pageId, doc } = openPage();
    const session = new PageSession('nb', pageId, doc, notebookDoc);
    write(doc, 'first');
    vi.advanceTimersByTime(10_000);
    write(doc, 'second');
    session.destroy();
    expect(getNode(notebookDoc, pageId)!.modifiedAt).toBe(1_010_000);
    vi.advanceTimersByTime(60_000);
    expect(getNode(notebookDoc, pageId)!.modifiedAt).toBe(1_010_000);
  });
});

describe('followPageText', () => {
  it('hands text to search once typing pauses', () => {
    const { notebookDoc, pageId, doc } = openPage();
    const setPageText = vi.fn();
    const stop = followPageText(doc, notebookDoc, pageId, { setPageText }, 3000);
    write(doc, 'hello');
    vi.advanceTimersByTime(2999);
    expect(setPageText).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setPageText).toHaveBeenCalledWith(pageId, expect.stringContaining('hello'), expect.any(Number));
    stop();
    expect(setPageText).toHaveBeenCalledTimes(1);
  });

  it('writes the waiting text when the page closes before the pause ends', () => {
    const { notebookDoc, pageId, doc } = openPage();
    const setPageText = vi.fn();
    const stop = followPageText(doc, notebookDoc, pageId, { setPageText }, 3000);
    write(doc, 'typed just before closing');
    stop();
    expect(setPageText).toHaveBeenCalledTimes(1);
    expect(setPageText.mock.calls[0]![1]).toContain('typed just before closing');
    vi.advanceTimersByTime(5000);
    expect(setPageText).toHaveBeenCalledTimes(1);
  });
});
