# Looseleaf

An open-source, self-hosted notebook app laid out like OneNote. Local-first:
every device holds all the notes and syncs through a self-hosted server.

## Never

- Real notebooks never enter the repo: no `.one` files, no screenshots of
  someone's notes, no text copied from them in fixtures. The repo is public and
  notes are private.
- No OneNote icons, artwork or fonts, and the product's own name and branding
  never use the OneNote name. Naming OneNote to say what an import reads is
  fine. Copied assets would make the project unpublishable.
- The `.one` reader is written from Microsoft's published specifications
  ([MS-ONESTORE], [MS-ONE]), never from OneNote's binaries or another reader's
  code. That is what keeps it a clean implementation.
- Importing reads the source files and nothing else. A bug that writes to
  someone's OneNote folder destroys notes that may have no other copy.

## Every change

- Read `docs/architecture.md` and `docs/glossary.md` first (and
  `docs/boards.md` for boards and To Do lines), and use the glossary's words
  for folders, types and UI copy. Two names for one thing make
  every later search miss half the code.
- Anything that touches sync or a replica store ships with a convergence test:
  two replicas edit apart, reconnect, and end byte-for-byte equal with both
  edits present. Lost edits are the failure this project exists to prevent, and
  they do not show up in single-device tests.
- Client code works on a plain-http origin: no `crypto.subtle`, no
  `crypto.randomUUID`, service worker optional. A homelab address such as
  `http://nas:8421` is not a secure context.
- `model` and `sync` stay free of the DOM and of `node:` imports so they run in
  Node tests, browsers and a future mobile shell. The Packages table in the
  architecture doc says what each package owns and refuses to know; it is prose
  until a lint rule lands, and a violation is a review finding.
- `docs/onenote-parity.md` and `docs/board-parity.md` change in the same
  change that builds or drops a feature, so the list of what works stays true.
- A board is read and written through `packages/model` only (`model/src/board`
  and `model/src/todo-lines.ts`). No other package knows the board doc's
  layout or a To Do line's attributes.
- An MCP tool never deletes a card, a status, a board or a To Do line, and
  never rewrites text already in a page, except that turning a To Do line into
  a card replaces the line with a card link. Archiving is the one way off a board,
  so nothing an agent does is unrecoverable.
- `pnpm test` and `pnpm typecheck` from the root pass before a change is done.
  `pnpm --filter @looseleaf/web e2e` runs the browser tests against a real
  server; run it for any change to `web`, `sync` or `server`.
- A file past 500 lines is a signal to stop and ask whether it has a second job.

## Layout

pnpm workspace, TypeScript, vitest. Packages are consumed as TypeScript source
through the workspace; only `web`, `server` and `desktop` have a build. Folders
inside `packages/web/src` are by domain (nav, canvas, ribbon, search, …), not
by file type.

[MS-ONESTORE]: https://learn.microsoft.com/openspecs/office_file_formats/ms-onestore
[MS-ONE]: https://learn.microsoft.com/openspecs/office_file_formats/ms-one
