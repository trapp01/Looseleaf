# Architecture

Looseleaf is a local-first notebook app. Every device holds a full copy of the
notes and works offline. A self-hosted server is the hub the devices sync
through and the place backups live. Words in **bold** are defined in
[glossary.md](glossary.md).

## Packages

| Package | Owns | Refuses to know |
| --- | --- | --- |
| `packages/model` | What a library, notebook, page and container are; the rich-text schema; reading and writing them inside Yjs docs; export to HTML, Markdown, text and JSON; turning an import tree into docs. | Networking, storage, the DOM, React. |
| `packages/sync` | The wire protocol, the replica store interface, and the client that keeps a replica in step with a server. | What is inside a doc. Doc ids and bytes are opaque. |
| `packages/server` | The hub: doc and blob storage on disk, the sync endpoint, snapshots, serving the web client. | What is inside a doc. |
| `packages/onenote` | Reading Microsoft `.one` files into an import tree. | Yjs, storage, UI. |
| `packages/web` | The user interface. Runs in a browser, inside the desktop shell, and later inside a mobile shell. | Disk paths, Electron APIs (it talks to the shell through one small bridge). |
| `packages/desktop` | The Electron shell: window, native menus, PDF output, file dialogs. | Notes. It hosts `packages/web` unchanged. |

Imports flow one way: `web → model, sync, onenote`; `server → sync`;
`onenote → model` (types only); `desktop → nothing at runtime` (it loads the
built web client). `model` and `sync` do not import each other. This is prose
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

Ids are 21-character nanoid strings. A page doc is keyed by the page id alone,
so moving a page to another section or notebook never rewrites its content.

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

### Rich text

A text container's body is a ProseMirror document stored through
`y-prosemirror`. The schema is defined once, as the TipTap extension list
exported from `packages/model`; the editor, the exporters and the importers all
use that list. Block nodes: paragraph, heading 1–6, bullet list, ordered list,
list item, table, table row, table cell, table header, image (blob reference),
hard break. Paragraphs and headings carry `textAlign`, `indent` (steps, for a
paragraph outside a list), `tag` (a **tag** name or null), `checked` (for To Do)
and `style` (`null | 'quote' | 'code' |
'citation'`). Marks: bold, italic, underline, strike, subscript, superscript,
highlight (colour), text style (colour, font family, font size in pt), link.

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

### Wire protocol

One WebSocket per client at `/sync`. All docs share it.

1. Client sends text frame `{"t":"hello","token":"…","replica":"<id>","v":1}`.
2. Server answers `{"t":"welcome","docs":["library","nb:…","pg:…", …]}` listing
   every doc id it holds, or closes with code 4401 on a bad token.
3. For every doc id known to either side, both sides run the Yjs handshake:
   send your state vector, receive the other side's missing operations. The
   client starts with `library`, then notebooks, then the open page, then the
   remaining pages at a bounded concurrency.
4. After a doc's handshake, each side forwards every new update for it as it
   happens. The server persists an update before relaying it to the other
   connected clients. An update that waits on content the receiver lacks is
   stored whole, so the waiting part survives a restart.

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
```

Doc ids are percent-encoded for the folder name. A log record whose length or
checksum is wrong ends the log; the reader moves it and everything after it to
`log.corrupt-<time>`, and the next handshake restores whatever was lost. A
snapshot that does not decode is renamed to `snapshot.corrupt-<time>` the same
way. Plain files mean the data
folder can be backed up with rsync, restic or a ZFS snapshot.

## Clients

The web client is one React app. Served by the server it connects to its own
origin. In the desktop shell it asks for a server address and token, or runs
with no server. Layout follows OneNote: ribbon on top, notebook and section
list, page list, canvas. Under 768 px wide the three panes become a drill-down:
notebooks and sections, then pages, then the page.

The desktop shell loads the built web client from an `app://` origin, which is
a secure context with stable IndexedDB storage. A mobile shell (Capacitor) can
host the same build; nothing in `web` may assume a mouse, a hover state or a
wide screen.

## Import and export

Importers produce an **import tree** (`packages/model/src/import-tree.ts`).
`model` turns an import tree into docs. The first importer reads `.one` files,
implemented from Microsoft's published [MS-ONESTORE] and [MS-ONE]
specifications.

Export works per page, section, notebook or library: HTML with embedded
images, Markdown with an assets folder, plain text, and a lossless JSON form.
Multi-page exports are a zip that mirrors the notebook tree. PDF comes from the
browser's or the shell's print pipeline.
