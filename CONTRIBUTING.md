# Contributing

Thanks for wanting to help. Looseleaf is an early release, so there is plenty
to build.

## Where to start

- [docs/onenote-parity.md](docs/onenote-parity.md) lists every OneNote feature
  and whether it is built. Anything marked planned is open.
- Bugs and ideas go in [issues](https://github.com/trapp01/Looseleaf/issues).
  For anything larger than a small fix, open an issue before writing code so
  the approach is agreed first.

## Set up

Needs Node 22 and pnpm.

```sh
pnpm install
pnpm dev          # server on :8421 and the web client with hot reload
pnpm test
pnpm typecheck
pnpm --filter @looseleaf/web exec playwright install chromium   # once
pnpm --filter @looseleaf/web e2e                                # browser tests against a real server
```

Read [docs/architecture.md](docs/architecture.md) and
[docs/glossary.md](docs/glossary.md) first. The glossary's words are the ones
folders, types and interface text use.

## Rules

The project's rules are in [CLAUDE.md](CLAUDE.md), each with its reason. They
apply to people and to coding agents alike. The ones that matter most:

- **No real notes in the repo.** No `.one` files, no screenshots of someone's
  notes, no text copied from them into a test. Invent the content.
- **The `.one` reader comes from the published specifications only**
  ([MS-ONESTORE], [MS-ONE]). Do not work from OneNote's binaries or copy from
  another reader's code. If you have read OneNote's source or disassembly,
  please do not contribute to `packages/onenote`.
- **No OneNote artwork, icons, fonts or branding.**
- **A change to sync comes with a convergence test:** two replicas edit apart,
  reconnect, and end equal with both edits present.

## Pull requests

- One concern per pull request. A rename or a move goes in its own.
- `pnpm typecheck` and `pnpm test` pass, and the browser tests pass for a
  change to `web`, `sync` or `server`.
- Update `docs/onenote-parity.md` in the same change that builds or drops a
  feature.

## Licence

Looseleaf is under the [Mozilla Public License 2.0](LICENSE). By contributing
you agree that your contribution is licensed under it.

[MS-ONESTORE]: https://learn.microsoft.com/openspecs/office_file_formats/ms-onestore
[MS-ONE]: https://learn.microsoft.com/openspecs/office_file_formats/ms-one
