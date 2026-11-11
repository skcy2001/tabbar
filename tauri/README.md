# Tabbar — Tauri 2

Windows version of Tabbar using Rust, Tauri 2, and the system WebView2 runtime.
It shares the original React interface in `../src` and the API contract in
`../shared`. Electron and Node are not shipped with the application.

## Features

- Original ribbon, pinned sites, drag reordering, drag across the divider to
  pin/unpin, unread badges, favicons, and URL/search toolbar.
- Separate ribbon and content windows, 220–900px draggable pane width, remembered
  width per site, left/right docking, and monitor placement by dragging the grip.
- Pinning to the desktop reserves the ribbon's width through Windows AppBar.
  The unpinned ribbon auto-hides on mouse-out and returns after a 100ms edge hover.
  Both directions use a 300ms eased slide, with a 100ms mouse-out delay.
  Slides stay clipped to their monitor, including edges shared with another display.
  While collapsed, clicking another window or losing focus does not dismiss it.
  An open pane stays visible until an outside click or until it is closed;
  moving the pointer away alone does not dismiss it.
- Native WebView2 tabs, persistent cookies, real history availability, reload,
  isolated login profiles, and per-site default/mobile/desktop user agents.
- Taskbar-style media player with album artwork or a video poster, title, play/pause, next
  track, and native mute. It slides in from the hovered tab over 300ms and uses
  Windows rounded corners and shadow. It dismisses on mouse-out, without a
  close button. The player does not capture or cache screenshots of the page.
  Empty players and recommendation previews do not open it. Loaded paused
  tracks can resume; unavailable actions are disabled and clicks run one at a time.
- Downloads panel with progress, cancellation, opening files, revealing files in
  Explorer, and clearing completed history. Downloads are tracked across profiles.
- Window fullscreen through the toolbar/menu, plus website/video fullscreen.
  Hover the docked screen edge to slide the ribbon over fullscreen content;
  moving back into the page hides it without moving or resizing the page.
- Sized popups retain `window.opener` and their parent profile for OAuth. Ordinary
  new-window links open in tabs.
- Native Windows context menus open inward from the original click position,
  with automatic vertical adjustment near the screen boundary.
- Tray controls, open in the default browser, single-instance handoff, and
  `tabbar://` links that select a matching pinned host when possible.
- Automatic import of Electron pins, site options, and dock settings.

Custom keyboard shortcuts are intentionally excluded from this migration.
Standard website and text-input behavior remains available. Open ordinary tabs
and download history are session-only, as in the original app.

## Build and run

Requires Windows WebView2, Node 20+, Rust stable MSVC, and Microsoft C++ Build
Tools with the Windows SDK and tools for the intended architecture.

```powershell
cd tauri
npm ci
npm run desktop       # Native development app and Vite
npm run build         # TypeScript and production UI assets
npm run check:native  # Native Rust check
npm run test:core     # Pure Rust behavior tests
npm run test:ui       # Shared UI tests in Edge with mocked native IPC
npm run bundle        # Release executable and NSIS installer
```

The release executable is `src-tauri/target/release/tabbar.exe`; an
explicit `--target` adds the target triple before `release`. The manually
triggered GitHub workflow builds unsigned Windows x64 and ARM64 installers.
The installer obtains WebView2 if needed instead of bundling Chromium.

This native integration currently targets Windows. macOS and Linux need their
own platform implementations. The multi-webview API is still marked unstable
by Tauri, so the Rust Tauri version and dependency lockfiles are pinned.

## Existing data

Settings live in `%APPDATA%/com.samya.sidebar.tauri/settings.json`. Browser data
lives in `%LOCALAPPDATA%/com.samya.sidebar.tauri`. On first start, the app merges
pins from `%APPDATA%/sidebar/pinned-sites.json` and imports the shell placement.
These legacy identifiers and partition names are intentionally retained across
the Tabbar rename to preserve settings, logins, and installer upgrade identity.
Electron's files remain intact.

To transfer existing cookies from the repository's Electron installation, close
Electron Tabbar, then run this from the repository root:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& node_modules/electron/dist/electron.exe tauri/scripts/import-electron-sessions.cjs
```

The helper reads cookies through Electron's own session API and stages Windows
DPAPI-encrypted transfer files. Tauri consumes each profile's transfer when that
profile is first opened, deletes the encrypted transfer, and writes only counts
to a migration report. Cookie values are not logged. IndexedDB, local storage,
and service workers do not transfer between engines; some sites may require a
new sign-in. Changing a site to an isolated profile likewise starts a separate
login session. Newly pinned tabs retain their existing shared login until
isolation is selected explicitly.

`tabbar://` and the legacy `sidebar://` alias are registered for the current
Windows user at startup. Launching an
HTTP(S) URL as a command-line argument also works. Register the Electron version
again if you later want it to handle that scheme.

## Security and size

Only the four bundled UI webviews receive native capabilities. Website and
popup webviews cannot call the shell commands, and browsing-state events are
sent only to the trusted interface. Website navigation is restricted to HTTP(S).
Profiles are derived from encoded partition names under the app's data folder.

Distribution size is much smaller because WebView2 is supplied by Windows.
This does not establish a RAM reduction: measure the complete app and WebView2
process tree with identical websites and profiles. Isolated profiles require
additional browser environments. The earlier 3.3MB measurement described the
incomplete prototype and should not be used for this restored build.

The test suite covers navigation/search safety, state selection, reordering,
unread parsing, deep-link routing, imported-pin UI, downloads controls, media
controls, fullscreen controls, and error handling. UI tests mock native IPC;
real Windows/WebView2 behavior also needs native integration checks.

The November 9, 2026 Windows ARM64 release passed 18 live integration checks:
imports, AppBar reservation, navigation/history, native capture, media controls,
website IPC denial, OAuth opener, window/HTML fullscreen, downloads/cancellation,
profile isolation, user agents, shared-cookie retention, widths, reordering,
auto-hide, and edge-hover reveal. That executable was 3,426,816 bytes.
Edge animations also passed movement traces on both sides, collapsed and
expanded, with no backward jumps, gaps between the windows, or movement after
settling at the edge.
