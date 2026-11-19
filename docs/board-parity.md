# Board parity

The features of Trello's board, taken from its board view, card back, menus
and keyboard shortcuts, and where a Looseleaf board stands on each. Boards
follow Trello's layout and mechanics inside Looseleaf's shell, not Trello's
look. Update this file in the change that builds or drops a feature.

Status: **built**, **partial** (note says what is missing), **planned**,
**not planned** (note says why). Trello's word comes first; Looseleaf's word
is in the notes where it differs. "Model only" means `packages/model` reads and
writes it but no screen or MCP tool uses it yet.

## Board

| Trello | Status | Notes |
| --- | --- | --- |
| Lists side by side, scrolling sideways | built | A list is a **status**. |
| Add, rename, reorder (drag), archive a list | built | On the board: "Add a status", rename in place or from the status menu, drag by the header or move left and right from the menu, and archive with Undo. Adding over MCP too (`create_status`). |
| Cards stacked in a list, each list scrolling on its own | built | |
| Add a card, Enter to add the next | built | At the top of the status: the composer sits under the status header. The card's page is filed by its first label's tie, else in the Unfiled section. Over MCP too. |
| Drag a card within a list and between lists | built | Pointer, touch (press and hold) and keyboard (Space, arrows, Space). Off while the label filter hides cards. |
| Card front: labels, title, badges for due date, description, checklist, comments | built | The title is the page title, the description is the first lines of the page, the checklist is the page's To Do lines. Counts of comments and links. A due day shows as overdue or today. |
| Card covers (image or colour) | planned | |
| List card limit | planned | |
| Collapse a list | planned | |
| Copy or move a whole list | planned | |
| Sort a list by date or name | not planned | A card's place in its status is its importance, set by hand or by an agent. |
| Board background colour or image | partial | The backdrop is tinted with the notebook's colour. No colour of its own, no image. |
| Several boards, board switcher | built | One board per notebook, at most; switching notebooks switches boards. |
| Archive and restore a board | not planned | A board goes with its notebook: deleting the notebook hides it. |
| Workspaces holding boards | not planned | The **library** holds notebooks, and a notebook holds its board. |
| Boards for a section, or spanning notebooks | not planned | One board per notebook. |
| Star a board | planned | |
| Board templates | planned | |

## Card

| Trello | Status | Notes |
| --- | --- | --- |
| Card opens over the board at its own address | built | A card is a page: it opens beside the board, and the page address opens it anywhere. No modal. |
| Card number and short link | partial | The **card ref** is the board key and the number, on the card front and the card strip, where "Copy ref" copies it. Every MCP tool that names a card or a page takes a ref, a page id or a page address. No button copies the page address yet. |
| Title, description in Markdown | built | The page title and the page itself, edited on the canvas. |
| Labels with a colour and a name; create and edit from the card | built | Ten colours. A label can be tied to a section to file new cards' pages. Made from the card strip or the board's Labels dialog, which also edits, ties and deletes them. Creating and putting on or off a card over MCP too. |
| Due date | built | A day, no time of day, no start date, no reminders. Set in the card strip, or over MCP. |
| Mark a card complete | built | A card is complete when its status has the kind `done`; its front reads as finished. |
| Checklists | partial | The To Do lines on the card's page, in reading order, counted on the card front and the card strip. Ticking on the page and over MCP (`update_checklist`) is the same edit. The card front shows the count and cannot tick. |
| Attachments, pasted or dropped | built | File and picture containers on the page. |
| Links to URLs | built | And to pages, as `looseleaf:<pageId>`, which open the page. Added and removed in the Activity panel; adding over MCP too (`add_link`). |
| Comments, edit and delete | built | In the Activity panel, in Markdown. A device edits and deletes the comments written under its name. Adding over MCP too (`add_comment`). |
| Activity | built | Records created, moved, archived, restored. Field edits are not recorded. In the Activity panel, and shown by `get_card` over MCP. |
| Members, assign and join | not planned | Single-user for now. An **actor** name is recorded on each change. |
| Move a card from the card back | built | The status picker in the card strip. |
| Copy a card | planned | |
| Card templates | planned | |
| Custom fields | planned | |
| Location, voting, stickers | not planned | |
| Watch a card, notifications | planned | |
| Archive and restore a card | built | Archiving takes the card off the board and leaves the page as a loose page; restoring brings back the same ref and history. Archive is in the card strip's menu, with Undo; Archived items restores. Over MCP too. |
| Delete a card for good | not planned | Archiving is the only way off the board, so nothing an agent does is unrecoverable. Deleting the page hides the card until the page is restored. |

## Finding

| Trello | Status | Notes |
| --- | --- | --- |
| Filter by keyword | built | The board's search box (`/` focuses it, Escape clears it) keeps cards with every word in the title, the page text, labels, comments or links, together with the label filter. Over MCP too (`search_cards`). |
| Filter by label | built | On the board, a card shows when it carries any chosen label. Over MCP too (`search_cards`, `get_board`). |
| Filter by due date, activity, completion | partial | `search_cards` over MCP filters by due day and by status, which covers completion; no screen yet, and no filter by activity. |
| Search across boards | built | Over MCP (`search_cards`). |
| Archived items view | built | The board's Archived items: archived statuses and cards, each with Restore. Over MCP, `search_cards` with `include_archived`. |

## Views

| Trello | Status | Notes |
| --- | --- | --- |
| Board | built | |
| Table, Calendar, Timeline, Dashboard, Map | planned | |

## Keyboard

| Trello | Status | Notes |
| --- | --- | --- |
| `n` add a card | built | To the status under the pointer, else the first. |
| `/` or `f` find | partial | `/` focuses the board's search box; `f` is not bound. |
| `c` archive the hovered card | built | Or the card in focus. With undo. |
| `Enter` open the hovered card | built | Or the card in focus. |
| `?` shortcut list | built | |
| `Esc` close | built | Closes the page beside the board; dialogs, menus and popovers close first. |
| `j`/`k` move between cards, `t` edit title, `l` labels, `d` dates, `,` `.` move card | planned | |
| `z` undo, `r` repeat | planned | |

## Beyond Trello

| Feature | Status | Notes |
| --- | --- | --- |
| Any page can go on its notebook's board ("Put on board") | built | From the Home tab, the page menu in the pages pane and the phone's more-actions menu. |
| Inbox lane of new To Do lines from anywhere in the notebook | built | The board's first lane: lines tagged after the board was made, newest first, each with a tick box and its page, which opens beside the board. "Keep it as a line" takes one out. Not shown while empty. Listed by `get_board` over MCP too. |
| Turn a To Do line into a card ("Make it a card in", or drag from the Inbox) | built | From the line's menu (the Inbox lane, the "Inbox" pill on the page, right-click or a long press on the line), or by dragging an Inbox line into a status, where it lands at the drop. The line becomes a card link; the card links back to the line's page. Two devices doing it apart end with one card and one card link. Over MCP too (`create_card` with a line id). |
| Card links in notes showing title, ref and status live | built | An inline chip that follows the card's title, ref and status, says "archived" for an archived card, and opens the page. The exports write it as a link to the page. |
| Board beside a page, to drag a line onto it | partial | The board opens as a pane beside the page (the View tab's "Board beside page", or "Board" under the page title), Inbox first, so a line is dragged from the Inbox into a status without leaving the page. Lines do not drag out of the page's text itself. |
| MCP endpoint for AI agents | built | One endpoint for notes and boards; see [agents.md](agents.md). |
| Status kinds (`todo`, `doing`, `done`) | built | Lets an agent name a status by what it means. Set from the status menu or when adding a status; agents name statuses by kind over MCP. |
| Offline editing with merge on reconnect | built | The board doc is a Yjs doc that merges field by field: a card or a board made on two replicas apart keeps every comment, label, link, move and status change made on either. Model convergence tests cover putting one page on the board and promoting one line on two replicas, making one board twice, the first Unfiled section and a retitle against a move; server tests cover an agent and an offline replica editing one card and the repairs of card numbers, board keys and card links. |
| Live flash on a card another device or an agent changed | built | |
| Automation (Butler), Power-Ups | not planned | Agents over MCP cover the same ground. |
| Import from Trello | planned | From Trello's JSON export. |
| Import from Corkboard | built | `server.js import-corkboard`, once per board, with the server stopped: refs, statuses, labels, comments, links, activity and times carry over exactly; a card linked to a page in the notebook becomes that page, unless several cards link to it. See `packages/server/README.md`. |
| Sharing with other people, permissions | not planned | Single-user for now. The CRDT model allows it later. |
