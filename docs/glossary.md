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
| **Node** | One entry in a notebook's tree: a section group, a section or a page. | `packages/model` |
| **Container** | A box placed on a page at an x/y position. Text containers hold rich text; image and file containers hold a blob. OneNote calls the text kind a "note container". | `packages/model` |
| **Tag** | A marker on a paragraph: To Do, Important, Question, Remember for later, Definition. | `packages/model` |
| **Stroke** | One pen, marker or highlighter line drawn on a page. | `packages/model` |
| **Blob** | An immutable binary (picture, attached file) named by the SHA-256 of its bytes. | `packages/sync` |
| **Doc** | One unit of sync: a Yjs document with a string id. The library, each notebook and each page are separate docs. | `packages/sync` |
| **Replica** | One device's full local copy of every doc and blob. | `packages/sync` |
| **Replica store** | Where a replica keeps its docs and blobs on the device. | `packages/sync` |
| **Server** | The self-hosted hub that replicas sync through. It is also a replica store, on disk. | `packages/server` |
| **Snapshot** | A dated copy of the server's docs and blobs, kept for point-in-time restore. | `packages/server` |
| **Import tree** | The neutral, plain-object form of a notebook that every importer produces. | `packages/model` |
| **Deleted notes** | The recycle bin. Deleting a section or page marks it deleted; it stays restorable. | `packages/model` |
