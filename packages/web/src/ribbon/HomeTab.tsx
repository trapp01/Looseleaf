/** The Home tab: clipboard, font, paragraph, styles and tags, laid out as in OneNote, then the board. */
import {
  BoardRegular,
  BookOpenFilled,
  CheckboxCheckedRegular,
  ClipboardPasteRegular,
  CopyRegular,
  CutRegular,
  FlagFilled,
  HighlightRegular,
  MicRegular,
  PaintBrushRegular,
  QuestionCircleFilled,
  StarFilled,
  TagDismissRegular,
  TextAlignCenterRegular,
  TextAlignLeftRegular,
  TextAlignRightRegular,
  TextBoldRegular,
  TextBulletListLtrRegular,
  TextClearFormattingRegular,
  TextColorRegular,
  TextIndentDecreaseLtrRegular,
  TextIndentIncreaseLtrRegular,
  TextItalicRegular,
  TextNumberListLtrRegular,
  TextStrikethroughRegular,
  TextSubscriptRegular,
  TextSuperscriptRegular,
  TextUnderlineRegular,
} from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import { useServices } from '../app/services.js';
import { useCurrentBoard } from '../board/live-board.js';
import { currentStyle, type CommandId } from '../commands/command-table.js';
import { useEditorState } from './Ribbon.js';
import { DEFAULT_FONT, DEFAULT_FONT_SIZE, FONT_SIZES, FONTS } from './fonts.js';
import { Cmd, ColorGrid, FONT_COLORS, Group, HIGHLIGHT_COLORS, MenuButton, Row, Rows, Unavailable } from './parts.js';

export const STYLE_COMMANDS: Array<{ id: CommandId; label: string; className: string }> = [
  { id: 'style-h1', label: 'Heading 1', className: 'style-h1' },
  { id: 'style-h2', label: 'Heading 2', className: 'style-h2' },
  { id: 'style-h3', label: 'Heading 3', className: 'style-h3' },
  { id: 'style-h4', label: 'Heading 4', className: 'style-h4' },
  { id: 'style-h5', label: 'Heading 5', className: 'style-h5' },
  { id: 'style-h6', label: 'Heading 6', className: 'style-h6' },
  { id: 'style-citation', label: 'Citation', className: 'style-citation' },
  { id: 'style-quote', label: 'Quote', className: 'style-quote' },
  { id: 'style-code', label: 'Code', className: 'style-code' },
  { id: 'style-normal', label: 'Normal', className: 'style-normal' },
];

export const TAG_COMMANDS: Array<{ id: CommandId; icon: ReactNode }> = [
  { id: 'tag-todo', icon: <CheckboxCheckedRegular className="tag-icon todo" /> },
  { id: 'tag-important', icon: <StarFilled className="tag-icon important" /> },
  { id: 'tag-question', icon: <QuestionCircleFilled className="tag-icon question" /> },
  { id: 'tag-remember', icon: <FlagFilled className="tag-icon remember" /> },
  { id: 'tag-definition', icon: <BookOpenFilled className="tag-icon definition" /> },
  { id: 'tag-remove', icon: <TagDismissRegular /> },
];

export function HomeTab() {
  const { commands } = useServices();
  const editor = useEditorState();
  const hasEditor = commands.isEnabled('bold');
  const style = editor ? currentStyle(editor) : 'normal';
  const textStyle = editor?.getAttributes('textStyle') ?? {};
  const font = (textStyle.fontFamily as string | undefined) ?? DEFAULT_FONT;
  const size = (textStyle.fontSize as number | undefined) ?? DEFAULT_FONT_SIZE;
  const fonts = FONTS.some((f) => f.value === font) ? FONTS : [...FONTS, { value: font, label: font }];
  const sizes = FONT_SIZES.includes(size) ? FONT_SIZES : [...FONT_SIZES, size].sort((a, b) => a - b);

  return (
    <div className="ribbon-groups">
      <Group label="Clipboard">
        <Cmd id="paste" icon={<ClipboardPasteRegular />} large />
        <Rows>
          <Row>
            <Cmd id="cut" icon={<CutRegular />} />
            <Unavailable icon={<PaintBrushRegular />} label="Copy format" />
          </Row>
          <Row>
            <Cmd id="copy" icon={<CopyRegular />} />
            <Cmd id="paste-text" icon={<ClipboardPasteRegular />} />
          </Row>
        </Rows>
      </Group>
      <Group label="Font">
        <Rows>
          <Row>
            <select
              className="ribbon-select font-family"
              aria-label="Font"
              title="Font"
              disabled={!hasEditor}
              value={font}
              style={{ fontFamily: font }}
              onChange={(e) => commands.run('font-family', e.target.value === DEFAULT_FONT ? null : e.target.value)}
            >
              {fonts.map((f) => (
                <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              className="ribbon-select font-size"
              aria-label="Font size"
              title="Font size"
              disabled={!hasEditor}
              value={size}
              onChange={(e) => commands.run('font-size', Number(e.target.value) === DEFAULT_FONT_SIZE ? null : Number(e.target.value))}
            >
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Row>
          <Row>
            <Cmd id="bold" icon={<TextBoldRegular />} />
            <Cmd id="italic" icon={<TextItalicRegular />} />
            <Cmd id="underline" icon={<TextUnderlineRegular />} />
            <Cmd id="strike" icon={<TextStrikethroughRegular />} />
            <Cmd id="subscript" icon={<TextSubscriptRegular />} />
            <Cmd id="superscript" icon={<TextSuperscriptRegular />} />
            <MenuButton icon={<HighlightRegular />} label="Highlight colour" disabled={!hasEditor} active={commands.isActive('highlight')}>
              {(close) => <ColorGrid colors={HIGHLIGHT_COLORS} noneLabel="No highlight" onPick={(c) => (close(), commands.run('highlight', c))} />}
            </MenuButton>
            <MenuButton icon={<TextColorRegular />} label="Font colour" disabled={!hasEditor}>
              {(close) => <ColorGrid colors={FONT_COLORS} noneLabel="Automatic" onPick={(c) => (close(), commands.run('font-color', c))} />}
            </MenuButton>
            <Cmd id="clear-formatting" icon={<TextClearFormattingRegular />} />
          </Row>
        </Rows>
      </Group>
      <Group label="Paragraph">
        <Rows>
          <Row>
            <Cmd id="bullet-list" icon={<TextBulletListLtrRegular />} />
            <Cmd id="ordered-list" icon={<TextNumberListLtrRegular />} />
            <Cmd id="outdent" icon={<TextIndentDecreaseLtrRegular />} />
            <Cmd id="indent" icon={<TextIndentIncreaseLtrRegular />} />
          </Row>
          <Row>
            <Cmd id="align" arg="left" label="Align left" icon={<TextAlignLeftRegular />} />
            <Cmd id="align" arg="center" label="Centre" icon={<TextAlignCenterRegular />} />
            <Cmd id="align" arg="right" label="Align right" icon={<TextAlignRightRegular />} />
          </Row>
        </Rows>
      </Group>
      <Group label="Styles" className="gallery-group">
        <div className="gallery styles-gallery" role="listbox" aria-label="Styles">
          {STYLE_COMMANDS.slice(0, 3).map((s) => (
            <GalleryItem key={s.id} id={s.id} label={s.label} className={s.className} selected={commands.isActive(s.id)} />
          ))}
          <GalleryItem id="style-normal" label="Normal" className="style-normal" selected={style === 'normal' && hasEditor} />
        </div>
        <MenuButton icon={<span className="gallery-more-label">More</span>} label="All styles" disabled={!hasEditor} testId="styles-menu">
          {(close) => (
            <div className="menu-list styles-menu">
              {STYLE_COMMANDS.map((s) => (
                <button
                  key={s.id}
                  className={`menu-item ${s.className} ${commands.isActive(s.id) ? 'is-selected' : ''}`}
                  onClick={() => (close(), commands.run(s.id))}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </MenuButton>
      </Group>
      <Group label="Tags" className="gallery-group">
        <div className="gallery tags-gallery" role="listbox" aria-label="Tags">
          {TAG_COMMANDS.map((t) => (
            <GalleryItem
              key={t.id}
              id={t.id}
              label={commands.get(t.id).label}
              icon={t.icon}
              selected={t.id !== 'tag-remove' && commands.isActive(t.id)}
            />
          ))}
        </div>
      </Group>
      <Group label="Voice">
        <Unavailable icon={<MicRegular />} label="Dictate" large />
      </Group>
      <BoardGroup />
    </div>
  );
}

/** "Put on board" for the open page; it re-renders as the board changes, so it disables once the page is a card. */
function BoardGroup() {
  useCurrentBoard();
  return (
    <Group label="Board">
      <Cmd id="put-on-board" icon={<BoardRegular />} large />
    </Group>
  );
}

function GalleryItem({ id, label, className = '', icon, selected }: { id: CommandId; label: string; className?: string; icon?: ReactNode; selected: boolean }) {
  const { commands } = useServices();
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`gallery-item ${className} ${selected ? 'is-selected' : ''}`}
      disabled={!commands.isEnabled(id)}
      title={commands.tooltip(id)}
      data-command={id}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => commands.run(id)}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
