# Tabbar — Status

The Windows Tauri 2 edition is implemented in `tauri/`. See
[its README](tauri/README.md) for current features and validation. The notes below
describe the earlier Electron implementation and its original roadmap.

## Electron history: Working Build

Both TypeScript configs compile clean. Vite renderer build succeeds. Electron main process compiled to `dist-electron/`.

Development launch now uses small Node scripts in `scripts/` to start Vite and launch Electron directly. This avoids Windows issues seen with the `concurrently` runner and Electron npm shim.

---

## How to Run

```bash
npm install          # first time only
npm run dev:full     # start Vite dev server + Electron app
```

`npm run dev:full` compiles Electron TypeScript, starts Vite on `http://localhost:5173`, waits for it to respond, then launches Electron.

## How to Build for Production

```bash
npm run build        # compiles renderer (Vite) + main process (tsc)
npm start            # launch from dist
```

---

## Features Implemented

- Electron + Vite + React + TypeScript scaffold
- Frameless window docked to left screen edge
- Collapse (56px icons) / Expand (420px) toggle
- Per-tab `WebContentsView` with isolated sessions
- Tab switching, create, close (auto-reopens if last)
- Favicon + title tracking per tab
- Toolbar: back / forward / reload
- URL bar with smart navigation (https auto-prefix, Google search fallback)
- Right-click tab to close; hover shows × button
- IPC bridge via `contextBridge` (no `nodeIntegration`)

---

## Known Limitations / Planned

- [x] Keyboard shortcuts: Ctrl+T creates a tab; Ctrl+Shift+E toggles collapse/expand
- [ ] No tab reordering (drag-and-drop)
- [ ] No bookmarks or history UI
- [ ] No multi-window / detach tab support
- [ ] Favicon images load from tab URL — may fail on restrictive CSPs
- [x] Electron Builder packaging configured for Windows (nsis + portable) and macOS (dmg + zip)
