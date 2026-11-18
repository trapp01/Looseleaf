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

- **Title bar**: undo and redo at the left, the page title and notebook
  centred ("Board · notebook" in the board view while no page is open beside
  the board), the sync status control at the right where OneNote has its
  cloud icon and Share.
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

## Boards

A notebook can have one **board**. It lives inside the shell above: title
bar, tab row, ribbon and rail stay as they are, and the board takes the place
of the pages pane and canvas. Columns, card fronts, drag and drop, the
composer, the label filter, the archive and the flash on a change made
elsewhere behave as on a Trello-style board; [board-parity.md](board-parity.md)
lists what is built.

```
┌────┬───────────────────────┬──────────────────────────────────────────────┐
│rail│ ▣ Notebook name ⌄     │ Inbox      Backlog     In progress    Done   │
│    │ ▦ Board   (selected)  │ ┌───────┐  ┌───────┐   ┌───────┐             │
│    │ ▍Section              │ │ line  │  │HOME-3 │   │HOME-1 │             │
│    │ ▍Section              │ │ page  │  │ title │   │ title │             │
│    │ ▍Unfiled              │ └───────┘  └───────┘   └───────┘             │
└────┴───────────────────────┴──────────────────────────────────────────────┘
```

- **Sections pane**: a notebook with a board shows a "Board" row above its
  sections, the same height as a section row. The notebook menu gains "Add a
  board", which is disabled when the notebook has one.
- **Board view**: selecting "Board" replaces the pages pane and canvas with
  the board: the Inbox lane first, then the statuses side by side, scrolling
  sideways, and an "Add a status" tile after the last. A bar above them holds
  "Board" and the board key, the search box ("Search cards"), the label
  filter ("Filter"), and "Labels" and "Archived items", which open the
  board's labels (name, colour, label tie) and its archived statuses and
  cards. The search box keeps cards with every word in their title, page,
  labels, comments or links; while it or the label filter is on, a count of
  the cards showing and "Clear filter" sit beside it, and dragging is off.
  The board's backdrop is tinted with the notebook's colour. With no page
  open beside the board, the ribbon's page commands are off, as in the
  notebook view with no page open. A drag held near the board's left or
  right edge scrolls the statuses that way.
- **Status**: its header has the kind marker, the name (rename in place), the
  card count and a menu: Rename, Kind, Move left, Move right, Archive status.
  Under the header, "Add a card" opens the composer; Enter makes a new page
  with that title, files it (see the label tie and the Unfiled section in the
  glossary), puts it at the top of the status and keeps the composer open for
  the next.
- **Inbox lane**: To Do lines that are waiting to become cards, newest first,
  each with a tick box, its text, the title of its page and a menu ("Line
  actions"). It has a dashed outline and an inbox icon, so it does not read
  as a status, and no manual order and no composer. It stays at the board's
  left edge while the statuses scroll sideways under it (on a phone it is
  simply the first column). Ticking a line there
  ticks it on its page. The page title opens that page beside the board.
  Dragging a line into a status turns it into a card at the drop, between
  the cards it was let go between; nothing drops into the Inbox, and a line
  let go anywhere else stays a line. The menu is the line's menu (see "On
  the page"). An empty Inbox says "New To Do lines from this notebook's
  pages land here."
- **Card front**: ref, page title, labels, due day, the first lines of the
  page's text and the checklist count (ticked over total of the page's To Do
  lines), with counts of comments and links. The count follows a tick on
  the open page within a quarter second. Until the page has been read, a
  grey bar holds the place of its first line; the board's cards are read
  before the rest of the library.
  A ref never wraps, here or anywhere else. Its menu (right-click, or a long
  press where the browser makes one a context menu) has Open and Archive.
- **Card open, from the board**: clicking a card opens its page in a pane
  beside the board, and its card front is outlined. An Inbox line's page
  and a card link's page open in the same pane. It is the real canvas,
  fully editable, with the card strip under its title, and the ribbon acts on
  it. The page scrolls both ways as in the notebook view, and its title
  narrows to fit the pane. A bar above the page has "Open full page", which
  switches to the notebook view at that page, and a close button that gives
  the board its full width back; Escape does the same while the caret is not
  in the page.
- **Card strip**: a page that is a card shows one strip under its title, above
  the created date: ref, "Copy ref", status picker, labels, due day,
  checklist count, "Activity" (which shows or hides the Activity panel) and a
  menu with Archive. In the notebook view of a notebook with a board it ends
  with the "Board" toggle (see "Board beside a page"), which a page that is
  not a card shows alone in the strip's place. It wraps onto more rows when
  the page is narrow. It replaces a card back; there is no card modal.
- **Activity panel**: beside a card's page: links, then comments and activity
  together, oldest first, with the comment box at its foot. It starts closed
  on a card with no comments or links, and opens from the strip. It takes
  its width from the canvas, which still scrolls to the page's far edge;
  where the page and panel together have less than 640 px, it lies over the
  page's right side instead, until its close button is pressed.
- **Pages pane**: the row of a page that is a card shows its status after the
  title, in small grey text.
- **Board beside a page**: from the notebook view, the board can open as a
  pane to the right of the page being written: "Board beside page" on the
  View tab, or the "Board" toggle in the card strip's place. The pane has
  the board's bar with a close button, then the Inbox and the statuses, so a
  line is dragged from the Inbox onto a status without leaving the page.
  Opening a card from the pane shows its page in place of the one being
  written. The board takes half of what the nav panes leave until its
  divider is dragged; the divider drags like the other pane dividers, and
  the dragged width and whether the pane is open are kept per device.
- **On the page**: a To Do line that is in the Inbox shows an "Inbox" pill at
  its end, a moment after typing pauses. The line's menu (right-click,
  long-press, or the pill) has "Make it a card in" with the board's
  statuses, and "Keep it as a line", which takes it out of the Inbox for
  good and leaves it a To Do line. Lines on a card's own page show no pill.
- **Card link**: an inline chip showing the card's ref, title and status,
  following all three as they change. Clicking it opens the card's page:
  beside the board in the board view, otherwise in the notebook view. A
  link to an archived card shows "archived" and still opens the page; a
  link to a page that is not a card on the notebook's board shows the page
  title alone. It selects, deletes, copies and pastes like any inline item.
- **Keyboard**: with a board showing and the caret in no field or page, `n`
  adds a card to the status under the pointer (or the first), `/` focuses
  the search box, Enter opens and `c` archives the card under the pointer or
  in focus, and `?` lists these. Looseleaf's own shortcuts all take a
  modifier, so none of these meet them.
- **Put on board**: the Home tab's Board group, the page menu in the pages
  pane and the page's more-actions menu have "Put on board" for a page of a
  notebook with a board that is not a card. Archive, on the card front's menu
  and in the strip, is the one way off the board, and offers Undo.

On a phone (under 768 px) the drill-down gains the board: the sections list
shows the Board row; the board shows one column per screen, swiped sideways,
the Inbox first, with the next column's edge showing; a card, or an Inbox
line's page, opens full screen with the strip under the title, and the back
arrow returns to the board; the Activity panel opens as a sheet over the
bottom of the page from the strip. The line menu opens from the pill and
from a long press on the line. Nothing shows side by side, so there is no
board beside a page.

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
