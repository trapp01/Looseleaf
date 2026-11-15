# @looseleaf/desktop

The Looseleaf desktop app: an Electron shell that hosts the built web client
(`packages/web`) unchanged. It owns the window, the native menu bar, file and
folder dialogs, PDF output and read-only access to OneNote backup files. It
knows nothing about notes. The web client talks to it only through
`window.looseleafShell`, declared in `packages/web/src/shell-bridge.ts`.

## Layout

| File | Owns |
| --- | --- |
| `src/main.ts` | App lifecycle, the window, the `app://` protocol, permissions, navigation guards, IPC registration. |
| `src/preload.ts` | Sets `window.looseleafShell` in the sandboxed page. |
| `src/ipc.ts` | What each bridge call does: argument checks, folder grants, the work. No Electron imports. |
| `src/onenote-files.ts` | Finding, listing and reading `.one` / `.onetoc2` files. Read-only. |
| `src/web-client.ts` | The `app://looseleaf` origin and how a URL path maps to a built file. |
| `src/menu.ts` | The menu bar template. |
| `src/window-state.ts` | Remembered window size and position. |
| `src/channels.ts` | IPC channel names shared by main and preload. |
| `scripts/smoke.ts` | Launches the shell against a stub page and checks it from inside. |
| `build/` | The app icon: `icon.svg` is the source, `icon.png` and `icon.icns` are generated from it. |

## Run

```sh
pnpm --filter @looseleaf/web build      # the shell serves packages/web/dist
pnpm --filter @looseleaf/desktop dev     # builds main + preload, starts Electron
```

Against the Vite dev server instead of the built files:

```sh
LOOSELEAF_WEB_URL=http://localhost:5173 pnpm --filter @looseleaf/desktop dev
```

Environment variables, read only when the app is not packaged:

| Variable | Effect |
| --- | --- |
| `LOOSELEAF_WEB_URL` | Load this URL instead of `app://looseleaf/`. Its origin may call the bridge. |
| `LOOSELEAF_WEB_DIR` | Serve built files from this folder instead of `../web/dist`. Also read by `package`. |
| `LOOSELEAF_USER_DATA_DIR` | Keep the profile (IndexedDB, window state) in this folder. |

## Build, test, smoke

```sh
pnpm --filter @looseleaf/desktop build      # esbuild → dist/main.cjs, dist/preload.cjs
pnpm --filter @looseleaf/desktop test       # vitest, Node only
pnpm --filter @looseleaf/desktop typecheck
pnpm --filter @looseleaf/desktop smoke      # needs a desktop session
```

`smoke` launches Electron twice with a stub `index.html` and checks from the
page: the origin is `app://looseleaf`, it is a secure context, IndexedDB
persists across launches, `looseleafShell.kind` is `desktop`, `fetch` over
plain http and a `ws://` WebSocket reach a local server (by `localhost` and by a
name that is not loopback), Node globals are absent, and IPC refuses a folder
that was never chosen.

## Package

```sh
pnpm --filter @looseleaf/web build
pnpm --filter @looseleaf/desktop package
```

Output goes to `packages/desktop/out/`. On a Mac this makes
`Looseleaf-<version>-arm64.dmg` and a `.zip` for the Mac's own architecture;
add `--x64` or `--universal` to the command for others. Windows (NSIS installer and
zip) and Linux (AppImage and deb) targets are configured in
`electron-builder.config.cjs`; build each on its own platform or in CI.

electron-builder runs through `npx` at a pinned version and is not in the
lockfile. Adding it as a workspace dependency needs `electron-winstaller: false`
under `allowBuilds` in `pnpm-workspace.yaml`; without it pnpm refuses to run
scripts.

### Unsigned builds

The build is signed ad hoc, not with an Apple Developer ID, and is not
notarised. An app built on your own Mac opens normally. One that was downloaded
is quarantined, and macOS says "Looseleaf" Not Opened: Apple could not verify it
is free of malware. To open it:

- macOS 15 and later: open System Settings → Privacy & Security, find the
  message that Looseleaf was blocked, choose **Open Anyway** and confirm.
- macOS 14 and earlier: Control-click the app in Finder, choose **Open**, then
  **Open** in the dialog.
- Or clear the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Looseleaf.app`

On Windows, SmartScreen shows "Windows protected your PC" for an unsigned
installer: choose **More info**, then **Run anyway**.

The first time Looseleaf looks for OneNote backups on macOS 14 and later, macOS
asks whether Looseleaf may access data from other apps, because the backups live
inside OneNote's container.

### Signing and notarising

- **macOS**: an Apple Developer Program membership and a "Developer ID
  Application" certificate, in the keychain or given as `CSC_LINK` and
  `CSC_KEY_PASSWORD`. In `electron-builder.config.cjs` remove `identity: '-'` and
  set `hardenedRuntime: true`. For notarisation set either `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, or an App Store Connect API
  key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`); electron-builder
  then notarises and staples the app and dmg.
- **Windows**: a code-signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) or
  Azure Trusted Signing (`win.azureSignOptions`).

## Security model

- The page runs sandboxed with context isolation and no Node integration;
  `webSecurity` is on. `window.looseleafShell` is the only thing the preload adds.
- Every IPC handler checks that the calling frame is on `app://looseleaf` (or
  `LOOSELEAF_WEB_URL` in development) and checks each argument's type.
- OneNote files are opened with flag `'r'` and nothing in `onenote-files.ts`
  can write. Listing and reading work only inside a folder that the folder
  picker or the backup lookup returned in this session; paths with `..`,
  absolute paths and paths through symbolic links are refused.
- `app://looseleaf` is a secure context but, like other custom schemes in
  Chromium, does not block mixed content, so the web client can reach a
  plain-http server on a tailnet with `fetch` and `ws://`. CORS still applies.
- Every permission request is denied except clipboard read and write.
- The window never leaves the app's origin: links and `window.open` with
  http(s) or mailto open in the system browser, everything else is dropped, and
  `<webview>` is refused.
- Packaged builds flip Electron's fuses so the binary cannot run as plain Node,
  read `NODE_OPTIONS` or take inspector flags, and loads its code only from the
  app archive.

## Notes for the web client

- On macOS the window has no native title bar. The web client draws its
  36 px title bar and must leave about 80 px clear at its left edge for the
  window buttons when `looseleafShell.platform === 'darwin'`. The bar needs
  `-webkit-app-region: drag`, with `no-drag` on its buttons, for the window to be
  movable. Windows and Linux keep the native frame and menu bar.
- Menu items arrive through `onMenuCommand`. Undo, Redo, Find and the zoom
  items are commands, not native roles, so the web client handles them,
  including undo inside plain text fields. Cut, copy, paste and select all are
  native.
- Print… sends `print`; the web client prepares the page and calls
  `window.print()`.
- Service workers are not enabled for `app://`; the files are already local.
