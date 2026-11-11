import { ipcMain, BrowserWindow, Menu, screen, shell as electronShell } from 'electron'
import type { TabManager } from './tabs/TabManager'
import type { DownloadManager } from './downloads'
import {
  DEFAULT_PANE_WIDTH,
  USER_AGENT_PRESETS,
  type TabAction,
  type Side,
} from '../shared/types'
import { clampPaneWidth, placeRibbonPane } from './windowPlacement'
import { settleSlide } from './slide'
import { sideNearestToPoint } from './windowAnchoring'
import { loadShellPlacementState, saveShellPlacementState } from './shellState'

/**
 * Clicks a page's own "next track" control.
 *
 * Known player selectors are tried first, then a guarded scan. Two rules matter:
 * the control must be visibly rendered (players keep inert 0x0 buttons around,
 * and clicking one silently does nothing), and "forward" is never a match since
 * that is seeking ("Fast forward 30 seconds"), not skipping a track.
 */
const NEXT_TRACK_SCRIPT = `(() => {
  // Transport controls live in a player bar. A "Next" elsewhere on the page is
  // almost always a carousel arrow that scrolls a row of recommendations.
  const PLAYER_CONTAINERS = ['ytmusic-player-bar', '.ytmusic-player-controls', '.ytp-chrome-controls',
    '[data-testid="now-playing-bar"]', '.playControls', '[class*="player-controls"]',
    '[class*="playerControls"]', '[aria-label="Player controls" i]'];

  const KNOWN = ['ytmusic-player-bar .next-button', '.ytmusic-player-controls.next-button',
    '.ytp-chrome-controls .ytp-next-button', '[data-testid="control-button-skip-forward"]',
    '.playControls .skipControl__next', '[aria-label="Next track" i]', '[aria-label="Next song" i]'];

  // Rows of cards: their arrows are labelled "Next" but only scroll the row.
  const SHELVES = 'ytmusic-carousel-shelf-renderer, [class*="carousel"], [class*="shelf"],' +
    ' [class*="slider"], [role="list"], [role="listbox"], [role="tablist"]';

  const usable = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || el.getClientRects().length === 0) return false;
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if (el.classList && el.classList.contains("disabled")) return false;
    return !el.closest(SHELVES);
  };

  const labelFor = el => {
    const explicit = [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("data-testid")]
      .filter(Boolean).join(" ");
    if (explicit) return explicit.toLowerCase();
    const text = (el.textContent || "").trim();
    return text.length <= 24 ? text.toLowerCase() : "";
  };

  const NEGATIVE = ["previous", "prev", "rewind", "replay", "back", "fast forward",
    "fastforward", "seek", "skip navigation", "skip to", "skip ad", "advert",
    "next items", "next-items", "scroll", "page"];
  const POSITIVE = ["next", "skip"];
  const hasAny = (text, words) => words.some(word => text.indexOf(word) !== -1);

  const trace = [];
  const describe = (el, how) => {
    const r = el.getBoundingClientRect();
    return how + ' <' + el.tagName.toLowerCase() + '> label="' + labelFor(el) + '" cls="' +
      String(el.className || '').slice(0, 50) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height);
  };

  const pick = root => Array.from(root.querySelectorAll(
    'button, [role="button"], a[aria-label], [title], [data-testid]')).find(el => {
    if (!usable(el)) return false;
    const label = labelFor(el);
    if (!label || hasAny(label, NEGATIVE)) return false;
    if (hasAny(String(el.className || "").toLowerCase(), NEGATIVE)) return false;
    return hasAny(label, POSITIVE);
  });

  // 1. Exact, player-scoped selectors.
  for (const selector of KNOWN) {
    const el = document.querySelector(selector);
    if (el) trace.push(selector + (usable(el) ? " USABLE" : " rejected"));
    if (usable(el)) { el.click(); return describe(el, "CLICKED known " + selector); }
  }

  // 2. Anything next-ish, but only inside a player container.
  for (const selector of PLAYER_CONTAINERS) {
    const root = document.querySelector(selector);
    if (!root) continue;
    const el = pick(root);
    trace.push("container " + selector + (el ? " matched" : " no match"));
    if (el) { el.click(); return describe(el, "CLICKED in " + selector); }
  }

  // 3. Nothing player-shaped found. Do not fall back to the whole page: the only
  //    things left are carousel arrows, which scroll rows instead of skipping.
  return "NOTHING CLICKED; trace=" + JSON.stringify(trace) + " url=" + location.href;
})();`
let currentSide: Side = loadShellPlacementState().side
let contextMenuOpen = false

export function getCurrentSide(): Side { return currentSide }

export function flushPinnedSitesSave() {
  shell?.tabs.flushPinnedSitesSave()
}

export function setCurrentSide(side: Side) {
  currentSide = side
}

/**
 * Run after the dock side or display changes, so the appbar strip can follow.
 *
 * Placement alone is not enough while pinned: the reservation is registered
 * with the shell against one edge of one display, and moving the ribbon without
 * re-registering leaves the reserved band behind at the old position.
 */
let onPlacementChanged: (() => void) | undefined

export function setPlacementChangedHandler(handler: () => void) {
  onPlacementChanged = handler
}

export function isShellCollapsed(): boolean {
  return shell?.tabs.isCollapsed() ?? true
}

export function setContextMenuOpen(open: boolean) {
  contextMenuOpen = Boolean(open)
}

export function isContextMenuOpen(): boolean {
  return contextMenuOpen
}

type Shell = {
  ribbonWin: BrowserWindow
  paneWin: BrowserWindow
  tabs: TabManager
  downloads: DownloadManager
}

let shell: Shell | null = null
let detachTabState: (() => void) | undefined
let detachPinned: (() => void) | undefined
let detachDownloads: (() => void) | undefined
let ipcInstalled = false

function sendToShellWindows(ribbon: BrowserWindow, pane: BrowserWindow, channel: string, ...args: unknown[]) {
  const wcSend = (wc: Electron.WebContents) => {
    ;(wc.send as (ch: string, ...a: unknown[]) => void)(channel, ...args)
  }
  for (const win of [ribbon, pane]) {
    if (!win.isDestroyed()) wcSend(win.webContents)
  }
}

function applyPlacement(workArea?: Electron.Rectangle) {
  if (!shell) return
  // A show/hide slide owns the ribbon's x while it runs. Land it first so the
  // two are not setting bounds on the same window from different places.
  settleSlide()
  placeRibbonPane(
    shell.ribbonWin,
    shell.paneWin,
    currentSide,
    shell.tabs.isCollapsed(),
    shell.tabs.getActiveExpandedWidth(),
    workArea,
  )
}

function syncLayout() {
  if (!shell) return
  applyPlacement()
  shell.tabs.relayout()
}

function restoreActiveExpandedWidth() {
  if (!shell || shell.tabs.isCollapsed()) return
  applyPlacement()
  shell.tabs.relayout()
}

function collapseToRibbonOnly() {
  if (!shell) return
  const { ribbonWin: rw, paneWin: pw, tabs: t } = shell
  if (t.isCollapsed()) return
  t.setCollapsed(true)
  syncLayout()
  sendToShellWindows(rw, pw, 'window:collapsed', true)
}

function toggleCollapsed() {
  if (!shell) return
  const { ribbonWin: rw, paneWin: pw, tabs: t } = shell
  const nextCollapsed = !t.isCollapsed()
  t.setCollapsed(nextCollapsed)
  syncLayout()
  sendToShellWindows(rw, pw, 'window:collapsed', nextCollapsed)
  const b = rw.getBounds()
  const disp = screen.getDisplayNearestPoint({
    x: Math.floor(b.x + b.width / 2),
    y: Math.floor(b.y + b.height / 2),
  })
  saveShellPlacementState({ displayId: disp.id, side: currentSide, collapsed: nextCollapsed })
}

export function requestAddressFocus() {
  if (!shell) return
  sendToShellWindows(shell.ribbonWin, shell.paneWin, 'tabs:focusAddress')
}

export function createTabFromShortcut() {
  if (!shell) return
  const wasCollapsed = shell.tabs.isCollapsed()
  dispatchTabAction({ type: 'create' })
  if (wasCollapsed) dispatchTabAction({ type: 'toggleCollapsed' })
  requestAddressFocus()
}

export function toggleCollapsedFromShortcut() {
  dispatchTabAction({ type: 'toggleCollapsed' })
}

/**
 * Opens a URL that page content asked for (window.open / target=_blank).
 * Background tabs load without stealing the pane.
 */
export function openUrlInNewTab(url: string, background: boolean) {
  if (!shell) return
  const { paneWin: pw, tabs: t } = shell
  const width = t.isCollapsed() ? t.getActiveExpandedWidth() : getCurrentPaneWidth(pw)
  t.createTab(url, width, undefined, !background)
  if (!background) restoreActiveExpandedWidth()
}

/**
 * Routes a URL to the pinned site that already owns its host, falling back to
 * a new tab. Keeps an externally opened link inside the app it belongs to.
 */
export function openUrlPreferPinned(url: string, background: boolean) {
  if (!shell) return
  const siteId = shell.tabs.findPinnedSiteIdForUrl(url)
  if (siteId && shell.tabs.openInPinnedSite(siteId, url)) {
    restoreActiveExpandedWidth()
    return
  }
  openUrlInNewTab(url, background)
}

export function dispatchTabAction(action: TabAction) {
  if (!shell) return
  const { ribbonWin: rw, paneWin: pw, tabs: t } = shell

  switch (action.type) {
    case 'create':
      t.createTab(
        action.url,
        t.isCollapsed() ? t.getActiveExpandedWidth() : getCurrentPaneWidth(pw),
      )
      restoreActiveExpandedWidth()
      break
    case 'close':
      t.closeTab(action.id)
      if (t.getTabCount() === 0) collapseToRibbonOnly()
      else restoreActiveExpandedWidth()
      break
    case 'activate':
      t.activateTab(action.id)
      restoreActiveExpandedWidth()
      break
    case 'reorderTabs':
      t.reorderTabs(action.fromId, action.toId, action.before ?? true)
      break
    case 'navigate':
      t.navigate(action.url)
      break
    case 'back':
      t.back()
      break
    case 'forward':
      t.forward()
      break
    case 'reload':
      t.reload()
      break
    case 'toggleCollapsed':
      toggleCollapsed()
      break
    case 'toggleSide': {
      currentSide = currentSide === 'left' ? 'right' : 'left'
      t.setSide(currentSide)
      syncLayout()
      onPlacementChanged?.()
      sendToShellWindows(rw, pw, 'window:side', currentSide)
      const b = rw.getBounds()
      const disp = screen.getDisplayNearestPoint({
        x: Math.floor(b.x + b.width / 2),
        y: Math.floor(b.y + b.height / 2),
      })
      saveShellPlacementState({ displayId: disp.id, side: currentSide, collapsed: t.isCollapsed() })
      break
    }
  }
}

function getCurrentPaneWidth(win: BrowserWindow): number {
  if (win.isDestroyed()) return DEFAULT_PANE_WIDTH
  const [w] = win.getSize()
  return clampPaneWidth(w)
}

/** Snap ribbon + pane to the work area / side implied by a screen point (pointer release). */
function commitShellPlacementAtScreenPoint(screenX: number, screenY: number) {
  if (!shell || shell.ribbonWin.isDestroyed()) return
  const { ribbonWin, paneWin, tabs } = shell
  const pt = { x: Math.round(screenX), y: Math.round(screenY) }
  const display = screen.getDisplayNearestPoint(pt)
  const wa = display.workArea
  const newSide = sideNearestToPoint(pt, wa)
  let sideChanged = false
  if (newSide !== currentSide) {
    currentSide = newSide
    tabs.setSide(currentSide)
    sideChanged = true
  }
  placeRibbonPane(ribbonWin, paneWin, currentSide, tabs.isCollapsed(), tabs.getActiveExpandedWidth(), wa)
  tabs.relayout()
  // The ribbon may have crossed to another edge or another display, and a
  // reservation registered against the old one has to be re-registered.
  onPlacementChanged?.()
  if (sideChanged) {
    sendToShellWindows(ribbonWin, paneWin, 'window:side', currentSide)
  }
  saveShellPlacementState({ displayId: display.id, side: currentSide, collapsed: tabs.isCollapsed() })
}

export function registerIpc(
  ribbonWin: BrowserWindow,
  paneWin: BrowserWindow,
  tabs: TabManager,
  downloads: DownloadManager,
) {
  shell = { ribbonWin, paneWin, tabs, downloads }

  detachTabState?.()
  detachPinned?.()
  detachDownloads?.()
  detachDownloads = downloads.onChange(state => {
    // Broadcast: the downloads popover is its own window, not part of `shell`.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('downloads:state', state)
    }
  })
  detachTabState = tabs.onStateChange(state => {
    if (!shell) return
    sendToShellWindows(shell.ribbonWin, shell.paneWin, 'tabs:state', state)
  })
  detachPinned = tabs.onPinnedSitesChange(sites => {
    if (!shell) return
    sendToShellWindows(shell.ribbonWin, shell.paneWin, 'tabs:pinnedSites', sites)
  })

  if (!ipcInstalled) {
    ipcInstalled = true

    ipcMain.handle('tabs:getState', () => shell?.tabs.getState() ?? [])
    ipcMain.handle('tabs:getPinnedSites', () => shell?.tabs.getPinnedSites() ?? [])
    ipcMain.handle('window:getSide', () => currentSide)
    ipcMain.handle('window:getCollapsed', () => shell?.tabs.isCollapsed() ?? true)
    ipcMain.handle('tabs:capturePreview', async (_e, tabId: number) => {
      const wc = shell?.tabs.getTabWebContentsById(Number(tabId))
      if (!wc || wc.isDestroyed()) return null
      try {
        const img = await wc.capturePage()
        return img.toDataURL()
      } catch {
        return null
      }
    })

    ipcMain.handle('tabs:getAudioInfo', (_e, tabId: number) => {
      return shell?.tabs.getAudioInfo(Number(tabId)) ?? null
    })

    ipcMain.handle('tabs:togglePlayPause', async (_e, tabId: number) => {
      const wc = shell?.tabs.getTabWebContentsById(Number(tabId))
      if (!wc || wc.isDestroyed()) return
      // Best-effort: toggle the first media element found.
      await wc.executeJavaScript(
        `(() => {
          const el = document.querySelector('video, audio');
          if (!el) return;
          if (el.paused) el.play?.();
          else el.pause?.();
        })();`,
        true,
      ).catch(() => {})
    })

    ipcMain.handle('tabs:nextTrack', async (_e, tabId: number) => {
      const wc = shell?.tabs.getTabWebContentsById(Number(tabId))
      if (!wc || wc.isDestroyed()) return false
      const outcome = await wc.executeJavaScript(NEXT_TRACK_SCRIPT, true).catch(e => 'ERROR ' + e)
      console.log('[next-track]', outcome)
      return Boolean(outcome) && String(outcome).startsWith('CLICKED')
    })

    ipcMain.handle('tabs:toggleMute', async (_e, tabId: number) => {
      const wc = shell?.tabs.getTabWebContentsById(Number(tabId))
      if (!wc || wc.isDestroyed()) return false
      const next = !wc.isAudioMuted()
      wc.setAudioMuted(next)
      return next
    })

    ipcMain.on('window:commitPlacement', (_e, screenX: number, screenY: number) => {
      const x = Number(screenX)
      const y = Number(screenY)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      commitShellPlacementAtScreenPoint(x, y)
    })

    ipcMain.on('window:setPaneWidth', (_e, width: number) => {
      if (!shell || shell.tabs.isCollapsed()) return
      const w = clampPaneWidth(width)
      shell.tabs.setActiveExpandedWidth(w)
      placeRibbonPane(shell.ribbonWin, shell.paneWin, currentSide, false, w)
      shell.tabs.relayout()
    })

    ipcMain.on('tabs:contextMenu', (_e, tabId: number) => {
      if (!shell) return
      const { ribbonWin: rw } = shell
      setContextMenuOpen(true)
      Menu.buildFromTemplate([
        {
          label: 'Pin to Tabbar',
          click: () => shell!.tabs.pinTab(tabId),
        },
        { type: 'separator' },
        {
          label: 'Close tab',
          click: () => {
            shell!.tabs.closeTab(tabId)
            restoreActiveExpandedWidth()
          },
        },
      ]).popup({
        window: rw,
        callback: () => setContextMenuOpen(false),
      })
    })

    ipcMain.on('tabs:pinnedContextMenu', (_e, siteId: string) => {
      if (!shell) return
      const { ribbonWin: rw } = shell
      const openTabId = shell.tabs.getOpenTabIdForPinnedSite(siteId)
      const site = shell.tabs.getPinnedSite(siteId)
      const currentUa = site?.userAgent
      setContextMenuOpen(true)
      Menu.buildFromTemplate([
        {
          label: 'Unpin',
          click: () => shell!.tabs.unpinSite(siteId),
        },
        { type: 'separator' },
        {
          label: 'Isolated session',
          type: 'checkbox',
          checked: Boolean(site?.partition),
          toolTip:
            'Give this site its own cookies so it can be signed in to a different account. Closes its tabs and needs a fresh sign-in.',
          click: menuItem => {
            shell!.tabs.setPinnedSiteIsolated(siteId, menuItem.checked)
            if (shell!.tabs.getTabCount() === 0) collapseToRibbonOnly()
          },
        },
        {
          label: 'User agent',
          submenu: [
            {
              label: 'Default',
              type: 'radio',
              checked: !currentUa,
              click: () => shell!.tabs.setPinnedSiteUserAgent(siteId, undefined),
            },
            {
              label: 'Mobile',
              type: 'radio',
              checked: currentUa === USER_AGENT_PRESETS.mobile,
              click: () => shell!.tabs.setPinnedSiteUserAgent(siteId, USER_AGENT_PRESETS.mobile),
            },
            {
              label: 'Desktop',
              type: 'radio',
              checked: currentUa === USER_AGENT_PRESETS.desktop,
              click: () => shell!.tabs.setPinnedSiteUserAgent(siteId, USER_AGENT_PRESETS.desktop),
            },
          ],
        },
        { type: 'separator' },
        {
          label: 'Close tab',
          enabled: openTabId !== null,
          click: () => {
            if (openTabId === null) return
            shell!.tabs.closeTab(openTabId)
            if (shell!.tabs.getTabCount() === 0) collapseToRibbonOnly()
            else restoreActiveExpandedWidth()
          },
        },
      ]).popup({
        window: rw,
        callback: () => setContextMenuOpen(false),
      })
    })

    // Takes no URL from the renderer: main resolves the active tab itself, so
    // this cannot be used to hand an arbitrary URL to the OS.
    ipcMain.on('tabs:openInDefaultBrowser', () => {
      const url = shell?.tabs.getActiveTabUrl()
      if (!url) return
      let protocol = ''
      try {
        protocol = new URL(url).protocol
      } catch {
        return
      }
      if (protocol !== 'http:' && protocol !== 'https:') return
      electronShell.openExternal(url).catch(() => {})
      // The page now lives in the real browser, so give the screen back. Once
      // collapsed, the ribbon auto-hides on its own as the cursor leaves it.
      collapseToRibbonOnly()
    })

    ipcMain.handle('downloads:getState', () => shell?.downloads.getState() ?? [])
    ipcMain.on('downloads:cancel', (_e, id: number) => shell?.downloads.cancel(Number(id)))
    ipcMain.on('downloads:open', (_e, id: number) => {
      shell?.downloads.open(Number(id)).catch(() => {})
    })
    ipcMain.on('downloads:showInFolder', (_e, id: number) =>
      shell?.downloads.showInFolder(Number(id)),
    )
    ipcMain.on('downloads:clear', () => shell?.downloads.clearFinished())

    ipcMain.on('tabs:pin', (_e, tabId: number) => {
      const id = Number(tabId)
      if (!Number.isFinite(id)) return
      shell?.tabs.pinTab(id)
    })

    ipcMain.on('tabs:unpin', (_e, siteId: string) => {
      if (typeof siteId !== 'string' || !siteId) return
      shell?.tabs.unpinSite(siteId)
    })

    ipcMain.on('tabs:reorderPinned', (_e, fromSiteId: string, toSiteId: string, before: boolean) => {
      if (!shell) return
      shell.tabs.reorderPinnedSites(String(fromSiteId), String(toSiteId), Boolean(before))
    })

    ipcMain.on('tabs:launchPinnedSite', (_e, siteId: string) => {
      if (!shell) return
      shell.tabs.launchPinnedSite(siteId)
      restoreActiveExpandedWidth()
    })

    ipcMain.on('tabs:action', (_e, action: TabAction) => {
      dispatchTabAction(action)
    })
  }

  return { syncLayout }
}
