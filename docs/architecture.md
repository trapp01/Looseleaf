# Architecture

Looseleaf is a local-first notebook app. Every device holds a full copy of the
notes and works offline. A self-hosted server is the hub the devices sync
through and the place backups live. Words in **bold** are defined in
[glossary.md](glossary.md).

## Packages

| Package | Owns | Refuses to know |
| --- | --- | --- |
| `packages/model` | What a library, notebook, page, container and board are; the rich-text schema; To Do lines and the rule for their ids; reading and writing all of them inside Yjs docs; a board and a card as Markdown; export to HTML, Markdown, text and JSON; planning a mirror; turning an import tree into docs and Markdown into rich text. A board is read and written through `model` only. | Networking, storage, the DOM, React. |
| `packages/sync` | The wire protocol, the replica store interface, and the client that keeps a replica in step with a server. | What is inside a doc. Doc ids and bytes are opaque. |
| `packages/server` | The hub: doc and blob storage on disk, the sync endpoint, snapshots, the mirror on disk, the board repairs and the To Do line index, the MCP endpoint, serving the web client; the one-time import of a Corkboard board. | What is inside a doc. Only `mirror.ts` (which reads docs for the mirror), `notes-writer.ts` (which reads and writes them for the MCP notes tools), `boards.ts` (which finds boards and cards, reads them for the board tools and runs the repairs), `todo-line-index.ts` (the line index), the board tool files (which make the board tools' changes with `model`'s writers) and the `corkboard-*` import files look inside one, and only through `model` (the import also reads Corkboard's own layout in `corkboard-folder.ts`); the hub changes a doc only through a callback it is handed. `mirror-folder.ts` knows a mirror folder on disk and nothing about the server. |
| `packages/onenote` | Reading Microsoft `.one` files into an import tree. | Yjs, storage, UI. |
| `packages/web` | The user interface. Runs in a browser, inside the desktop shell, and later inside a mobile shell. | Disk paths, Electron APIs (it talks to the shell through one small bridge). |
| `packages/desktop` | The Electron shell: window, native menus, PDF output, file dialogs, remembering the mirror folder the person chose and writing a mirror's files into it. | Notes. It hosts `packages/web` unchanged. |

Imports flow one way: `web → model, sync, onenote`; `server → sync, model`
(`model` from `mirror.ts`, `notes-writer.ts`, `boards.ts`,
`todo-line-index.ts`, the MCP tool files and the `corkboard-*` import files;
the hub and the store never read a doc);
`onenote → model` (types only); `desktop → server, model` (`mirror-folder.ts`
and `model`'s `mirror-manifest` only; otherwise it loads the built web client).
`model` and `sync` do not import each other. This is prose
until a lint rule lands; a violation is a review finding.

## Why CRDTs

Two devices can edit the same page while both are offline. Neither edit may be
lost when they reconnect. Looseleaf stores every doc as a
[Yjs](https://yjs.dev) CRDT: each edit is an operation that merges with any
other edit in any order and always converges to the same result. There is no
"last save wins" on a document. Two people typing in the same paragraph both
keep their text.

Where a single value is set twice at once (a container's x position, a section
name, a page title) the later writer wins for that one field. Nothing else on
the page is affected.

Deleting never destroys content. A deleted page or section gets `deletedAt` set
on its node and shows under Deleted notes. A page edited on one device and
deleted on another keeps the edits and is restorable.

## Docs

A **doc** is one Yjs document. Doc ids are strings:

| Doc id | Holds |
| --- | --- |
| `library` | The list of notebooks. |
| `nb:<notebookId>` | One notebook's tree of nodes: section groups, sections, page entries. |
| `pg:<pageId>` | One page's content: containers and strokes. |
| `board:<notebookId>` | A notebook's board: its key, statuses, labels and cards. Keyed by the notebook's id, so a notebook cannot end up with two boards. |

Ids are 21-character nanoid strings. A page doc is keyed by the page id alone,
so moving a page to another section or notebook never rewrites its content.
A few ids are derived instead, so that two replicas making the same thing
while apart make it once: see [boards.md](boards.md).

### `library`

`doc.getMap('notebooks')`: notebookId → `Y.Map` with

- `name: string`
- `color: string` (one of the notebook colour names in `model`)
- `order: string` (fractional index; see Ordering)
- `createdAt: number` (epoch ms)
- `deletedAt: number | null`

### `nb:<notebookId>`

`doc.getMap('nodes')`: nodeId → `Y.Map` with

- `kind: 'group' | 'section' | 'page'`
- `parent: string | null` — a group's or section's parent group id, or `null`
  for the notebook root; a page's section id
- `name: string` — group name, section name or page title. The page title lives
  here and nowhere else.
- `order: string`
- `color: string` — sections only
- `level: 0 | 1 | 2` — pages only
- `createdAt: number`, `modifiedAt: number`
- `deletedAt: number | null`

The tree is a flat map with parent pointers. A move is two field writes, so two
devices moving the same node never duplicate it. A reader that finds a parent
cycle among groups treats the nodes in the cycle as children of the root.

### `pg:<pageId>`

- `doc.getMap('meta')`: `paperStyle` (`'none' | 'ruled-narrow' | 'ruled-college'
  | 'ruled-standard' | 'ruled-wide' | 'grid-small' | 'grid-medium' |
  'grid-large' | 'grid-xlarge'`), `paperColor: string | null`
- `doc.getMap('containers')`: containerId → `Y.Map` with
  - `kind: 'text' | 'image' | 'file'`
  - `x, y: number` — CSS px from the canvas origin, which is the top-left of the
    area under the title block
  - `width: number`; `height: number` for images
  - `z: number`
  - text: `body: Y.XmlFragment` in the rich-text schema
  - image and file: `blob: string` (SHA-256 hex), `mime: string`,
    `name: string`, `size: number`
- `doc.getMap('strokes')`: strokeId → plain object `{ tool: 'pen' | 'marker' |
  'highlighter', color: string, width: number, points: number[] }` where points
  is `[x0, y0, x1, y1, …]`. A stroke is written once. Erasing deletes the entry.

### `board:<notebookId>` and To Do lines

A notebook's board doc, the To Do lines its Inbox and checklists come from,
card links, the changes that span the board, notebook and page docs, card
numbers and board keys, how the board tools read and repair boards, and the
one-time import of a Corkboard board are in [boards.md](boards.md).

### Rich text

A text container's body is a ProseMirror document stored through
`y-prosemirror`. The schema is defined once, as the TipTap extension list
exported from `packages/model`; the editor, the exporters and the importers all
use that list. Block nodes: paragraph, heading 1–6, bullet list, ordered list,
list item, table, table row, table cell, table header, image (blob reference),
hard break. Inline nodes: text, hard break, and the **card link**
(`cardLink`, an atom holding `pageId`). Paragraphs and headings carry
`textAlign`, `indent` (steps, for a paragraph outside a list), `tag` (a
**tag** name or null), `checked` (for To Do), `style` (`null | 'quote' |
'code' | 'citation'`), and for a **To Do line** `lineId` (a nanoid),
`taggedAt` (epoch ms) and `inbox` (`false` once someone chose "Keep it as a
line"). Marks: bold, italic, underline, strike, subscript, superscript,
highlight (colour), text style (colour, font family, font size in pt), link.
How a card link shows and exports, and the rule for a To Do line's id, are in
[boards.md](boards.md).

### Ordering

Siblings sort by their `order` string, then by id as a tiebreak. Inserting
between two siblings generates a new string between their two; no other node is
rewritten. `model` wraps the `fractional-indexing` package.

## Sync

### Replica store

`packages/sync` defines `ReplicaStore`: append a doc update, read a doc's
updates, compact them, put and get a blob, list doc ids. The browser and
desktop use the IndexedDB implementation (one database, not one per doc). The
server uses the disk implementation. Tests use the in-memory one.

A client writes an edit to its replica store before it sends it anywhere. The
replica store is the source of truth for that device. When the store refuses a
write (a full disk, a quota), the edit is sent to the server anyway, the write
is retried, and the sync status says changes are unsaved on this device until
it succeeds.

Two tabs on one replica store each run their own client. A handshake applies
the store's contents to the open doc first, so one tab sends what another tab
stored.

Tabs of different builds never share a replica store. The IndexedDB
database's version is the content version (see Wire protocol; builds without
one open version 1), and the name of the channel tabs use to show each
other's edits carries it too. A tab of a newer build that opens the database
closes every older build's connection, and an older build cannot open it
again. A tab of an older build that is already open neither receives the
newer tab's edits nor has its own shown there; it can no longer store
anything, so what is typed in it from then on stays in that tab, its sync
status says changes are not saved on this device (this build's tabs add
"Reload this tab to keep editing"), and reloading it loads the newer build.
A tab of an older build opened afterwards finds no store it can open and
starts with notes in memory only and no server. Tabs of one build share the
database and the channel as before.

### Wire protocol

One WebSocket per client at `/sync`. All docs share it.

1. Client sends text frame
   `{"t":"hello","token":"…","replica":"<id>","v":1,"content":2}`.
2. Server answers `{"t":"welcome","docs":["library","nb:…","pg:…", …]}` listing
   every doc id it holds, or closes with code 4401 on a bad token, or refuses a
   client whose content version is too old (below).
3. For every doc id known to either side, both sides run the Yjs handshake:
   send your state vector, receive the other side's missing operations. The
   client starts with `library`, then notebooks, then the open page, then the
   remaining pages at a bounded concurrency.
4. After a doc's handshake, each side forwards every new update for it as it
   happens. The server persists an update before relaying it to the other
   connected clients. An update that waits on content the receiver lacks is
   stored whole, so the waiting part survives a restart.

`v` is the protocol version, the layout of these frames; a server refuses
any other with 4400. `content` is the content version (`CONTENT_VERSION` in
`protocol.ts`): which nodes, marks and attributes the client's editor keeps.
An editor that meets content its schema lacks deletes or strips it, and that
deletion syncs to every device, so the version is raised whenever docs gain a
node, mark or attribute, and the server refuses a client below its own before
any doc is exchanged, with the close reason "This app is older than the
server. Reload the page or restart the app to update." A hello with a
`content` field gets close code 4426; one without (builds older than the
field) gets 4400, the one code those builds show with its reason. A refused
client keeps every edit in its replica store, shows that sentence in the sync
status, and tries again at its slowest reconnect pace, so an app that is
updated, or a server that is rolled back, syncs again. A newer client meets an
older server as usual: such a server reads `v` and ignores `content`, and so
refuses no one. The rule therefore protects content once the server runs the
build that raised the version; update the server before the apps.

A doc that fails on either side (unreadable, id too long to store) fails alone:
it is listed in the sync status and every other doc keeps syncing.

Binary frames are `[varuint type][varstring docId][payload]`:

| Type | Payload |
| --- | --- |
| 0 `StateVector` | The sender's state vector. The receiver replies with type 1. |
| 1 `Diff` | Everything the sender has that the state vector lacks. |
| 2 `Update` | One incremental update. |

Every reconnect repeats step 3 for every doc. The handshake is what makes the
system self-healing: whatever one side is missing, for any reason (a crash
between write and send, a restored snapshot, a wiped device), the other side
supplies. Skipping unchanged docs is an optimisation left for later; it must
never replace the handshake.

### Blobs

`PUT /api/blobs/<sha256>` and `GET /api/blobs/<sha256>` with
`Authorization: Bearer <token>`. The server verifies the hash on upload. Blobs
are immutable, so they cannot conflict. A client uploads blobs it has that the
server lacks (`GET /api/blobs` lists the server's hashes) and downloads every
blob the server holds so the replica is complete offline.

### Access

The server has one access token (`LOOSELEAF_TOKEN`; generated and written to
the data folder on first start when unset). The intended network is a private
one such as a tailnet. The token keeps other devices on that network out; it is
not a substitute for TLS on a public network.

### Insecure origins

A homelab address such as `http://nas:8421` is not a secure context. In it the
browser has no `crypto.subtle`, no `crypto.randomUUID` and no service worker.
Client code hashes with `@noble/hashes`, makes ids with `nanoid`, and treats the
service worker as optional. IndexedDB works, so edits made while the server is
unreachable are kept and sync later; reopening the page with no network needs
the service worker and therefore HTTPS (`tailscale serve` provides it) or the
desktop app.

## Server data folder

```
data/
  token                 access token, when generated
  docs/<docId>/snapshot  one merged Yjs update, replaced by atomic rename
  docs/<docId>/log       framed updates since the snapshot: [u32 length][u32 crc32][bytes]
  blobs/<aa>/<sha256>
  snapshots/<yyyy-mm-dd>/  dated copies of docs/ and blobs/ (blobs hard-linked)
  mirror/               the notes as Markdown; see Mirror
  corkboard-import.json  the state of a Corkboard import; see boards.md
```

Doc ids are percent-encoded for the folder name. A log record whose length or
checksum is wrong ends the log; the reader moves it and everything after it to
`log.corrupt-<time>`, and the next handshake restores whatever was lost. A
snapshot that does not decode is renamed to `snapshot.corrupt-<time>` the same
way. Plain files mean the data
folder can be backed up with rsync, restic or a ZFS snapshot.

## Mirror

Docs and blobs are plain files to a backup tool, but only Looseleaf can read
them. A **mirror** is the same notes as a folder of Markdown files that any
editor, `grep` or other program can read while Looseleaf is not running:

```
mirror/
  .looseleaf-mirror.json     the mirror manifest
  assets/<sha256>.<ext>      pictures and attached files, shared by every page
  <Notebook>/<Section group>/<Section>/<Page>.md
```

Folder and file names come from the same rules as the Markdown export
(`packages/model/src/export/names.ts`). Deleted notebooks, sections and pages
are left out. Each page file starts with YAML front matter (`id`, `notebook`,
`section`, each a JSON-quoted string; a section inside groups is written
`Group / Section`), then the page exactly as the Markdown export writes it.

A mirror is one-way. The docs are the source of truth, a file is rewritten when
its page changes, and nothing reads the mirror back into a doc. What Markdown
cannot hold is lost the same way as in the export: a container's position
becomes reading order, and strokes are left out.

### Planning and applying

`packages/model/src/mirror` plans; a host applies. The planner is given a
`DocSource`, the previous **mirror manifest** (or none) and the ids of the
pages whose content changed. It reads the library and every notebook tree,
works out each page's path, and renders the pages that are new, were named as
changed, or whose path, title, notebook name or section name differs from the
manifest; any other page keeps its entry and its doc is not read. It returns
the page files to write, the asset files to copy (by blob hash, so the host
streams the bytes from its own store), the paths to remove and the next
manifest. A page doc that cannot be read keeps its previous entry and is
reported. It touches no disk.

The manifest lists every page in notebook order with its id, notebook and
section ids and names, title, subpage level, path, a hash of the file's bytes,
its asset file names and the hashes of blobs it references that the replica
does not hold yet. A plan with no previous manifest, or one asked to check
everything, renders every page and writes only the files whose hash differs.

Two hosts apply plans:

- The server (`packages/server/src/mirror.ts`) keeps `data/mirror/`. It is on
  unless `LOOSELEAF_MIRROR=off`. Applying a plan to a folder lives in
  `packages/server/src/mirror-folder.ts`, which the desktop shell reuses.
- The desktop app keeps a mirror of its own replica in a folder the person
  chooses. `packages/web/src/mirror` runs the planner over the sync client,
  which reports each doc change and blob it stores, whether made on the
  device or received from the server (`onDocStored`, `onBlobStored`). It
  hands the files to the shell through the bridge in batches of at most 200
  files and 8 MB; each batch carries a manifest that is true of the folder
  once it is applied (the previous manifest less what was removed so far,
  with the plan's entry for each page written so far, and the plan's manifest
  on the last batch), so a failure between batches leaves a manifest that
  lists every file the mirror has written.
  The shell remembers the folder in user data and applies each batch with
  `mirror-folder.ts`; the page never names a folder. It accepts a folder only
  when it is empty (names starting with `.` aside) or already holds a mirror
  manifest, since a plan overwrites whatever is at its paths. It is off until
  a folder is chosen and runs only while the app is open.

Rules both hosts follow:

- A host removes only paths the manifest on disk lists, and folders only when
  they are empty. Any other file in the mirror folder is left alone.
- Every path in a plan is checked to resolve inside the mirror folder, with
  symlinks followed, before it is written or removed.
- A file is written to a dot-prefixed temporary name beside it, fsynced and
  renamed into place; temporary files a crash leaves are removed by the next
  start, from the folders the manifest lists. Removals go first (so a
  case-only rename works on a case-insensitive disk), then assets, then
  pages, so a page never links to an asset that is not there yet. The manifest is written last, so a crash leaves a manifest
  that describes files that exist; the next check repairs the rest.
- A change is applied 5 seconds after the last change to that doc
  (`MIRROR_DELAY_MS`), so typing a paragraph rewrites the file once. A page
  doc's change re-renders that page; a library or notebook doc's change
  re-plans paths. A blob that arrives re-renders the pages that were waiting
  for it.
- At start the host checks everything, which also repairs a mirror that fell
  behind in a crash. A missing or unreadable manifest means every file is
  written again; files a lost manifest listed are not removed.
- A mirror that cannot be written is logged and tried again at the next
  change. It never delays or fails a sync write.

The server reads docs for the mirror from its store, after the update is on
disk; the hub only reports which doc id changed. Snapshots do not copy
`mirror/`, since it is rebuilt from the docs.

### MCP endpoint

`POST /mcp` on the server speaks the Model Context Protocol (streamable HTTP,
stateless, JSON responses; `GET` and `DELETE` answer 405) so an AI assistant
on the same network can search, read and add to the notes and work the
boards. It takes the same bearer token as the blob routes. The protocol is in
`mcp.ts`; `mcp-tools.ts` holds the tool list and checks each call's arguments
against the tool's schema; the notes tools are in `mcp-notes-tools.ts` and
the board tools in `mcp-board-read-tools.ts` and `mcp-board-write-tools.ts`.
The runtime uses no MCP SDK. With the mirror off (`LOOSELEAF_MIRROR=off`) the
notes read tools answer, with `isError`, that they need it; every other tool
works, since none of them reads the mirror. How an agent is meant to use it is in [agents.md](agents.md).

One endpoint serves the notes tools and the board tools. The board tools have
the same names as Corkboard's, so instructions that name one only change the
server prefix:

| Tool | What it does |
| --- | --- |
| `list_notebooks`, `list_pages`, `search_notes`, `read_page` | Read the notes from the mirror, as below. `read_page` takes a page id, a page address or a card ref. |
| `create_page`, `append_to_page` | Add to the notes, as below. `append_to_page` takes a page id, a page address or a card ref. |
| `list_boards` | Every board: its key, its notebook's name, and its cards per status. |
| `get_board` | One board, named by key or notebook name: the Inbox lane, then each status with its cards (`renderBoard`). Narrowed to one status or label, the Inbox is left out. |
| `search_cards` | Cards by words (title, page text, labels, comments, links), status, label and due day, across boards or on one. |
| `get_card` | One card by ref or page id: its board fields and its page as Markdown, with its To Do lines as the checklist, each with its line id (`renderCard`). The id it prints is the page id. |
| `create_card` | Makes the page and the card (`addCard`); a description becomes the page's first text. With a line id it turns that Inbox line into the card (`promoteTodoLine`). |
| `update_card` | Title (the page title), due day, labels (`labelCard`). No description: text is added with `append_to_page`. |
| `update_checklist` | Ticks and unticks To Do lines on the card's page by line id or exact text, and adds new ones. It never removes a line or changes its text. |
| `move_card`, `add_comment`, `add_link`, `archive_card` | As named; archiving is the one way off the board. |
| `create_status`, `create_label` | Add a status (with a kind) or a label (with an optional label tie) to a board. |
| `create_board` | Makes the board on a notebook. Fails with a sentence when the notebook has one. |

No tool deletes a card, a status or a board, and none removes a To Do line,
so nothing an agent does on a board is unrecoverable. Callers name things the
way a person would: a board by key or notebook name, a card by ref, a status
by name or by kind, a label by name. A mistake the caller can fix is a result
with `isError` set and a sentence that says what to do next.

The `initialize` reply carries instructions: write what outlasts a task to a
page without being asked; before starting a task, find or make its card and
move it to a `doing` status; record progress on the card (tick its To Do
lines, comment findings and decisions, link branches and pull requests); when
stopping, comment what was done and what is left. The card is its page, so
longer notes go on the page with `append_to_page`, which takes the card ref.

How the board tools find, read and repair boards is in
[boards.md](boards.md#board-tools).

The notes read tools serve the server's mirror and nothing else: they list
notebooks and pages from the mirror manifest (so a section with no pages is
not listed), search the mirror's Markdown files on each call, and return a
page's file. Files are read only at paths the manifest lists, through
`MirrorFolder.readText`, which refuses a path that resolves outside the
folder.

The notes write tools never touch the mirror. `create_page` adds a top-level page
at the end of a section, with its Markdown in one text container;
`append_to_page` adds Markdown after the end of the page's last text
container in reading order (or, on a page with none, in a new text container
below everything else) and bumps the page's `modifiedAt`. Neither rewrites,
moves or removes anything already in a doc, so a write merges with edits
made anywhere else at the same time. `model` turns the Markdown into rich
text (`import-markdown.ts`, the inverse of the Markdown export).
`notes-writer.ts` makes each change through `Hub.withDoc`, which runs a
callback on the doc in one transaction inside the doc's queue, stores the
resulting update and relays it to every connected client, as an update from
a client would be. The store reports the doc as stored, so the mirror
rewrites the page after its delay and the read tools show the write then.

## Clients

The web client is one React app. Served by the server it connects to its own
origin. In the desktop shell it asks for a server address and token, or runs
with no server. Layout follows OneNote: ribbon on top, notebook and section
list, page list, canvas. Under 768 px wide the three panes become a drill-down:
notebooks and sections, then pages, then the page. A notebook with a board
shows a Board row above its sections that opens the board in place of the
pages pane and canvas; [ui.md](ui.md) has the board screens.

The desktop shell loads the built web client from an `app://` origin, which is
a secure context with stable IndexedDB storage. A mobile shell (Capacitor) can
host the same build; nothing in `web` may assume a mouse, a hover state or a
wide screen.

### Page addresses

A page address lets another program open one page. Its two forms are defined
in `packages/model/src/page-address.ts`: the web client's URL ending in
`#page=<pageId>`, and `looseleaf://page/<pageId>`, a scheme the desktop app
registers with the operating system. The desktop shell turns the second into
the first by setting the window's fragment, so the web client has one way in
(`nav/open-page-address.ts`): it selects the page, in whichever notebook holds
it, and removes the fragment. A page that has not synced yet opens when it
arrives. An address for a page this replica never receives does nothing.

### Desktop updates

The packaged Mac app replaces itself with newer builds. CI publishes each
build of `main` as a zip and an update manifest, `latest.json`, on one
release; `packages/desktop/src/updater.ts` reads the manifest, downloads and
checks a later build, and swaps it in after the app exits. The web client's
only part is the bar that says an update is ready (`app/UpdateBar.tsx`),
reached through two bridge calls. The steps, the checks and the limits of
trust without an Apple Developer ID are in `packages/desktop/README.md`.

## Import and export

Importers produce an **import tree** (`packages/model/src/import-tree.ts`).
`model` turns an import tree into docs. The first importer reads `.one` files,
implemented from Microsoft's published [MS-ONESTORE] and [MS-ONE]
specifications. A Corkboard board is imported once into a notebook's board;
see [boards.md](boards.md#importing-a-corkboard-board).

### Export

Export works per page, section, notebook or library: HTML with embedded
images, Markdown with an assets folder, plain text, and a lossless JSON form.
Multi-page exports are a zip that mirrors the notebook tree. PDF comes from the
browser's or the shell's print pipeline.
