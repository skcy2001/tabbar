import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } from 'electron'
import path from 'path'
import { TabManager } from './tabs/TabManager'
import { DownloadManager } from './downloads'
import {
  createTabFromShortcut,
  dispatchTabAction,
  flushPinnedSitesSave,
  getCurrentSide,
  isContextMenuOpen,
  isShellCollapsed,
  openUrlInNewTab,
  openUrlPreferPinned,
  registerIpc,
  setContextMenuOpen,
  setCurrentSide,
  setPlacementChangedHandler,
  toggleCollapsedFromShortcut,
} from './ipc'
import { DEFAULT_PANE_WIDTH, DEFAULT_SIDE, RIBBON_WIDTH, type Side } from '../shared/types'
import { placeRibbonPane } from './windowPlacement'
import { displayNearestWindowCenter } from './windowAnchoring'
import { isSliding, settleSlide, slideTo } from './slide'
import { TRAY_ICON_PNGS } from './trayIconData'
import { LAUNCH_PROTOCOLS, urlFromArgv } from './urlLaunch'
import { loadShellPlacementState, saveShellPlacementState } from './shellState'
import {
  APPBAR_CALLBACK_MESSAGE,
  disableWindowShadow,
  handleCallback as handleAppBarCallback,
  disableWindowTransitions,
  releaseEdge,
  reserveEdge,
  squareWindowRegion,
} from './appbar'

/**
 * The Vite server to load the renderer from, handed over by the dev launcher.
 *
 * Its presence is what marks a run as development. `app.isPackaged` cannot do
 * that job — it is false for `npm start` as well, so that path went looking for
 * a dev server nobody had started and came up with blank windows.
 */
const DEV_SERVER_URL = (process.env.TABBAR_DEV_SERVER_URL || process.env.SIDEBAR_DEV_SERVER_URL)?.replace(/\/+$/, '') || null
const IS_DEV = DEV_SERVER_URL !== null

// Keep the original profile and single-instance identity through the rebrand.
app.setName('Tabbar')
app.setPath('userData', path.join(app.getPath('appData'), 'sidebar'))

// Only one sidebar may run: a second copy would fight over the screen edge,
// the tray, and the shared state files. Later launches hand their URL over.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

app.on('second-instance', (_event, argv) => {
  const url = urlFromArgv(argv)
  if (url) openLaunchUrl(url)
  else showShell()
})

let ribbonWindow: BrowserWindow | null = null
let paneWindow: BrowserWindow | null = null
let playerWindow: BrowserWindow | null = null
let playerTargetTabId: number | null = null
let playerHideTimer: NodeJS.Timeout | null = null
let playerAnchorBounds: Electron.Rectangle | null = null
let edgePeekWindow: BrowserWindow | null = null
let downloadsWindow: BrowserWindow | null = null
let tray: Tray | null = null
const downloadManager = new DownloadManager()
let isQuitting = false
let shellHidden = false
let shellPinned = loadShellPlacementState().pinned
let autoHideTimer: NodeJS.Timeout | null = null
/**
 * The ribbon's docked x while a slide owns the window. Mid-slide its own bounds
 * are somewhere between the dock and the parking spot, so this is the only
 * reliable record of where it belongs.
 */
let ribbonDockedX: number | null = null
let lastCursorInsideMs = Date.now()
/** When the cursor arrived at the docked edge, while hidden; null when it is away. */
let edgeDwellSinceMs: number | null = null
let isDraggingPlacement = false
const AUTOHIDE_GRACE_MS = 450
/** Width of the sliver left at the screen edge while the shell is hidden. */
const EDGE_PEEK_WIDTH = 2
/** How close to the docked edge the cursor must come to bring the shell back. */
const EDGE_TRIGGER_PX = 2
/**
 * How long the cursor has to stay at the edge before the shell returns.
 *
 * Without a dwell, anything that merely passes the edge — throwing the pointer
 * at a maximized window's scrollbar, crossing to the next monitor — drags the
 * sidebar out on top of it.
 */
const EDGE_DWELL_MS = 200
/**
 * Poll period for the auto-hide loop.
 *
 * It also sets how precisely the dwell above can be measured: the cursor's
 * arrival is only noticed on a tick, so a coarser poll would turn a 200ms dwell
 * into most of half a second. The work per tick is a cursor read and a couple
 * of rectangle tests.
 */
const AUTOHIDE_POLL_MS = 60
const PLAYER_WINDOW_WIDTH = 260
const PLAYER_WINDOW_HEIGHT = 336
const PLAYER_WINDOW_MIN_HEIGHT = 120
const PLAYER_RIBBON_GAP = 8
const PLAYER_TOP_LEVEL = 'pop-up-menu'
const DOWNLOADS_WINDOW_WIDTH = 320
const DOWNLOADS_WINDOW_HEIGHT = 380
const DOWNLOADS_REOPEN_GRACE_MS = 250
let downloadsHiddenAtMs = 0

// Fullscreen presents the active tab by growing the pane window to cover the
// display, rather than reparenting the WebContentsView into a separate window —
// moving a view mid-fullscreen makes Chromium drop out of fullscreen.
let tabsRef: TabManager | null = null
let syncLayoutRef: (() => void) | null = null
let fullscreenTabId: number | null = null
let fullscreenFromHtml = false

function isFullscreenActive() {
  return fullscreenTabId !== null
}

app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

function pointInBounds(point: { x: number; y: number }, bounds: Electron.Rectangle) {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  )
}

function rectFromNumbers(x: number, y: number, width: number, height: number): Electron.Rectangle | null {
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width <= 0 || height <= 0) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function isCursorInsidePlayerOrAnchor() {
  const pt = screen.getCursorScreenPoint()
  if (playerAnchorBounds && pointInBounds(pt, playerAnchorBounds)) return true
  if (
    playerWindow &&
    !playerWindow.isDestroyed() &&
    playerWindow.isVisible() &&
    pointInBounds(pt, playerWindow.getBounds())
  ) {
    return true
  }
  return false
}

function isCursorInsideShell() {
  const pt = screen.getCursorScreenPoint()
  // Auto-hide is only for collapsed (ribbon-only) mode.
  const wins = isShellCollapsed()
    ? [ribbonWindow, playerWindow].filter((w): w is BrowserWindow => !!w && !w.isDestroyed() && w.isVisible())
    : []
  for (const w of wins) {
    if (pointInBounds(pt, w.getBounds())) return true
  }
  return false
}

/** True when the cursor is in the trigger band at the shell's docked edge. */
function isCursorAtDockEdge(): boolean {
  if (!ribbonWindow || ribbonWindow.isDestroyed()) return false
  const pt = screen.getCursorScreenPoint()
  const { workArea: wa } = displayNearestWindowCenter(ribbonWindow)
  if (pt.y < wa.y || pt.y >= wa.y + wa.height) return false
  return getCurrentSide() === 'left'
    ? pt.x <= wa.x + EDGE_TRIGGER_PX
    : pt.x >= wa.x + wa.width - 1 - EDGE_TRIGGER_PX
}

function startAutoHideLoop() {
  if (autoHideTimer) return
  autoHideTimer = setInterval(() => {
    if (isFullscreenActive()) return
    if (shellPinned) return
    if (isDraggingPlacement) return
    // Mid-slide the ribbon's bounds are in motion, so a cursor hit test against
    // them means nothing. The slide's own completion decides what happens next.
    if (isSliding()) return
    if (isContextMenuOpen()) return
    if (!ribbonWindow || ribbonWindow.isDestroyed()) return

    // While hidden, this poll is also what brings the shell back. Hovering the
    // 2px strip was the old trigger and missed too often: it is a fragile
    // target, and it was positioned from persisted state, so it could sit on a
    // different display than the ribbon. The cursor itself cannot be wrong.
    if (shellHidden) {
      if (!isCursorAtDockEdge()) {
        edgeDwellSinceMs = null
        return
      }
      if (edgeDwellSinceMs === null) edgeDwellSinceMs = Date.now()
      else if (Date.now() - edgeDwellSinceMs >= EDGE_DWELL_MS) showShell()
      return
    }

    if (!ribbonWindow.isVisible()) return
    if (!isShellCollapsed()) return

    const inside = isCursorInsideShell()
    if (inside) {
      lastCursorInsideMs = Date.now()
      return
    }

    const elapsed = Date.now() - lastCursorInsideMs
    if (elapsed >= AUTOHIDE_GRACE_MS) {
      hideShell()
    }
  }, AUTOHIDE_POLL_MS)
}

/**
 * Where the ribbon parks while hidden: one full width past its docked x, so it
 * clears the screen edge whichever side it is docked to.
 */
function ribbonParkedX(dockedX: number, width: number, side: Side) {
  return side === 'left' ? dockedX - width : dockedX + width
}

/** The pane and the player follow the ribbon in, once it has landed. */
function finishReveal() {
  if (paneWindow && !paneWindow.isDestroyed() && !isShellCollapsed()) paneWindow.show()
  raisePlayerWindow()
}

function showShell() {
  shellHidden = false
  edgeDwellSinceMs = null
  if (edgePeekWindow && !edgePeekWindow.isDestroyed()) edgePeekWindow.hide()
  lastCursorInsideMs = Date.now()
  startAutoHideLoop()

  const ribbon = ribbonWindow
  if (!ribbon || ribbon.isDestroyed()) {
    finishReveal()
    return
  }

  const bounds = ribbon.getBounds()
  const dockedX = ribbonDockedX ?? bounds.x
  ribbonDockedX = dockedX
  // Fully hidden: park off-screen first so there is a distance to cover.
  // Mid-retreat: the window is already somewhere out there, so just reverse.
  if (!ribbon.isVisible()) {
    ribbon.setBounds({ ...bounds, x: ribbonParkedX(dockedX, bounds.width, getCurrentSide()) })
    ribbon.show()
  }
  slideTo(ribbon, dockedX, () => {
    ribbonDockedX = null
    finishReveal()
  })
}

function hideShell() {
  shellHidden = true
  if (paneWindow && !paneWindow.isDestroyed()) paneWindow.hide()
  hidePlayerNow()

  // The trigger strip goes up before the slide, not after it: it has to be live
  // while the ribbon is still retreating, or a cursor that comes straight back
  // has nothing to hit and the sidebar stays gone.
  ensureEdgePeekWindow()
  if (edgePeekWindow && !edgePeekWindow.isDestroyed()) {
    updateEdgePeekBounds()
    edgePeekWindow.showInactive()
  }

  const ribbon = ribbonWindow
  if (!ribbon || ribbon.isDestroyed() || !ribbon.isVisible()) return

  const bounds = ribbon.getBounds()
  const dockedX = ribbonDockedX ?? bounds.x
  ribbonDockedX = dockedX
  slideTo(ribbon, ribbonParkedX(dockedX, bounds.width, getCurrentSide()), () => {
    ribbonDockedX = null
    if (ribbon.isDestroyed()) return
    ribbon.hide()
    // Re-dock while hidden, so it is invisible: everything else — placement,
    // the cursor hit tests, the appbar strip — reads these bounds as the real
    // ones, and a later reveal has a docked x to park relative to.
    ribbon.setBounds({ ...bounds, x: dockedX })
  })
}

function toggleShellVisibility() {
  if (!ribbonWindow || ribbonWindow.isDestroyed()) return
  const visible = ribbonWindow.isVisible()
  if (visible) hideShell()
  else showShell()
}

function cancelPlayerHide() {
  if (!playerHideTimer) return
  clearTimeout(playerHideTimer)
  playerHideTimer = null
}

function hidePlayerNow() {
  cancelPlayerHide()
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.hide()
  playerAnchorBounds = null
  playerTargetTabId = null
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.webContents.send('player:target', null)
}

function hidePlayerSoon() {
  cancelPlayerHide()
  playerHideTimer = setTimeout(() => {
    playerHideTimer = null
    if (!isCursorInsidePlayerOrAnchor()) hidePlayerNow()
  }, 120)
}

function keepPlayerAndShellOpen() {
  cancelPlayerHide()
  showShell()
  lastCursorInsideMs = Date.now()
}

function raisePlayerWindow() {
  if (!playerWindow || playerWindow.isDestroyed() || !playerWindow.isVisible()) return
  playerWindow.setAlwaysOnTop(true, PLAYER_TOP_LEVEL)
  playerWindow.moveTop()
}

function resizePlayerWindowToContent(height: number) {
  if (!playerWindow || playerWindow.isDestroyed()) return
  const rawHeight = Math.ceil(Number(height))
  if (!Number.isFinite(rawHeight)) return

  const bounds = playerWindow.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: Math.floor(bounds.x + bounds.width / 2),
    y: Math.floor(bounds.y + bounds.height / 2),
  })
  const wa = display.workArea
  const nextHeight = clamp(rawHeight, PLAYER_WINDOW_MIN_HEIGHT, Math.max(PLAYER_WINDOW_MIN_HEIGHT, wa.height - 16))
  if (bounds.width === PLAYER_WINDOW_WIDTH && Math.abs(bounds.height - nextHeight) < 2) return

  const anchorCenterY = playerAnchorBounds
    ? playerAnchorBounds.y + playerAnchorBounds.height / 2
    : bounds.y + bounds.height / 2
  const nextY = clamp(Math.round(anchorCenterY - nextHeight / 2), wa.y, wa.y + wa.height - nextHeight)
  playerWindow.setBounds({ x: bounds.x, y: nextY, width: PLAYER_WINDOW_WIDTH, height: nextHeight }, false)
  raisePlayerWindow()
}

/**
 * Reserves desktop space for the ribbon while pinned, like the taskbar does.
 * Only the ribbon width is claimed, so expanding the pane never reflows other
 * windows. Placement is re-run afterwards because reserving changes the work area.
 */
function syncEdgeReservation() {
  if (process.platform !== 'win32') return
  // Reserving reads the ribbon's bounds to pick a display, so land any slide
  // first rather than claim a strip from a position it is only passing through.
  settleSlide()
  if (!shellPinned || !ribbonWindow || ribbonWindow.isDestroyed()) {
    releaseEdge()
  } else {
    reserveEdge(ribbonWindow, getCurrentSide(), RIBBON_WIDTH)
  }
  syncLayoutRef?.()
}

/** Opens a URL that arrived from outside: the command line or a sidebar:// link. */
function openLaunchUrl(url: string) {
  if (isFullscreenActive()) exitFullscreen()
  openUrlPreferPinned(url, false)
  if (isShellCollapsed()) dispatchTabAction({ type:'toggleCollapsed' })
  showShell()
}

/**
 * Claims sidebar:// for this executable. The NSIS installer registers it too,
 * but doing it at runtime also covers the portable build and `npm run dev:full`.
 */
function registerProtocolClient() {
  for (const protocol of LAUNCH_PROTOCOLS) {
    if (app.isDefaultProtocolClient(protocol)) continue
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(protocol)
    } else {
      // Development launches also need the project path after electron.exe.
      app.setAsDefaultProtocolClient(protocol, process.execPath, [path.resolve(process.argv[1] ?? '.')])
    }
  }
}

function refreshTrayMenu() {
  tray?.setContextMenu(buildShellMenu({ includeShow: true }))
}

function toggleShellPinned() {
  shellPinned = !shellPinned
  saveShellPlacementState({ pinned: shellPinned })
  refreshTrayMenu()
  syncEdgeReservation()

  if (shellPinned) {
    showShell()
    return
  }

  lastCursorInsideMs = Date.now()
  startAutoHideLoop()
}

/**
 * Builds the tray image from the generated PNGs, one representation per DPI
 * scale so Windows picks a crisp bitmap at 100%, 150% and 200%.
 */
function createTrayImage() {
  const image = nativeImage.createEmpty()
  for (const { scaleFactor, dataURL } of TRAY_ICON_PNGS) {
    image.addRepresentation({ scaleFactor, dataURL })
  }
  // An empty image yields an invisible tray slot with no error at all, which is
  // how a corrupt embedded icon previously went unnoticed. Make it loud.
  if (image.isEmpty()) console.warn('[tray] icon image is empty; the tray icon will be invisible')
  return image
}

function ensureTray() {
  if (tray) return
  tray = new Tray(createTrayImage())
  tray.setToolTip('Tabbar')
  refreshTrayMenu()
  tray.on('click', () => toggleShellVisibility())
}

function buildShellMenu(options: { includeShow?: boolean } = {}) {
  return Menu.buildFromTemplate([
    ...(options.includeShow
      ? ([
          {
            label: 'Show Tabbar',
            click: () => {
              if (!isFullscreenActive()) showShell()
            },
          },
          { type: 'separator' as const },
        ] as const)
      : []),
    {
      label: shellPinned ? 'Unpin' : 'Pin',
      click: () => toggleShellPinned(),
    },
    ...(IS_DEV
      ? ([
          { type: 'separator' as const },
          {
            label: 'Open DevTools',
            click: () => {
              if (ribbonWindow && !ribbonWindow.isDestroyed()) ribbonWindow.webContents.openDevTools({ mode: 'detach' })
              if (paneWindow && !paneWindow.isDestroyed()) paneWindow.webContents.openDevTools({ mode: 'detach' })
              if (playerWindow && !playerWindow.isDestroyed()) playerWindow.webContents.openDevTools({ mode: 'detach' })
            },
          },
        ] as const)
      : []),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
}

/**
 * Strips the chrome Windows adds to a frameless window: the shadow DWM draws
 * even with hasShadow:false, the rounded corners Windows 11 gives every
 * top-level window, and the show/hide transitions it animates. Each window here
 * is meant to sit flush against the screen edge or against another window and
 * animates its own motion, so none of the three belongs. No-op off Windows.
 */
function flattenWindowChrome(win: BrowserWindow) {
  if (process.platform !== 'win32') return
  // What actually squares the corners is `roundedCorners: false` at creation —
  // Electron's own supported lever. This re-asserts it, and goes first, because
  // disabling non-client rendering just below can reset DWM's corner clip.
  const shadow = disableWindowShadow(win)
  const transitions = disableWindowTransitions(win)
  // The region is what actually squares the corners. Suppressing the shadow
  // above leaves DWM rounding them whatever the corner preference says, and a
  // region clips below that. It is fixed in the window's own pixels, so it has
  // to be redone whenever the window resizes.
  const region = squareWindowRegion(win)
  win.on('resize', () => squareWindowRegion(win))
  if (IS_DEV) console.log('[main] window chrome', { shadow, transitions, region })
}

function shellWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    backgroundThrottling: false,
    sandbox: false,
  } as const
}

function loadRenderer(win: BrowserWindow, role: 'ribbon' | 'pane' | 'player' | 'edge' | 'downloads') {
  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}/?role=${role}`).catch(error =>
      console.error('[main] failed to load dev URL', error),
    )
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'), { query: { role } }).catch(error =>
      console.error('[main] failed to load file', error),
    )
  }
}

function attachWebContentsDiagnostics(win: BrowserWindow, label: string) {
  const wc = win.webContents
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[main] ${label} did-fail-load`, { errorCode, errorDescription, validatedURL })
  })
  wc.on('render-process-gone', (_e, details) => {
    console.error(`[main] ${label} render-process-gone`, details)
  })
  wc.on('unresponsive', () => {
    console.error(`[main] ${label} renderer unresponsive`)
  })
  wc.on('responsive', () => {
    console.log(`[main] ${label} renderer responsive`)
  })
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    // level: 0=log,1=warn,2=error
    const tag = level === 2 ? 'error' : level === 1 ? 'warn' : 'log'
    console[tag](`[${label} console] ${message} (${sourceId}:${line})`)
  })
}

function usesPrimaryModifier(input: Electron.Input) {
  return process.platform === 'darwin'
    ? input.meta && !input.control
    : input.control && !input.meta
}

function handleShortcutInput(event: Electron.Event, input: Electron.Input) {
  if (input.type !== 'keyDown') return
  if (input.isAutoRepeat || input.isComposing) return

  // Unmodified keys, checked before the primary-modifier gate below.
  if (input.key === 'F11' && !input.control && !input.meta && !input.alt && !input.shift) {
    event.preventDefault()
    toggleFullscreenFromShortcut()
    return
  }

  // Only intercept Escape for our own fullscreen. When the page drove it,
  // Chromium handles Escape itself and emits leave-html-full-screen.
  if (input.key === 'Escape' && isFullscreenActive() && !fullscreenFromHtml) {
    event.preventDefault()
    exitFullscreen()
    return
  }

  if (!usesPrimaryModifier(input) || input.alt) return

  const key = input.key.toLowerCase()
  if (!input.shift && key === 't') {
    event.preventDefault()
    createTabFromShortcut()
    return
  }

  if (input.shift && key === 'e') {
    event.preventDefault()
    toggleCollapsedFromShortcut()
  }
}

function attachShellShortcuts(win: BrowserWindow) {
  win.webContents.on('before-input-event', handleShortcutInput)
}

function wireCloseTogether(ribbon: BrowserWindow, pane: BrowserWindow) {
  // With skipTaskbar enabled, default "close" UX is to hide to tray.
  ribbon.on('close', e => {
    if (isQuitting) return
    e.preventDefault()
    hideShell()
  })
  pane.on('close', e => {
    if (isQuitting) return
    e.preventDefault()
    hideShell()
  })
}

function createShell() {
  const persisted = loadShellPlacementState()
  const displays = screen.getAllDisplays()
  const display = persisted.displayId != null
    ? displays.find(d => d.id === persisted.displayId) ?? screen.getPrimaryDisplay()
    : screen.getPrimaryDisplay()
  const { workArea } = display
  const height = workArea.height
  const y = workArea.y

  const ribbonWin = new BrowserWindow({
    width: RIBBON_WIDTH,
    height,
    x: persisted.side === 'right' ? workArea.x + workArea.width - RIBBON_WIDTH : workArea.x,
    y,
    frame: false,
    roundedCorners: false,
    resizable: false,
    // Reposition only via renderer grip → `window:commitPlacement` on pointer release.
    movable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#1a1a2e',
    webPreferences: shellWebPreferences(),
  })

  const paneWin = new BrowserWindow({
    width: DEFAULT_PANE_WIDTH,
    height,
    x: workArea.x,
    y,
    frame: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#1a1a2e',
    webPreferences: shellWebPreferences(),
  })

  flattenWindowChrome(ribbonWin)
  flattenWindowChrome(paneWin)

  const tabManager = new TabManager(paneWin)
  tabManager.setBeforeInputHandler(handleShortcutInput)
  tabManager.setSessionHook(ses => downloadManager.attachSession(ses))
  tabManager.setNewTabRequestHandler((url, background) => {
    openUrlInNewTab(url, background)
    if (background) return
    // A link that opened a tab should be visible, even if we were hidden/collapsed.
    if (isShellCollapsed()) dispatchTabAction({ type: 'toggleCollapsed' })
    showShell()
  })
  tabManager.setHtmlFullscreenHandler((tabId, entering) => {
    if (entering) enterFullscreen(tabId, true)
    else exitFullscreen()
  })
  const { syncLayout } = registerIpc(ribbonWin, paneWin, tabManager, downloadManager)
  tabsRef = tabManager
  syncLayoutRef = syncLayout
  // Moving the ribbon to another edge or display has to re-register the appbar;
  // otherwise the reserved band stays behind where the ribbon used to be.
  setPlacementChangedHandler(syncEdgeReservation)

  setCurrentSide(persisted.side)
  shellPinned = persisted.pinned
  refreshTrayMenu()
  tabManager.setCollapsed(persisted.collapsed)
  placeRibbonPane(ribbonWin, paneWin, persisted.side, persisted.collapsed, DEFAULT_PANE_WIDTH, workArea)
  tabManager.createTab()

  paneWin.on('resize', () => {
    tabManager.relayout()
  })
  ribbonWin.on('show', raisePlayerWindow)
  paneWin.on('show', raisePlayerWindow)
  ribbonWin.on('focus', raisePlayerWindow)
  paneWin.on('focus', raisePlayerWindow)

  loadRenderer(ribbonWin, 'ribbon')
  loadRenderer(paneWin, 'pane')

  attachWebContentsDiagnostics(ribbonWin, 'ribbon')
  attachWebContentsDiagnostics(paneWin, 'pane')
  attachShellShortcuts(ribbonWin)
  attachShellShortcuts(paneWin)

  wireCloseTogether(ribbonWin, paneWin)

  if (process.platform === 'win32') {
    // Windows posts appbar notifications (taskbar moved, another appbar
    // appeared) to this app-defined message; re-assert our strip when it does.
    ribbonWin.hookWindowMessage(APPBAR_CALLBACK_MESSAGE, wParam => {
      const notification = wParam.length >= 4 ? wParam.readUInt32LE(0) : Number(wParam[0] ?? 0)
      if (handleAppBarCallback(notification, ribbonWin, getCurrentSide(), RIBBON_WIDTH)) {
        syncLayoutRef?.()
      }
    })
  }

  const onMetrics = () => syncLayout()
  screen.on('display-metrics-changed', onMetrics)

  ribbonWin.on('closed', () => {
    releaseEdge()
    screen.removeListener('display-metrics-changed', onMetrics)
    if (ribbonWindow === ribbonWin) ribbonWindow = null
  })
  paneWin.on('closed', () => {
    if (paneWindow === paneWin) paneWindow = null
  })

  return { ribbonWin, paneWin, syncLayout }
}

function ensureEdgePeekWindow() {
  if (edgePeekWindow && !edgePeekWindow.isDestroyed()) return edgePeekWindow
  const win = new BrowserWindow({
    width: EDGE_PEEK_WIDTH,
    height: 200,
    frame: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: shellWebPreferences(),
  })
  flattenWindowChrome(win)
  // Takes no input. Windows refuses to make a window as narrow as the strip we
  // ask for — it comes back about 64px wide — and the region that squares the
  // other windows does not apply to a transparent one. Docked right the surplus
  // hangs off the screen, but docked left it lies across the desktop as an
  // invisible band that swallows every click in it. Nothing needs to hover it
  // now that the auto-hide loop watches the cursor instead.
  win.setIgnoreMouseEvents(true)
  loadRenderer(win, 'edge')
  win.on('closed', () => {
    if (edgePeekWindow === win) edgePeekWindow = null
  })
  edgePeekWindow = win
  return win
}

function updateEdgePeekBounds() {
  if (!edgePeekWindow || edgePeekWindow.isDestroyed()) return
  // From where the ribbon actually is, not from persisted state: the two
  // disagree whenever the ribbon has moved display without a save landing, and
  // the strip would then mark an edge the sidebar is not on.
  const wa = ribbonWindow && !ribbonWindow.isDestroyed()
    ? displayNearestWindowCenter(ribbonWindow).workArea
    : screen.getPrimaryDisplay().workArea
  const x = getCurrentSide() === 'left' ? wa.x : wa.x + wa.width - EDGE_PEEK_WIDTH
  edgePeekWindow.setBounds({ x, y: wa.y, width: EDGE_PEEK_WIDTH, height: wa.height })
}

function enterFullscreen(tabId: number, fromHtml: boolean) {
  if (isFullscreenActive()) return
  if (!paneWindow || paneWindow.isDestroyed() || !tabsRef) return

  // Fullscreen hides the ribbon outright, so land any slide first rather than
  // leave a timer moving the window underneath it.
  settleSlide()

  // A background tab (e.g. audio playing elsewhere) must come forward first.
  if (tabsRef.getActiveTabId() !== tabId) dispatchTabAction({ type: 'activate', id: tabId })

  fullscreenTabId = tabId
  fullscreenFromHtml = fromHtml

  hidePlayerNow()
  if (ribbonWindow && !ribbonWindow.isDestroyed()) ribbonWindow.hide()
  if (edgePeekWindow && !edgePeekWindow.isDestroyed()) edgePeekWindow.hide()

  const bounds = paneWindow.getBounds()
  const display = screen.getDisplayNearestPoint({
    x: Math.floor(bounds.x + bounds.width / 2),
    y: Math.floor(bounds.y + bounds.height / 2),
  })

  // Borderless-fullscreen via bounds: setFullScreen is unreliable on a window
  // created non-resizable, and display.bounds covers the taskbar as well.
  paneWindow.setResizable(true)
  paneWindow.setBounds(display.bounds)
  if (!paneWindow.isVisible()) paneWindow.show()
  tabsRef.setFullscreen(true)
  paneWindow.focus()
}

function exitFullscreen() {
  if (!isFullscreenActive()) return
  fullscreenTabId = null
  fullscreenFromHtml = false

  if (tabsRef) tabsRef.setFullscreen(false)
  if (paneWindow && !paneWindow.isDestroyed()) paneWindow.setResizable(false)
  if (ribbonWindow && !ribbonWindow.isDestroyed()) ribbonWindow.show()
  // Restores the pane to the side/width/collapsed state it had before.
  syncLayoutRef?.()
  showShell()
}

function toggleFullscreenFromShortcut() {
  if (isFullscreenActive()) {
    exitFullscreen()
    return
  }
  const activeId = tabsRef?.getActiveTabId()
  if (activeId != null) enterFullscreen(activeId, false)
}

function ensureDownloadsWindow() {
  if (downloadsWindow && !downloadsWindow.isDestroyed()) return downloadsWindow
  const win = new BrowserWindow({
    width: DOWNLOADS_WINDOW_WIDTH,
    height: DOWNLOADS_WINDOW_HEIGHT,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#1a1a2e',
    show: false,
    webPreferences: shellWebPreferences(),
  })
  win.setAlwaysOnTop(true, PLAYER_TOP_LEVEL)
  loadRenderer(win, 'downloads')
  // Dismiss like a menu: clicking anywhere else closes it.
  win.on('blur', () => {
    if (win.isDestroyed()) return
    downloadsHiddenAtMs = Date.now()
    win.hide()
  })
  win.on('closed', () => {
    if (downloadsWindow === win) downloadsWindow = null
  })
  downloadsWindow = win
  return win
}

/** Anchors the downloads popover beside the pane, below the toolbar button. */
function toggleDownloadsPanel(screenX: number, screenY: number) {
  // Clicking the toolbar button while the popover is open blurs it first, so by
  // the time this runs it is already hidden. Without this guard it would
  // immediately reopen and the button could never close it.
  if (Date.now() - downloadsHiddenAtMs < DOWNLOADS_REOPEN_GRACE_MS) return

  const win = ensureDownloadsWindow()
  if (win.isVisible()) {
    downloadsHiddenAtMs = Date.now()
    win.hide()
    return
  }

  const display = screen.getDisplayNearestPoint({ x: Math.round(screenX), y: Math.round(screenY) })
  const wa = display.workArea
  const side = getCurrentSide()
  // Grow inward from the sidebar so the popover never runs off-screen.
  const x = side === 'right'
    ? Math.max(wa.x, Math.round(screenX) - DOWNLOADS_WINDOW_WIDTH)
    : Math.min(Math.round(screenX), wa.x + wa.width - DOWNLOADS_WINDOW_WIDTH)
  const y = clamp(Math.round(screenY), wa.y, wa.y + wa.height - DOWNLOADS_WINDOW_HEIGHT)

  win.setBounds({ x, y, width: DOWNLOADS_WINDOW_WIDTH, height: DOWNLOADS_WINDOW_HEIGHT })
  win.setAlwaysOnTop(true, PLAYER_TOP_LEVEL)
  win.show()
  win.focus()
}

function ensurePlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) return playerWindow
  const win = new BrowserWindow({
    width: PLAYER_WINDOW_WIDTH,
    height: PLAYER_WINDOW_HEIGHT,
    frame: false,
    roundedCorners: false,
    resizable: false,
    movable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#1a1a2e',
    webPreferences: shellWebPreferences(),
  })
  win.setAlwaysOnTop(true, PLAYER_TOP_LEVEL)
  flattenWindowChrome(win)
  loadRenderer(win, 'player')
  win.on('closed', () => {
    if (playerWindow === win) playerWindow = null
  })
  playerWindow = win
  return win
}

app.whenReady().then(() => {
  console.log('[main] app ready')
  if (!isPrimaryInstance) return
  ensureTray()
  ipcMain.on('shell:contextMenu', (e, clientX: number, clientY: number) => {
    const x = Math.round(Number(clientX))
    const y = Math.round(Number(clientY))
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const win = BrowserWindow.fromWebContents(e.sender)
    setContextMenuOpen(true)
    buildShellMenu().popup({
      window: win ?? undefined,
      x,
      y,
      callback: () => setContextMenuOpen(false),
    })
  })
  ipcMain.on('shell:show', () => {
    if (isFullscreenActive()) return
    showShell()
  })
  ipcMain.on('downloads:togglePanel', (_e, screenX: number, screenY: number) => {
    const x = Number(screenX)
    const y = Number(screenY)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    toggleDownloadsPanel(x, y)
  })
  ipcMain.on('downloads:closePanel', () => {
    if (downloadsWindow && !downloadsWindow.isDestroyed()) downloadsWindow.hide()
  })
  ipcMain.on('window:setDragging', (_e, dragging: boolean) => {
    isDraggingPlacement = Boolean(dragging)
    if (isDraggingPlacement) {
      // While dragging, keep the shell visible (avoids disappearing mid-gesture).
      showShell()
    } else {
      // Restart grace period after mouse up.
      lastCursorInsideMs = Date.now()
    }
  })

  ipcMain.handle('player:getTarget', () => playerTargetTabId)
  ipcMain.on(
    'player:show',
    (
      _e,
      tabId: number,
      screenX: number,
      screenY: number,
      anchorX: number,
      anchorY: number,
      anchorWidth: number,
      anchorHeight: number,
    ) => {
    const id = Number(tabId)
    if (!Number.isFinite(id)) return
    playerTargetTabId = id
    playerAnchorBounds = rectFromNumbers(
      Number(anchorX),
      Number(anchorY),
      Number(anchorWidth),
      Number(anchorHeight),
    )
    cancelPlayerHide()
    const x = Math.round(Number(screenX))
    const y = Math.round(Number(screenY))
    const win = ensurePlayerWindow()
    const ribbonBounds = ribbonWindow && !ribbonWindow.isDestroyed()
      ? ribbonWindow.getBounds()
      : null
    const side = getCurrentSide()
    const display = ribbonBounds
      ? screen.getDisplayNearestPoint({
          x: Math.floor(ribbonBounds.x + ribbonBounds.width / 2),
          y: Math.floor(ribbonBounds.y + ribbonBounds.height / 2),
        })
      : screen.getDisplayNearestPoint({ x, y })
    const wa = display.workArea
    const [w, h] = win.getSize()
    const preferredX = ribbonBounds
      ? side === 'right'
        ? ribbonBounds.x - w - PLAYER_RIBBON_GAP
        : ribbonBounds.x + ribbonBounds.width + PLAYER_RIBBON_GAP
      : x + PLAYER_RIBBON_GAP
    const px = Math.min(Math.max(wa.x, preferredX), wa.x + wa.width - w)
    const py = Math.min(Math.max(wa.y, y - Math.floor(h / 2)), wa.y + wa.height - h)
    win.setPosition(px, py, false)
    win.setAlwaysOnTop(true, PLAYER_TOP_LEVEL)
    win.showInactive()
    raisePlayerWindow()
    win.webContents.send('player:target', playerTargetTabId)
    },
  )
  ipcMain.on('player:hide', () => {
    hidePlayerSoon()
  })
  ipcMain.on('player:keepOpen', () => {
    keepPlayerAndShellOpen()
  })
  ipcMain.on('player:resize', (e, height: number) => {
    if (playerWindow && !playerWindow.isDestroyed() && e.sender !== playerWindow.webContents) return
    resizePlayerWindowToContent(Number(height))
  })
  ipcMain.on('player:openTarget', () => {
    if (playerTargetTabId == null) return
    dispatchTabAction({ type: 'activate', id: playerTargetTabId })
    if (isShellCollapsed()) dispatchTabAction({ type: 'toggleCollapsed' })
    showShell()
    hidePlayerNow()
  })

  app.on('before-quit', () => {
    isQuitting = true
    flushPinnedSitesSave()
    // An appbar left registered keeps the work area shrunk after we exit.
    releaseEdge()
  })
  const { ribbonWin, paneWin } = createShell()
  ribbonWindow = ribbonWin
  paneWindow = paneWin

  syncEdgeReservation()
  registerProtocolClient()

  // A URL on the command line means "open this", including on a cold start:
  // Windows delivers sidebar:// links as a trailing argument.
  const startupUrl = urlFromArgv(process.argv)
  if (startupUrl) openLaunchUrl(startupUrl)

  // Keep the auto-hide loop running for the lifetime of the app so collapse-mode
  // always re-enables hiding correctly, even after window show/hide cycles.
  startAutoHideLoop()

  // If we start hidden (e.g. user hid last session), the edge window will restore it.
  if (shellHidden) hideShell()

  screen.on('display-metrics-changed', () => {
    if (shellHidden) updateEdgePeekBounds()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createShell()
      ribbonWindow = next.ribbonWin
      paneWindow = next.paneWin
    }
  })
})

process.on('uncaughtException', error => {
  console.error('[main] uncaught exception', error)
})

process.on('unhandledRejection', reason => {
  console.error('[main] unhandled rejection', reason)
})

app.on('window-all-closed', () => {
  // Stay resident in the system tray (skipTaskbar apps should not quit when
  // windows are closed/hidden).
  if (process.platform !== 'darwin') return
  app.quit()
})
