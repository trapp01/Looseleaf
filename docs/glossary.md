# Glossary

One name per thing. Folders, types, config keys and UI copy use these words.

| Word | Meaning | Owning folder |
| --- | --- | --- |
| **Library** | Every notebook a person has. One per server and per device. | `packages/model` |
| **Notebook** | Top-level book of notes. Holds section groups and sections. | `packages/model` |
| **Section group** | A folder of sections (and other section groups) inside a notebook. | `packages/model` |
| **Section** | A coloured tab inside a notebook. Holds pages. | `packages/model` |
| **Page** | One freeform canvas of notes with a title and a created time. | `packages/model` |
| **Subpage** | A page indented under the page above it. Level 1 or 2; a top page is level 0. | `packages/model` |
| **Page address** | What another program opens to land on one page: the web client's URL ending in `#page=<pageId>`, or `looseleaf://page/<pageId>` for the desktop app. | `packages/model/src/page-address.ts` |
| **Update manifest** | `latest.json` on the release CI replaces with every build: the newest Mac build's version, zip name, sha256 and size. The desktop app reads it to update itself. | `packages/desktop/src/updater.ts` |
| **Node** | One entry in a notebook's tree: a section group, a section or a page. | `packages/model` |
| **Container** | A box placed on a page at an x/y position. Text containers hold rich text; image and file containers hold a blob. OneNote calls the text kind a "note container". | `packages/model` |
| **Tag** | A marker on a paragraph: To Do, Important, Question, Remember for later, Definition. | `packages/model` |
| **To Do line** | A paragraph or heading carrying the To Do tag. Tagging gives it a line id and a tagged-at time; importers other than Markdown leave both empty. | `packages/model/src/todo-lines.ts` |
| **Board** | A notebook's kanban board: statuses, labels and cards. A notebook has one or none; its doc is keyed by the notebook's id. | `packages/model/src/board` |
| **Board key** | The short uppercase prefix of a board's card refs, such as `DEE`. Set when the board is made; a person cannot change it. A server changes it once when two boards made apart took the same key. | `packages/model/src/board` |
| **Status** | A column of a board. A card is in exactly one. Trello calls it a list. | `packages/model/src/board` |
| **Status kind** | What a status means for the work on its cards, whatever it is called: `todo`, `doing` or `done`. | `packages/model/src/board` |
| **Card** | A page that is on its notebook's board: the page plus board fields (ref, status, place in the status, labels, due day, comments, links, activity). A card has no text of its own and no id of its own; its id is the page id. | `packages/model/src/board` |
| **Card ref** | A card's name in text: the board key, a dash and the card's number, such as `DEE-12`. | `packages/model/src/board` |
| **Checklist** | The To Do lines on a card's page, in reading order. Not a separate list; progress is ticked over total. | `packages/model/src/todo-lines.ts` |
| **Inbox** | The board's first lane: To Do lines tagged after the board was made, unticked, on live pages of the notebook that are not cards, that nobody chose "Keep it as a line" for. Newest first; worked out, never stored. | `packages/model/src/board/inbox.ts` |
| **Card link** | An inline node in a note that points at a card by its page id and shows its title, ref and status live. | `packages/model` (schema), `packages/web` (view) |
| **Label** | A coloured tag defined on a board. A card can carry several; they say what a card is about, separately from the section its page is in. | `packages/model/src/board` |
| **Label tie** | A label's optional pointer to a section, used to file new cards' pages. It never moves or renames an existing page or section. | `packages/model/src/board/filing.ts` |
| **Unfiled section** | The section that holds a new card's page when no label tie applies. Made the first time it is needed, with an id derived from the notebook's; an ordinary section otherwise. | `packages/model/src/board/filing.ts` |
| **Comment** | A Markdown note on a card, with who wrote it and when. | `packages/model/src/board` |
| **Link** | A pointer from a card to something outside the board: a URL, or a page written `looseleaf:<pageId>`. Not a card link. | `packages/model/src/board` |
| **Activity** | A card's history: created, moved between statuses, archived, restored. | `packages/model/src/board` |
| **Actor** | The name recorded as having made a change on a board: the name a person gave their device, or the name an agent passed. | `packages/model/src/board` |
| **Archive** | Taking a card off the board, or hiding a status, without deleting anything. An archived card's page stays where it is as a loose page; restoring brings back the same ref and history. Nothing on a board is ever deleted except labels, comments and links. | `packages/model/src/board` |
| **Agent** | An AI assistant working on the notes and boards through the MCP endpoint. | `packages/server` |
| **Stroke** | One pen, marker or highlighter line drawn on a page. | `packages/model` |
| **Blob** | An immutable binary (picture, attached file) named by the SHA-256 of its bytes. | `packages/sync` |
| **Doc** | One unit of sync: a Yjs document with a string id. The library, each notebook, each page and each board are separate docs. | `packages/sync` |
| **Replica** | One device's full local copy of every doc and blob. | `packages/sync` |
| **Content version** | Which nodes, marks and attributes a client's editor keeps. A client sends it in its hello and the server refuses one below its own, since an editor deletes content its schema lacks. | `packages/sync/src/protocol.ts` |
| **Replica store** | Where a replica keeps its docs and blobs on the device. | `packages/sync` |
| **Server** | The self-hosted hub that replicas sync through. It is also a replica store, on disk. | `packages/server` |
| **Snapshot** | A dated copy of the server's docs and blobs, kept for point-in-time restore. | `packages/server` |
| **Mirror** | A folder of Markdown files, one per page, that follows a replica so the notes can be read without Looseleaf. Read-only: the docs stay the source of truth. | `packages/model/src/mirror` |
| **Mirror manifest** | The file at a mirror's root that lists every page in it, in notebook order, and every file the mirror owns. | `packages/model/src/mirror` |
| **Import tree** | The neutral, plain-object form of a notebook that every importer produces. | `packages/model` |
| **Deleted notes** | The recycle bin. Deleting a section or page marks it deleted; it stays restorable. | `packages/model` |
