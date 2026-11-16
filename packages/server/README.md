# @looseleaf/server

The self-hosted hub that every Looseleaf replica syncs through. It stores
docs and blobs on disk, runs the `/sync` WebSocket endpoint, takes a daily
snapshot of its data folder, keeps a Markdown mirror of the notes, answers
AI assistants at an MCP endpoint, and serves the built web client. HTTP and
the WebSocket share one port.

## Running

| Command | Does |
| --- | --- |
| `pnpm --filter @looseleaf/server dev` | Runs `src/main.ts` with `tsx watch`. |
| `pnpm --filter @looseleaf/server build` | Bundles the server and its dependencies into `dist/server.js` with esbuild. |
| `pnpm --filter @looseleaf/server start` | Runs the bundle: `node dist/server.js`. |
| `docker compose up -d` | Builds the image from the repo root `Dockerfile` and runs it with a named volume. |

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
| `POST /mcp` | bearer | The MCP endpoint (see MCP endpoint). 404 with the mirror off; `GET` and `DELETE` answer 405. |
| `GET /sync` | token in the hello | The WebSocket sync endpoint; see "Wire protocol" in `docs/architecture.md`. A bad token closes with 4401. |
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

## MCP endpoint

`POST /mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over streamable HTTP, so an AI assistant can search and read the notes and add
to them. It is stateless and answers every request with plain JSON: no
sessions and no event stream. It takes the same bearer token as the blob
routes. The read tools read the mirror and nothing else, so the endpoint needs
the mirror on; with `LOOSELEAF_MIRROR=off` it answers 404. The write tools
change the notes the way a connected client would: the change is stored,
sent to every connected device, and shows in the mirror (and so in the read
tools) about 5 seconds later. They only add; nothing already in the notes is
changed, moved or removed. A request body may be up to 64 KB.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_notebooks` | none | Every notebook with its id and its sections, each with its id and page count. A section inside groups is shown as `Group / Section`. Notebooks and sections with no pages are not listed. |
| `list_pages` | `section_id` | The section's pages in order, with ids, titles and subpage levels. |
| `search_notes` | `query`, `notebook_id` (optional), `limit` (optional, default 20, at most 100) | Pages whose title or text holds every word of the query, ignoring case: pages with every word in the title first, then by number of occurrences. Each result has the page id, title, notebook, section and up to 3 matching lines. |
| `read_page` | `page_id` | The page's mirror file: front matter, then the page as Markdown. Pictures and attached files stay as links to `mirror/assets/`. |
| `create_page` | `section_id`, `title`, `markdown` (optional) | Adds a top-level page at the end of the section, with the Markdown in one text container (no container without it), and answers with its page id, notebook and section. |
| `append_to_page` | `page_id`, `markdown` | Adds the Markdown after the end of the page's last text container in reading order, or in a new text container below everything else when the page has none, and marks the page modified. |

The write tools read the Markdown the Markdown export writes: paragraphs,
headings, bullet and ordered lists with nesting, `- [ ]` and `- [x]` to-do
items (the To Do tag), `[Important]`-style tag markers, bold, italic, strike,
`<u>`, `<sub>`, `<sup>`, links, `>` quotes and fenced code (the quote and code
paragraph styles), pipe tables and hard line breaks. Inline code keeps its
text without a code mark, since the editor has none; an ordered list always
starts at 1; pictures cannot be added. Anything else stays as plain text.

Results are text written for a model to read, and always carry the ids the
next call needs. Search reads the mirror's files on each call. While the
server's start-up check of the mirror is still running, the tools answer that
the mirror is being built.

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
