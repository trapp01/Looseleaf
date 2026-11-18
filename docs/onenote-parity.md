# OneNote parity

Every feature of OneNote for Mac 16.113, taken from its menus and ribbon, and
where Looseleaf stands on each. Update this file in the change that builds or
drops a feature.

Status: **built**, **partial** (note says what is missing), **planned**,
**not planned** (note says why).

## Layout

| OneNote | Status | Notes |
| --- | --- | --- |
| Ribbon with Home, Insert, Draw, View tabs | built | Commands that are not built show disabled. |
| Left rail: notebooks, search, recent | built | |
| Notebook switcher above the section list | built | |
| Section list with coloured tabs, "Add section" | built | |
| Page list with subpage indent, "Add page", sort | built | |
| Freeform canvas, click anywhere to type | built | |
| Page title with date and time under it | built | |
| Phone layout | built | Drill-down: sections, pages, page. OneNote for Mac has none. |

## File and notebooks

| OneNote | Status | Notes |
| --- | --- | --- |
| New / rename / delete page, section, section group | built | |
| New notebook with a colour | built | |
| Close and reopen a notebook | planned | |
| Make subpage / promote subpage | built | |
| Move or copy page to another section | partial | Move is built within a notebook. Moving to another notebook and copy are planned. |
| Move or copy section | partial | Move is built within a notebook. Moving to another notebook and copy are planned. |
| Copy link to page / section / notebook | partial | Every page has a page address that opens it in the web client or the desktop app (see the glossary). No command copies one yet; sections and notebooks have none. |
| Deleted notes: view, restore, empty | partial | Emptying removes pages, sections and groups for good. A deleted notebook stays restorable; removing one for good is planned. |
| Page versions | planned | Yjs keeps the history needed; no viewer yet. |
| Set as default template | planned | |
| Section password protection | planned | Needs client-side encryption of page docs. |
| Sync this notebook / all notebooks | built | Sync is continuous; the status control shows state. |
| Open backups | partial | The server keeps dated snapshots; restore is a manual copy. |
| Share: invite people, view-only links | not planned | Single-user for now. The CRDT model allows it later. |
| Send page as PDF / Save as PDF | built | Through print. |
| Send page as email message | planned | |
| Print | built | |

## Home

| OneNote | Status | Notes |
| --- | --- | --- |
| Cut, copy, paste, paste text only | built | Browser clipboard. |
| Copy format / paste format | planned | |
| Font family and size | built | Carlito stands in for Calibri. |
| Bold, italic, underline, strikethrough | built | |
| Subscript, superscript | built | |
| Highlight, font colour | built | |
| Clear all formatting | built | |
| Bullets, numbering | built | |
| Increase / decrease indent | built | |
| Alignment | built | |
| Styles: Heading 1–6, Page Title, Citation, Quote, Code, Normal | partial | Page Title is planned. |
| Tags: To Do, Important, Question, Remember for later, Definition | built | |
| Dictate | not planned | Use the OS dictation. |
| Copilot | not planned | |

## Insert

| OneNote | Status | Notes |
| --- | --- | --- |
| Table, with row and column commands, sort | partial | Merge and split cells are built too. Sort and header toggle are planned. |
| File attachment | built | |
| Printout | planned | |
| Picture | built | |
| Screenshot | planned | Desktop shell only. |
| Link | built | |
| Equation | planned | |
| Date, Date & Time | built | |
| Shapes | planned | |
| Audio recording | planned | |
| Meeting details | not planned | Needs a calendar account. |
| Stickers | not planned | Microsoft artwork. |

## Draw

| OneNote | Status | Notes |
| --- | --- | --- |
| Text mode | built | |
| Pen, marker, highlighter with colours and widths | partial | Desktop layout only; the phone layout is text only. |
| Eraser | built | Removes whole strokes. |
| Lasso select | planned | |
| Insert space | planned | |

## View

| OneNote | Status | Notes |
| --- | --- | --- |
| New window | planned | Desktop shell. |
| Switch background (dark canvas) | partial | The canvas follows the system's light or dark setting; there is no manual switch. |
| Immersive reader | not planned | |
| Zoom in, out, reset, page width | built | |
| Paper colour | built | |
| Paper style: rule lines and grids | built | |
| Hide page title | planned | |
| Hide authors | not planned | Single-user. |
| Translate | not planned | |
| Check accessibility | planned | |
| Live captions | not planned | |

## Search

| OneNote | Status | Notes |
| --- | --- | --- |
| Search this page / section / notebook / all notebooks | built | |
| Find next / previous | planned | |

## Beyond OneNote

| Feature | Status | Notes |
| --- | --- | --- |
| Self-hosted sync server | built | |
| Offline editing with merge on reconnect | built | |
| Export page, section, notebook or library to HTML, Markdown, text, JSON | built | |
| Markdown mirror of every page on the server (`data/mirror`) | built | Read-only, rewritten about 5 seconds after an edit. `LOOSELEAF_MIRROR=off` turns it off. The desktop app keeps the same mirror of its own replica in a folder chosen in Settings, while it is open. |
| MCP endpoint for AI assistants (`POST /mcp`) | built | List notebooks and pages, search, read a page, create a page from Markdown, and add Markdown to the end of a page. Nothing already in the notes is changed or removed. Needs the server mirror on. |
| Import `.one` section files and notebook folders | partial | Ink is not read, and files downloaded from OneDrive use a packaging that is not read yet. See `packages/onenote/README.md`. |
| Export to `.one` | planned | No open-source writer exists yet. |
| Kanban board per notebook, with cards that are pages | planned | The doc model is built; what works is tracked in [board-parity.md](board-parity.md). |
| Mobile apps | planned | A Capacitor shell around `packages/web`. |
