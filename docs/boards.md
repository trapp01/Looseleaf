# Boards

How a notebook's board is stored, read and changed: the board doc, card
links, To Do lines and the Inbox, the changes that span docs, card numbers and
board keys, the board tools' reads and repairs, and the one-time import of a
Corkboard board. Words in **bold** are defined in [glossary.md](glossary.md);
the rest of the system is in [architecture.md](architecture.md).

## The board doc

`board:<notebookId>` holds a notebook's board. A notebook has a board when
this doc's `meta` has a key. Nothing in the library or the notebook doc says
so; a board is found from its notebook.

- `doc.getMap('meta')`: `key: string` (the **board key**), `createdAt: number`
  (epoch ms; only To Do lines tagged after it reach the Inbox),
  `unfiledSection: string | null` (the Unfiled section's id once it is in use)
- `doc.getMap('statuses')` and `doc.getMap('cards')`: one entry per field,
  not a map per status or card, so that a status or card made on two replicas
  apart merges field by field:
  - `<id>/made/<field>`: a value the status or card was made with. Every
    replica that makes it writes these.
  - `<id>/<field>`: a later change to the field. It outweighs the made value,
    so a change made on one replica survives the other replica making the
    same status or card.
  - `<pageId>/label/<labelId>` → `true`, `<pageId>/comment/<commentId>` →
    `{ body, by, at, editedAt }`, `<pageId>/link/<linkId>` →
    `{ target, title, at }`: one entry each, so those added on either replica
    all survive. Comments and links are replaced whole when edited.
  - `<pageId>/deletedComment/<commentId>` → `true`: a deleted comment. Its
    text is removed and the mark keeps it deleted when another replica edits
    it at the same time; `clearDeletedComments`, which servers run after every
    board change they store, removes the text such an edit brings back.
- A status's fields: `name`, `kind: 'todo' | 'doing' | 'done'` and `order`
  (made and changed), `archivedAt` (changed only). A new board's five default
  statuses have ids derived from the notebook id (`<notebookId>-status-1` …),
  so two replicas that make the board apart end with one set.
- A card is keyed by its page's id. Its fields: `number` (the number in the
  **card ref**), `status` (a status id), `order` (its place in its status),
  `due` (a calendar day, `YYYY-MM-DD`), `createdAt`, `createdBy` and
  `updatedAt` are made; `number` (the servers' renumbering), `status`,
  `order`, `due`, `updatedAt` and `archivedAt` are changed. An empty due day
  or archived time is not written when a card is made.
- `doc.getMap('labels')`: labelId → `Y.Map` with `name`, `color` (one of the
  label colour names in `model/src/board/colors.ts`, a palette separate from
  section colours), `order`, `section: string | null` (the **label tie**). A
  label always gets a new id, so two replicas never make the same one.
- `doc.getArray('activity')`: every card's history in one array, entries
  `{ card, type, at, by, … }` where `card` is the page id, oldest first within
  a card.

Ids on a board hold no `/`. Where two replicas change the same field before
they sync, one of the two values wins, the same on every replica. A card
made on two replicas apart has both replicas' `created` entries. The links a
card is made with (the link back from a card made from a line) take ids from
their place (`first-1`, …), so such a card has each of them once. A board of a
few hundred cards is a few thousand entries, which `readBoard` reads in one
pass.

A card holds no title, text, checklist or attachments: the title is the
page's node name in `nb:<notebookId>`, the text and attachments are the page,
and the checklist is the page's To Do lines. A card whose status is archived
is hidden with it and comes back when the status is restored. A card whose
status this replica has never seen shows under the board's first status.

`readBoard` in `model` takes the board doc and the notebook doc and returns
plain objects (a `BoardSnapshot`); the web client, the search and the
Markdown renderers work from that and never touch the Yjs types. A card
whose page the notebook shows (live, in a live section) is in `cards` with
the page's title and section. A card whose page is deleted, gone or not in
the notebook is in `hiddenCards` and shows again when its page is restored.
Archiving a card takes it off the board and leaves the page where it is.

## Card links

A card link (`cardLink` in the rich-text schema) has no text of its own. The
editor shows the card's page title, ref and status and follows all three as
they change; a link to an archived card shows as archived and still opens the
page. The exports write it as a link to the desktop app's page address
(`looseleaf://page/<id>`) showing the page title, or "Linked card" when the
export does not know the page. The mirror writes the title the page had when
the linking page was last rendered.

## To Do lines

`model/src/todo-line-ids.ts` holds the one rule for a line's id and time,
used by the editor (through a ProseMirror plugin in the extension list) and
by the Markdown importer:

- Tagging a paragraph or heading To Do gives it a `lineId` and a `taggedAt`
  time. Removing the tag clears neither, so tagging it again keeps both.
- When an edit leaves two lines sharing an id (Enter or a split copies it),
  the one holding the old line's content keeps the id and time and the other
  gets new ones, so Enter at the start of a line leaves the text with its id.
  A copy, pasted or dragged with the copy modifier, gets a new id and keeps
  its tagged-at time and its Inbox choice. A line dragged to another place in
  the same text container keeps its id and time.
- `markdownToBody` stamps every task item it makes, so lines an agent adds
  through MCP are new lines. The OneNote import leaves both empty, so
  imported lines never reach the Inbox. A To Do line with no id keeps none
  through any edit while it is the same line (typing, ticking, Enter,
  joining, lists, headings); only removing its tag and putting it back gives
  it one. A To Do line the edit made, such as the new half of a split, gets
  one.
- Changes that arrive through Yjs (another replica, undo, the first load) are
  never stamped, so two replicas never give one line two ids.

`model/src/todo-lines.ts` reads and changes lines in a page doc:
`listTodoLines` is the one reader of a page's lines, in reading order;
ticking, "Keep it as a line", adding a line and turning a line into a card
link are attribute writes on the line's element, so they merge with typing in
the same line elsewhere. Turning a line into a card link replaces its content
with the link and clears its tag, tick, id, tagged-at time and Inbox choice,
so the paragraph is no longer a To Do line in any way; tagged again, it is a
new line with a new id. A line holding nothing but card links is never a To
Do line, whatever its tag. Code outside the editor changes lines through
`changeTodoLines`, which leaves the page's node modified, since clients read
a page's lines again only when its modified time changes.

The **Inbox** and the checklist counts come from an index of To Do lines per
page. The web client's background search pass (`web/src/search`) and the
server (`server/src/todo-line-index.ts`) each keep one, filled from
`listTodoLines` as page docs change. The server reads every page into it in
the background at start, from its store rather than through the hub; a
stored change marks the page, and marked pages are read again before the
index is next read, so a stored change costs a set insert and a board read
never sees a page older than the store. The Inbox is never stored:
`inboxLines` works it out from the board's `createdAt`, the index, the pages
that are cards (`cardPageIds`) and the notebook's live pages (`livePages`).

## Changes that span docs

Adding a card from a title, labelling a card and turning a To Do line into a
card each change more than one doc. They live in `model/src/board`
(`filing.ts`, `promote.ts`) and take a `DocAccess`, whose one method,
`withDoc(docId, change)`, runs a change on one doc in one transaction; the
server's `Hub.withDoc` has that shape and the web client wraps its replica
the same way (`web/src/board/doc-access.ts`), with a transaction origin a
page's undo history does not track, so undo on a page never takes back half
of such a change. Each step can run twice without harm, so a step that fails
part way is safe to repeat.

- **Adding a card** makes a page in the section tied to the card's first
  label (in label order) whose section is live, or in the **Unfiled
  section**, then puts it on the board. The Unfiled section's id is
  `<notebookId>-unfiled`, made at the end of the notebook the first time it is
  needed and brought back if it is in Deleted notes; two replicas that make
  it apart end with one.
- **Labelling a card** moves its page once: when the page is in the Unfiled
  section and the label is the card's first with a live tie. A page anywhere
  else is never moved by a label.
- **Turning a line into a card** makes a page whose id is the line's id and
  whose title is the line's text, files it in the Unfiled section, puts it on
  the board in the chosen status with a link back to the source page, and
  replaces the line with a card link. Two replicas that promote the same line
  apart make the same page and card ids, so they end with one card holding
  what each put on it; each adds a card link to the line, and
  `removeDuplicateCardLinks`, which servers run on every page change they
  store, keeps the first.

## Card numbers and board keys

A new card takes one past the highest number on its board, on whichever
replica makes it. Two replicas that are apart can therefore give two cards the
same number, and two boards the same key. Any replica assigns; only servers
repair (`renumberDuplicateCards` on a board doc after every change it stores
and on every board doc at start, and `boardKeyRepairs` with `setBoardKey`
across all board docs, deleted notebooks' included): the card or
board created first keeps its number or key, the others get new ones, and a
number or key only one card or board uses is never changed. The repair is the
same calculation on every server.

A card's ref can therefore change once, when a card made on a replica that
was apart meets a card with the same number. Its page id never changes;
`get_card` prints it and every MCP tool that names a card takes it in place
of a ref.

## Board tools

The MCP board tools (listed in [architecture.md](architecture.md#mcp-endpoint))
find boards and cards through `server/src/boards.ts` and change docs only
through `Hub.withDoc` (the cross-doc writers take the hub as their
`DocAccess`), so an agent's change travels like a client's and shows in every
open client at once. They read docs, not the mirror: a card's page is
rendered from its doc by the Markdown export, its checklist is read from the
page doc, and the Inbox and the checklist counts on `get_board` come from the
server's To Do line index. A name that fits several boards, statuses or
labels is answered with the matches and their ids, never with the first.
`create_card` with a line takes only a line in the board's Inbox, and
otherwise says why the line is not there.

The same `boards.ts` runs the repairs: the hub reports each stored doc to it
as it does to the mirror, and a repair is an ordinary `withDoc` change. Card
numbers, board keys and deleted comments are checked for a board doc, card
links for a page doc.

## Importing a Corkboard board

Corkboard is a separate kanban app built on the same storage and sync. Its
boards move into notebooks once, with `server.js import-corkboard` (the steps
and arguments are in `packages/server/README.md`). A real run needs both
servers stopped: the Looseleaf server because the import writes its data
folder behind its back, and the Corkboard server because a compaction while
the import reads can hide its most recent changes. Every device syncs first
and is then closed, or left alone, until the Looseleaf server is back. The
command lives in `packages/server`:

- `data-folder-reader.ts` reads a data folder in the disk store's layout
  without writing to it, and refuses a doc the store would have to repair.
  The Corkboard folder is only ever read through it, and so is the Looseleaf
  folder until a real run writes.
- `corkboard-folder.ts` reads Corkboard's `workspace` and `board:<boardId>`
  docs into plain objects. Looseleaf does not depend on Corkboard's packages.
- `corkboard-import.ts` works out and makes every change on docs held in
  memory: which page each card becomes (the first `looseleaf:` link whose
  page is live in the notebook, unless several cards link to that page, else
  a new page with the card's id, filed by label tie or in the Unfiled
  section), and what is added to it. Imported text goes into one new text
  container and attachments into new containers; no container already on a
  page is written to, so a replica that deletes one while apart loses none of
  the import. Board fields are written as Corkboard stored them with
  `writeBoardRecord` and `writeCardRecord` in `model/src/board/records.ts`, so
  refs, comment and link ids and activity are unchanged and the start-up
  repairs find nothing to change.
- `corkboard-import-check.ts` compares Corkboard's board with the result,
  field by field and page by page, from the source and the docs before and
  after alone, never the plan; a total that differs is a difference too.
- `corkboard-import-command.ts` refuses what cannot be imported whole, then
  either stops (a dry run, checked in memory) or writes: it marks the data
  folder (`corkboard-import-marker.ts`), copies the blobs, stores one update
  per changed doc (pages, then the notebook, then the board) through a hub,
  reads the folder back from disk and checks it.

A run that stops part way leaves `corkboard-import.json` saying `started`;
the server will not start and no new import runs until the copy of the data
folder taken before it is restored. A new page's id is the Corkboard card's,
so a run also refuses a data folder that already holds a page or page doc
with an id it would make, whatever the marker says. The updates are
ordinary Yjs updates, so a replica that held the notebook before the import
merges them with its own edits when it next syncs.
