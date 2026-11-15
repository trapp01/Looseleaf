# @looseleaf/server

The self-hosted hub that every Looseleaf replica syncs through. It stores
docs and blobs on disk, runs the `/sync` WebSocket endpoint, takes a daily
snapshot of its data folder, and serves the built web client. HTTP and the
WebSocket share one port.

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
