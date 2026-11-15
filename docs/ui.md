# User interface

The layout follows OneNote for Mac so that someone moving over finds every
control where they expect it. Sizes are CSS px at 100% zoom, measured from
OneNote 16.113 at a 1512 px wide window. Feature status is in
[onenote-parity.md](onenote-parity.md).

## Desktop layout (768 px and wider)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ↶ ↷            page title · notebook                    sync status  │  title bar, 36
│ Home  Insert  Draw  View                                             │  tab row, 28
│ ╭──────────────────────────────────────────────────────────────────╮ │
│ │ ribbon: groups of commands separated by hairlines                │ │  ribbon card, 72
│ ╰──────────────────────────────────────────────────────────────────╯ │
├────┬───────────────────────┬────────────────────┬────────────────────┤
│rail│ ▣ Notebook name ⌄     │              sort ⇅│  Page title        │
│ 48 │ ▍Section              │ Page               │  Sunday, 15 Nov…   │
│    │ ▍Section   (selected) │ Page    (selected) │                    │
│    │ ▸ Section group       │   Subpage          │  canvas            │
│    │                       │                    │                    │
│    │ Add section           │ Add page           │                    │
└────┴───────────────────────┴────────────────────┴────────────────────┘
       sections, 268            pages, 238           canvas, rest
```

- **Title bar**: undo and redo at the left, the page title centred, the sync
  status control at the right where OneNote has its cloud icon and Share.
- **Tab row**: the selected tab is semibold with a 2 px accent underline.
- **Ribbon**: one white card with 10 px corner radius and a soft shadow, 8 px
  from the window edges. Large commands are an icon over a label; small ones
  are icon-only in two rows. Groups are split by 1 px vertical hairlines. When
  the window is narrow the ribbon scrolls sideways; it never wraps.
- **Rail**: notebooks, search, recent pages from the top; settings at the
  bottom where OneNote has the account avatar. The selected item is accent
  coloured with a 3 px accent bar on its left edge.
- **Sections pane**: header shows a notebook glyph in the notebook's colour, its
  name and a chevron that opens the notebook list (switch, new, import, rename,
  delete). Rows are 36 px. Each section row starts with a 6 × 22 px rounded tab
  in the section's colour. Section groups show a disclosure triangle and indent
  their children 16 px. The selected row has a grey fill. "Add section" is
  pinned at the bottom in accent-coloured semibold text.
- **Pages pane**: rows are 36 px, subpages indent 16 px per level, the selected
  row has a grey fill, "Add page" is pinned at the bottom. The sort control
  sits at the top right.
- **Canvas**: the page title in 20 pt, a hairline under it, the created date
  and time in small grey text, then the freeform area. Rule lines and grid are
  drawn by the canvas background per the page's paper style.
- The dividers between panes can be dragged. Rows open a context menu on
  right-click and on long-press.

## Canvas behaviour

- Clicking empty canvas starts a text container at that point. A container left
  empty when focus leaves is removed.
- A focused or hovered container shows a thin grey frame with a drag bar on top
  (move) and a handle at the right edge (resize width). Height follows content.
- Tab and Shift-Tab indent and outdent a paragraph or list item. Inside a table
  Tab moves to the next cell and adds a row at the end.
- Pasting or dropping an image places it in the focused container, or as its own
  image container at the drop point.
- Draw tab: choosing pen, marker or highlighter puts the canvas in draw mode;
  pointer input adds strokes and text containers ignore the pointer. The eraser
  removes the stroke under the pointer. "Text mode" returns to typing.
- Zoom scales the canvas only, never the chrome.

## Phone layout (under 768 px)

OneNote for Mac has no phone layout; this follows OneNote's phone apps. One
pane shows at a time:

1. **Sections**: notebook switcher on top, section list, "Add section".
2. **Pages**: back arrow, section name, page list, "Add page".
3. **Page**: back arrow, page title, a more-actions button, the canvas, and a
   formatting bar docked above the on-screen keyboard with the most used Home
   commands (bold, italic, underline, bullets, numbering, to-do, indent,
   outdent, picture, undo). The other commands are in a sheet opened from the
   bar.

Touch targets are at least 44 px. Nothing depends on hover. Containers move by
dragging their top bar and the canvas scrolls with one finger in text mode.

## Look

- Accent colour is one CSS custom property; chrome is neutral grey and white,
  with a dark theme that follows the system setting.
- Icons are Fluent UI System Icons (MIT). Text is the system UI font. The
  default note font is Carlito (SIL OFL), which has the same metrics as
  Calibri, so imported notes keep their line breaks.
- No Microsoft artwork, logos or product names appear in the app.

## First run

- Opened from a server (`http://host:8421`): asks for the access token once,
  then syncs.
- Desktop app: "Connect to a server" (address and token, checked against
  `/api/info`) or "Keep notes on this device only". The choice can be changed
  in settings at any time; connecting later uploads everything already written.
- An empty library offers "New notebook" and "Import from OneNote".
