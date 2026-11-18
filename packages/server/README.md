# @looseleaf/server

The self-hosted hub that every Looseleaf replica syncs through. It stores
docs and blobs on disk, runs the `/sync` WebSocket endpoint, takes a daily
snapshot of its data folder, keeps a Markdown mirror of the notes, repairs
what replicas apart can make clash on a board, answers AI assistants at an
MCP endpoint, and serves the built web client. The same program imports a
Corkboard board (see Importing a Corkboard board). HTTP and
the WebSocket share one port.

## Running

| Command | Does |
| --- | --- |
| `pnpm --filter @looseleaf/server dev` | Runs `src/main.ts` with `tsx watch`. |
| `pnpm --filter @looseleaf/server build` | Bundles the server and its dependencies into `dist/server.js` with esbuild. |
| `pnpm --filter @looseleaf/server start` | Runs the bundle: `node dist/server.js`. |
| `docker compose up -d` | Pulls `ghcr.io/trapp01/looseleaf:latest` and runs it with a named volume. |
| `docker compose up -d --build` | Builds the image from the repo root `Dockerfile` instead of pulling it. |

The bundle needs only Node 22; copy `dist/server.js` anywhere and run it.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOOSELEAF_PORT` | `8421` | Port for HTTP and the sync WebSocket. |
| `LOOSELEAF_DATA` | `./data` | The data folder (layout below). |
| `LOOSELEAF_TOKEN` | unset | The access token. When unset, the server reads `data/token`, or generates a token, writes it there with mode 0600 and prints it once. |
| `LOOSELEAF_WEB_DIR` | unset | Folder of the built web client (`packages/web/dist`). Ignored unless it holds an `index.html`; without one the server answers every non-API path with a one-line notice. |
| `LOOSELEAF_MAX_BLOB_BYTES` | `209715200` (200 MB) | Largest blob upload accepted. |
| `LOOSELEAF_SNAPSHOT_KEEP` | `14` | Daily snapshots to keep. |
| `LOOSELEAF_MIRROR` | `on` | `off` stops the server writing `data/mirror/` (see Mirror). Any value other than `on` or `off` stops the server at start. |

The token keeps other devices on a private network (such as a tailnet) out.
It is not a substitute for TLS on a public network; put the server behind
`tailscale serve` or a TLS reverse proxy for that.

## Routes

| Route | Auth | Answer |
| --- | --- | --- |
| `GET /api/info` | none | `{ "name": "looseleaf", "version": "…", "protocol": 1 }` |
| `GET /api/health` | none | `{ "ok": true }` |
| `GET /api/blobs` | bearer | `{ "blobs": ["<sha256>", …] }` |
| `GET /api/blobs/<sha256>` | bearer | The bytes, or 404. |
| `PUT /api/blobs/<sha256>` | bearer | 201 stored, 200 already stored, 400 when the bytes do not hash to the name, 413 past the size limit. |
| `POST /mcp` | bearer | The MCP endpoint (see MCP endpoint). `GET` and `DELETE` answer 405. |
| `GET /sync` | token in the hello | The WebSocket sync endpoint; see "Wire protocol" in `docs/architecture.md`. A bad token closes with 4401; an app older than the server's content version closes with 4426, or 4400 for builds that send none. |
| anything else | none | The web client's files, `index.html` for unknown paths. |

Every response carries `Access-Control-Allow-Origin: *`, so the desktop app's
`app://` origin and any browser origin can reach it; the token is the gate.

## Data folder

```
data/
  token                   access token, when generated
  docs/<docId>/snapshot   one merged Yjs update, replaced by atomic rename
  docs/<docId>/log        updates since the snapshot: [u32 length][u32 crc32][bytes], little-endian
  docs/<docId>/*.corrupt-<time>  damaged bytes set aside on read; safe to delete
  blobs/<aa>/<sha256>     blob bytes; aa is the hash's first two hex digits
  snapshots/<yyyy-mm-dd>/ daily copies of docs/ and blobs/ (blobs hard-linked)
  mirror/                 every page as a Markdown file (see Mirror)
  tmp/                    partial writes; emptied at startup
  corkboard-import.json   left by a Corkboard import; see Importing a Corkboard board
```

Doc ids are percent-encoded for folder names. Lowercase letters, digits, `-`
and `_` stay as they are; every other byte, uppercase letters included, is
`%XX`, so `pg:Ab` is stored as `pg%3A%41b`. Two ids that differ only in case
never share a folder, even on a case-insensitive file system.

Every log append is fsynced before the update is relayed to other devices,
and snapshots and blobs are written to `tmp/`, fsynced and renamed into
place. A log record with a wrong length or checksum, or whose bytes are not a
Yjs update, ends the log: it and everything after it are moved to
`log.corrupt-<time>` beside the log and the log is truncated. A snapshot that
is not a readable Yjs update is renamed to `snapshot.corrupt-<time>`. Either
way the next handshake with any device restores what was lost, and the
set-aside files stay for inspection. A doc the server cannot read or store at
all is logged and skipped; every other doc keeps syncing.

A doc's log is merged into its snapshot once it holds more than 200 records
(`LOG_COMPACT_AFTER_RECORDS` in `src/hub.ts`). Up to 500 docs stay loaded in
memory (`DOC_CACHE_SIZE`); the least recently used idle ones are dropped.

Plain files mean the folder can be backed up with rsync, restic or a ZFS
snapshot while the server runs.

## Mirror

The server keeps `data/mirror/`: every live page as a Markdown file, readable
by any editor or search tool while Looseleaf is not running.

```
mirror/
  .looseleaf-mirror.json                     the mirror manifest: every page and file the mirror owns
  assets/<sha256>.<ext>                      pictures and attached files, shared by every page
  <Notebook>/<Section group>/<Section>/<Page>.md
```

Names follow the Markdown export. Each page file starts with YAML front matter
(`id`, `notebook`, `section`) followed by the page as the Markdown export
writes it. A picture whose blob the server does not hold yet is written as
`[Missing picture: …]` and replaced once the blob is uploaded.

The mirror is read-only: the server overwrites a page's file when the page
changes, about 5 seconds after the last edit to it, and nothing in the folder
is read back into the notes. The server removes only files the manifest lists
and folders that are left empty, so other files placed in `mirror/` stay.
Deleting `mirror/` is safe; the server writes it again at its next start,
which also checks every page against the manifest. Snapshots do not copy
`mirror/`. A mirror that cannot be written is logged and tried again at the
next change; syncing carries on. `LOOSELEAF_MIRROR=off` turns it off; the
folder is then neither written nor removed.

## Boards

A notebook can have a kanban board (`board:<notebookId>` in `docs/`). Two
replicas that were apart can give two cards on a board the same number, two
boards the same key, or one To Do line two card links. After every change it
stores, and for board docs once at start, the server repairs these: the card
or board created first keeps its number or key and the others get new ones,
and a line keeps its first card link. A number or key only one card or board
uses is never changed. Repairs are ordinary changes, so they reach every
connected device.

The server also keeps an index of every page's To Do lines, for the Inbox and
checklists in the board tools. It is built in the background at start, which
takes from half a second to about 25 seconds for 1,900 pages depending on how
much is on them; a board tool called before it is built waits for it. A
stored change only marks the page, which is read again at the next board read.

## Importing a Corkboard board

`server.js import-corkboard` moves one board from a Corkboard server's data
folder into one Looseleaf notebook that has no board yet. The Corkboard
folder is only read; mount it read-only where you can.

Before the real run:

- Stop the Looseleaf server: the import writes its data folder, and a running
  server would neither see those writes nor send them to devices.
- Stop the Corkboard server: it compacts a doc's log into its snapshot while
  running, and a compaction during the read can hide its most recent changes
  from the import.
- Let every device finish syncing with both servers, then close the apps (or
  leave the devices alone) until the Looseleaf server is back.
- Copy the Looseleaf data folder. It is the way back from an import that stops
  part way.

A dry run reads only, and can run with both servers up.

| Argument | Meaning |
| --- | --- |
| `--corkboard <folder>` | The Corkboard server's data folder, the one holding `docs/` and `blobs/`. |
| `--board <key or name>` | The Corkboard board. May be left out when Corkboard has one board. |
| `--notebook <id or name>` | The Looseleaf notebook. A name two notebooks share is refused, with both ids listed. |
| `--ties <file>` | Optional label ties, as JSON: `{ "Label name": "Section name" }`, or `"Group / Section"` for a section inside groups. |
| `--dry-run` | Does everything in memory and writes nothing to either folder. |
| `--report <file>` | Where the JSON report goes. Without it, beside the data folder, named `corkboard-import-…json`. |

The Looseleaf data folder is `LOOSELEAF_DATA`, as for the server.

What it does, card by card in board order (archived cards included):

- A card with a `looseleaf:<page id>` link whose page is live in the
  notebook becomes that page: the first such link names it and the others
  stay links. A page more than one card links to becomes none of their
  pages: each of those cards gets a new page and keeps its link, even when a
  later link on it names a free page, and the report lists the page with the
  refs that share it. A link to a page that is deleted, in another notebook or
  nowhere stays a link, and the report says why.
- Any other card gets a new page whose id is the card's Corkboard id, filed
  in the section tied to its first label in label order, else in the Unfiled
  section.
- The page takes the card's title. When an adopted page had another title,
  the line `Title before the Corkboard import: <old title>` is written on the
  page. That line, the description (as rich text, unless the page's text
  already holds it, comparing with whitespace collapsed) and the checklist as
  To Do lines with their ticks go into one new text container below the
  page's content, and each attachment into a picture or file container below
  that, its blob copied and its hash checked. No container already on an
  adopted page is written to, so a device that deletes one while apart takes
  none of the imported text with it.
- The board gets Corkboard's key, statuses and labels with their ids, names,
  kinds, colours, order and archived times, and each card its number, status,
  place, labels, due day, comments, remaining links, activity and times
  exactly. The board's created time is the time of the import, and the
  imported To Do lines are tagged at that time, so none of them reaches the
  Inbox.

It refuses, writing nothing, when the board or notebook is not found, the
notebook already has a board, another board in the data folder has the key,
a tie names a label or section that is not there, two cards share a number,
a doc in either folder ends in a damaged record, an earlier import did not
finish, or the data folder already holds a page or page doc with an id this
import would give a new page (as an earlier import that stopped part way
leaves them). Each refusal says what to do and exits with code 2.

It prints a report and saves it as JSON: cards per status in Corkboard and in
the result, every ref with its page id and whether the page was adopted or
new, titles it replaced, pages several cards link to, links not adopted and
why, descriptions already on
their page, attachments whose blob Corkboard did not hold, and the totals of
cards, comments, links, checklist items, attachments and activity entries on
both sides. The check works from Corkboard's board and the data folder alone:
every field of every card, every page adopted before keeping exactly what it
held, every link a card lost naming that card's page, every replaced title
written on its page, and every total equal (links net of the one each adopted
page replaces). A real run reads the data folder again from disk for it; a
difference is listed and the command exits with code 1. A dry run's report is the real run's, page ids included.

A real run writes `data/corkboard-import.json` before its first write and
marks it `finished` once the check passes. While it says anything else (an
import stopped part way, or one whose check found differences) the server
refuses to start and a new import refuses to run. Restore the copy of the
data folder made before the import, then run it again.

From a checkout, with absolute paths (`exec` runs in `packages/server`):

```sh
cp -a /srv/looseleaf/data /srv/looseleaf/data.before-import
LOOSELEAF_DATA=/srv/looseleaf/data pnpm --filter @looseleaf/server exec tsx src/main.ts import-corkboard \
  --corkboard /srv/corkboard/data --board DEE --notebook "Work" --ties /srv/ties.json --dry-run
LOOSELEAF_DATA=/srv/looseleaf/data pnpm --filter @looseleaf/server exec tsx src/main.ts import-corkboard \
  --corkboard /srv/corkboard/data --board DEE --notebook "Work" --ties /srv/ties.json
```

`node dist/server.js import-corkboard …` runs the same from the bundle.

With the published image, the data volume is mounted at `/data` and the
Corkboard folder read-only. A dry run can mount the data volume read-only too.
The report folder must be writable by uid 1000, the image's `node` user.
Compose names the volume `<project>_looseleaf-data`; `docker volume ls` shows
it.

```sh
docker compose stop looseleaf
docker compose -f /srv/corkboard/docker-compose.yml stop corkboard
docker run --rm -v looseleaf_looseleaf-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/looseleaf-data-before-import.tgz -C /data .
docker run --rm -v looseleaf_looseleaf-data:/data:ro -v /srv/corkboard/data:/corkboard:ro \
  -v "$PWD/ties.json":/ties.json:ro -v "$PWD/reports":/reports ghcr.io/trapp01/looseleaf:latest \
  node server.js import-corkboard --corkboard /corkboard --board DEE --notebook "Work" --ties /ties.json \
  --dry-run --report /reports/dry-run.json
docker run --rm -v looseleaf_looseleaf-data:/data -v /srv/corkboard/data:/corkboard:ro \
  -v "$PWD/ties.json":/ties.json:ro -v "$PWD/reports":/reports ghcr.io/trapp01/looseleaf:latest \
  node server.js import-corkboard --corkboard /corkboard --board DEE --notebook "Work" --ties /ties.json \
  --report /reports/import.json
docker compose start looseleaf
```

A Corkboard data folder in a named volume mounts the same way, by its volume
name, with `:ro`. To put the copy back after a failed import:

```sh
docker run --rm -v looseleaf_looseleaf-data:/data -v "$PWD":/backup alpine \
  sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/looseleaf-data-before-import.tgz -C /data'
```

## MCP endpoint

`POST /mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over streamable HTTP, so an AI assistant can search and read the notes, add
to them and work the boards. It is stateless and answers every request with
plain JSON: no sessions and no event stream. It takes the same bearer token
as the blob routes. A request body may be up to 64 KB.

The notes read tools read the mirror and nothing else; with
`LOOSELEAF_MIRROR=off` they answer that the mirror is off, and every other
tool works. The write tools change the notes the way a connected client
would: the change is stored, sent to every connected device, and shows in the
mirror (and so in the read tools) about 5 seconds later. They only add;
nothing already in the notes is changed, moved or removed. The board tools
read and change the docs directly, so they show a change at once.

The `initialize` reply carries instructions that tell an agent to write what
outlasts a task (a plan, a finding, a decision) to a page without being asked,
and to keep the board true while it works: find or make the task's card, move
it to a `doing` status, tick its To Do lines and comment as it goes, and
comment what was done and what is left when it stops.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_notebooks` | none | Every notebook with its id and its sections, each with its id and page count. A section inside groups is shown as `Group / Section`. Notebooks and sections with no pages are not listed. |
| `list_pages` | `section_id` | The section's pages in order, with ids, titles and subpage levels. |
| `search_notes` | `query`, `notebook_id` (optional), `limit` (optional, default 20, at most 100) | Pages whose title or text holds every word of the query, ignoring case: pages with every word in the title first, then by number of occurrences. Each result has the page id, title, notebook, section and up to 3 matching lines. |
| `read_page` | `page_id` (a page id, a page address or a card ref) | The page's mirror file: front matter, then the page as Markdown. Pictures and attached files stay as links to `mirror/assets/`. |
| `create_page` | `section_id`, `title`, `markdown` (optional) | Adds a top-level page at the end of the section, with the Markdown in one text container (no container without it), and answers with its page id, notebook and section. |
| `append_to_page` | `page_id` (a page id, a page address or a card ref), `markdown` | Adds the Markdown after the end of the page's last text container in reading order, or in a new text container below everything else when the page has none, and marks the page modified. |
| `list_boards` | none | Every board: its notebook, key, statuses with their kinds and card counts, and labels. |
| `get_board` | `board`, `status`, `label` (all optional) | The Inbox (each line with its page and line id), then every status with its cards, top first. Narrowed to a status or a label, without the Inbox. |
| `search_cards` | `query`, `board`, `status`, `label`, `due_by`, `include_archived`, `limit` (all optional; default 25, at most 100) | Cards whose title, page, labels, comments or links hold every word, title matches first. |
| `get_card` | `card` | The card: status, position, labels, due day, its page as Markdown read from the doc, its To Do lines with line ids, links, comments and activity. The Id line is the page id. |
| `create_card` | `board`, `title`, `line`, `description`, `status`, `place`, `labels`, `due`, `checklist`, `links`, `author` (`title` or `line` needed) | Makes the page and the card, filed by its first tied label or in the Unfiled section. With `line`, turns that To Do line into the card. |
| `update_card` | `card`, `title`, `due`, `add_labels`, `remove_labels`, `author` | Changes the page title, due day and labels. |
| `update_checklist` | `card`, `check`, `uncheck`, `add` | Ticks and unticks To Do lines on the card's page (by line id or exact text) and adds new ones. It removes none. |
| `move_card` | `card`, `status`, `place`, `position`, `author` | Moves the card to a status (by name or kind), at the bottom unless placed. |
| `add_comment` | `card`, `body`, `author` | Adds a comment. |
| `add_link` | `card`, `target`, `title` | Links the card to an http(s) address or a page (`looseleaf:<page id>`). |
| `archive_card` | `card`, `restore`, `author` | Archives the card, or restores it. |
| `create_status` | `board`, `name`, `kind`, `position` | Adds a status. |
| `create_label` | `board`, `name`, `color`, `section` | Adds a label, tied to a section when one is given. |
| `create_board` | `notebook`, `key` | Makes the notebook's board with the default statuses; a notebook that has one answers with an error. |

A card is named by its ref (`DEE-12`), its page id or its page address; a
board by its key or its notebook's name, and may be left out when there is
only one. No tool deletes a card, a status, a board or a To Do line. A mistake
the caller can fix answers with `isError` and a sentence saying what to do
next.

The write tools read the Markdown the Markdown export writes: paragraphs,
headings, bullet and ordered lists with nesting, `- [ ]` and `- [x]` to-do
items (the To Do tag), `[Important]`-style tag markers, bold, italic, strike,
`<u>`, `<sub>`, `<sup>`, links, `>` quotes and fenced code (the quote and code
paragraph styles), pipe tables and hard line breaks. Inline code keeps its
text without a code mark, since the editor has none; an ordered list always
starts at 1; pictures cannot be added. Anything else stays as plain text.

Results are text written for a model to read, and always carry the ids the
next call needs. `search_notes` reads the mirror's files on each call. While
the server's start-up check of the mirror is still running, the notes read
tools answer that the mirror is being built.

To connect Claude Code:

```sh
claude mcp add --transport http looseleaf http://<your-server>:8421/mcp --header "Authorization: Bearer <token>"
```

An assistant that connects from its vendor's cloud rather than from your own
machine cannot reach a server on a private network.

## Snapshots and restore

At startup, and then hourly, the server checks for today's snapshot (server
local date) and writes `snapshots/<yyyy-mm-dd>/` when it is missing, keeping
the newest `LOOSELEAF_SNAPSHOT_KEEP`. Each doc's snapshot and log are copied
together, between that doc's writes, so a dated copy never holds half of a
compaction.

To restore a snapshot, stop the server, then from the folder that holds
`data/` run (with the date you want):

```sh
DAY=2026-11-14; mv data/docs data/docs.before-restore && mv data/blobs data/blobs.before-restore && cp -a data/snapshots/$DAY/docs data/snapshots/$DAY/blobs data/
```

With the compose file's named volume, run the same command inside the volume:

```sh
docker compose stop looseleaf
docker compose run --rm --no-deps --entrypoint sh looseleaf -c 'DAY=2026-11-14; cd /data && mv docs docs.before-restore && mv blobs blobs.before-restore && cp -a snapshots/$DAY/docs snapshots/$DAY/blobs ./'
docker compose start looseleaf
```

Then start the server. Each device's next handshake sends back everything it
holds that the snapshot lacks, so a restore recovers lost data and never
removes edits a device still has. To make the snapshot the only state, clear
the local data of every device before it reconnects. Delete the
`*.before-restore` folders once the restore looks right.

A lost server needs no snapshot at all: start an empty one with the same
token, and the devices fill it on their next handshake.
