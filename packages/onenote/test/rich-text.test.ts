import { describe, expect, it } from 'vitest';
import { PropertyId as P } from '../src/property-ids.js';
import {
  buildRuns,
  classifyNoteTag,
  colorRefToHex,
  parseHyperlinkField,
  splitRuns,
  type ContentContext,
} from '../src/rich-text.js';
import { data, flag, props } from './objects.js';


function context(): ContentContext & { warnings: string[] } {
  const warnings: string[] = [];
  return { object: () => undefined, warn: (m) => warnings.push(m), warnings };
}

describe('splitRuns', () => {
  it('splits at TextRunIndex positions, the last run ending at the end of the text', () => {
    // The [MS-ONE] 3.1 example: "Text with formatting" with CPs {5, 9}.
    const runs = splitRuns('Text with formatting', [5, 9], []);
    expect(runs.map((r) => r.text)).toEqual(['Text ', 'with', ' formatting']);
  });

  it('clamps positions so a bad index never drops or repeats text', () => {
    expect(splitRuns('abc', [5, 2], []).map((r) => r.text)).toEqual(['abc', '', '']);
    expect(splitRuns('abc', [], []).map((r) => r.text)).toEqual(['abc']);
  });
});

describe('hyperlinks', () => {
  it('parses the HYPERLINK field instruction and leaves any display text', () => {
    expect(parseHyperlinkField('﷟HYPERLINK "https://example.org/a b"')).toEqual({ url: 'https://example.org/a b', rest: '' });
    expect(parseHyperlinkField('﷟HYPERLINK https://example.org shown')).toEqual({ url: 'https://example.org', rest: 'shown' });
    expect(parseHyperlinkField('﷟PAGE 3')).toBeUndefined();
  });

  it('applies a field link to the display runs that follow and drops the hidden instruction', () => {
    const hidden = props([flag(P.Hyperlink), flag(P.HyperlinkProtected), flag(P.Hidden)]);
    const shown = props([flag(P.Hyperlink), flag(P.HyperlinkProtected)]);
    const runs = buildRuns(
      [
        { text: 'See ', format: undefined },
        { text: '﷟HYPERLINK "https://example.org/"', format: hidden },
        { text: 'the site', format: shown },
        { text: ' now', format: undefined },
      ],
      context(),
    );
    expect(runs).toEqual([{ text: 'See ' }, { text: 'the site', link: 'https://example.org/' }, { text: ' now' }]);
  });

  it('links a marked run to its own text when that text is a URL', () => {
    const link = props([flag(P.Hyperlink)]);
    const runs = buildRuns([{ text: 'https://example.org', format: link }, { text: ' and www.example.com', format: undefined }], context());
    expect(runs[0]).toEqual({ text: 'https://example.org', link: 'https://example.org' });
    expect(buildRuns([{ text: 'www.example.com', format: link }], context())[0]!.link).toBe('http://www.example.com');
    expect(buildRuns([{ text: 'not a url', format: link }], context())[0]!.link).toBeUndefined();
  });

  it('warns about other field codes', () => {
    const ctx = context();
    expect(buildRuns([{ text: '﷟DATE', format: undefined }], ctx)).toEqual([]);
    expect(ctx.warnings).toEqual(['A field code other than a link was dropped']);
  });
});

describe('run formatting', () => {
  it('maps every formatting property, font sizes from half-points', () => {
    const format = props([
      flag(P.Bold),
      flag(P.Italic),
      flag(P.Underline),
      flag(P.Strikethrough),
      flag(P.Superscript),
      [P.Font, { kind: 'bytes', value: Uint8Array.from([0x41, 0, 0x72, 0, 0x69, 0, 0x61, 0, 0x6c, 0, 0, 0]) }],
      [P.FontSize, { kind: 'bytes', value: Uint8Array.from([21, 0]) }],
      [P.FontColor, { kind: 'bytes', value: Uint8Array.from([0x11, 0x22, 0x33, 0x00]) }],
      [P.Highlight, { kind: 'bytes', value: Uint8Array.from([0x00, 0x00, 0x00, 0xff]) }],
    ]);
    expect(buildRuns([{ text: 'x', format }], context())).toEqual([
      { text: 'x', bold: true, italic: true, underline: true, strike: true, superscript: true, fontFamily: 'Arial', fontSize: 10.5, color: '#112233' },
    ]);
  });

  it('drops black text colour and white highlight, keeping every other colour', () => {
    const colours = (color: number[], highlight: number[]) =>
      buildRuns([{ text: 'x', format: props([data(P.FontColor, color), data(P.Highlight, highlight)]) }], context())[0];
    expect(colours([0, 0, 0, 0], [0xff, 0xff, 0xff, 0])).toEqual({ text: 'x' });
    expect(colours([0, 0, 0, 0xff], [0xfe, 0xff, 0xff, 0])).toEqual({ text: 'x', highlight: '#feffff' });
    expect(colours([1, 0, 0, 0], [0xff, 0xff, 0, 0])).toEqual({ text: 'x', color: '#010000', highlight: '#ffff00' });
  });

  it('merges neighbours with the same formatting and turns soft breaks into newlines', () => {
    const bold = props([flag(P.Bold)]);
    const runs = buildRuns(
      [
        { text: 'a', format: bold },
        { text: 'b\u000bc', format: props([flag(P.Bold)]) },
        { text: 'd', format: undefined },
      ],
      context(),
    );
    expect(runs).toEqual([{ text: 'ab\nc', bold: true }, { text: 'd' }]);
  });

  it('drops embedded-object placeholders with a warning and flags equations', () => {
    const ctx = context();
    const runs = buildRuns(
      [
        { text: '￼', format: props([flag(P.TextRunIsEmbeddedObject)]) },
        { text: 'x²', format: props([flag(P.MathFormatting)]) },
      ],
      ctx,
    );
    expect(runs).toEqual([{ text: 'x²' }]);
    expect(ctx.warnings).toEqual(['An object embedded in text was not imported', 'Equation imported as plain text']);
  });
});

describe('colours and tags', () => {
  it('reads COLORREF as 0x00bbggrr and treats the automatic colour as none', () => {
    expect(colorRefToHex(0x00336699)).toBe('#996633');
    expect(colorRefToHex(0xff000000)).toBeUndefined();
    expect(colorRefToHex(undefined)).toBeUndefined();
  });

  it('classifies tags by task state, shape, then English default label', () => {
    expect(classifyNoteTag(undefined, undefined, true)).toBe('todo');
    expect(classifyNoteTag(3, 'Anything', false)).toBe('todo');
    expect(classifyNoteTag(13, undefined, false)).toBe('important');
    expect(classifyNoteTag(15, undefined, false)).toBe('question');
    expect(classifyNoteTag(0, 'Remember for later', false)).toBe('remember');
    expect(classifyNoteTag(0, 'Definition', false)).toBe('definition');
    expect(classifyNoteTag(21, 'Idea', false)).toBeUndefined();
  });
});
