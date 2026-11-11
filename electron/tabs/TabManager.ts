import { app, BrowserWindow, WebContentsView, session, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  DEFAULT_PANE_WIDTH,
  DEFAULT_SIDE,
  INNER_RESIZE_HANDLE_WIDTH,
  type MediaPlayerInfo,
  type PinnedSiteInfo,
  type TabInfo,
  type Side,
} from '../../shared/types'
import { isSizedPopup, parseUnreadFromTitle } from './parsing'
import { isSameHost } from '../urlLaunch'

export type TabStateListener = (tabs: TabInfo[]) => void
export type PinnedSitesListener = (sites: PinnedSiteInfo[]) => void
export type BeforeInputHandler = (event: Electron.Event, input: Electron.Input) => void
/** Called when page content wants a new tab (window.open, target=_blank, ctrl+click). */
export type NewTabRequestHandler = (url: string, background: boolean) => void
/** Called for every session the manager uses, so downloads can be watched per-partition. */
export type SessionHook = (ses: Electron.Session) => void
/** Called when a page enters or leaves HTML5 fullscreen (e.g. a video player). */
export type HtmlFullscreenHandler = (tabId: number, entering: boolean) => void

interface Tab {
  id: number
  view: WebContentsView
  title: string
  url: string
  faviconDataUrl: string | null
  expandedWidth: number
  pinnedSiteId?: string
  hasMedia: boolean
  isAudioPlaying: boolean
  unreadCount: number
  unreadDot: boolean
}

const TOOLBAR_HEIGHT = 44
const BROWSER_PARTITION = 'persist:sidebar-browser'
const HIDE_SCROLLBARS_CSS = `
  * {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
  }

  *::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
`

const NEW_TAB_DARK_CSS = `
  :root, html, body {
    background: #0f0f1a !important;
    color-scheme: dark !important;
    color: #e8e8f0 !important;
  }
`

const MEDIA_INFO_SCRIPT = `
(() => {
  const metadata = navigator.mediaSession?.metadata ?? null;
  const artwork = Array.isArray(metadata?.artwork) ? metadata.artwork : [];
  const image = artwork
    .map(item => ({
      src: item?.src ? new URL(item.src, location.href).href : '',
      area: String(item?.sizes ?? '')
        .split(/\\s+/)
        .map(size => {
          const match = /^(\\d+)x(\\d+)$/i.exec(size);
          return match ? Number(match[1]) * Number(match[2]) : 0;
        })
        .reduce((max, value) => Math.max(max, value), 0),
    }))
    .filter(item => item.src)
    .sort((a, b) => b.area - a.area)[0]?.src ?? null;

  const media = Array.from(document.querySelectorAll('audio, video'));
  const active =
    media.find(el => !el.paused && !el.ended) ??
    media.find(el => el.currentTime > 0 && !el.ended) ??
    media[0] ??
    null;

  return {
    title: metadata?.title || active?.getAttribute('title') || active?.getAttribute('aria-label') || '',
    artist: metadata?.artist || '',
    album: metadata?.album || '',
    artworkUrl: image || active?.poster || null,
    hasMedia: media.length > 0,
    mediaPaused: active ? active.paused : null,
  };
})()
`

export class TabManager {
  private tabs: Tab[] = []
  private activeId: number | null = null
  private nextId = 1
  private win: BrowserWindow
  private listeners: Set<TabStateListener> = new Set()
  private pinnedListeners: Set<PinnedSitesListener> = new Set()
  private pinnedSites: PinnedSiteInfo[] = []
  private pinnedSitesPath = path.join(app.getPath('userData'), 'pinned-sites.json')
  private pinnedSitesSaveTimer: NodeJS.Timeout | null = null
  private collapsed: boolean = false
  private side: Side = DEFAULT_SIDE
  private beforeInputHandler: BeforeInputHandler | null = null
  private newTabRequestHandler: NewTabRequestHandler | null = null
  private sessionHook: SessionHook | null = null
  private fullscreen = false
  private htmlFullscreenHandler: HtmlFullscreenHandler | null = null

  constructor(win: BrowserWindow) {
    this.win = win
    this.pinnedSites = this.loadPinnedSites()
  }

  /** Resolves (and memoises via Electron) the session a tab should load in. */
  private sessionFor(pinnedSiteId?: string): Electron.Session {
    const site = pinnedSiteId ? this.pinnedSites.find(s => s.id === pinnedSiteId) : undefined
    const ses = session.fromPartition(site?.partition || BROWSER_PARTITION)
    this.sessionHook?.(ses)
    return ses
  }

  private viewBounds() {
    const [winW, winH] = this.win.getContentSize()
    // Fullscreen hands the whole window to the page: no toolbar, no resize strip.
    if (this.fullscreen) return { x: 0, y: 0, width: winW, height: winH }
    // Leave room for the pane outer-edge resize handle so the WebContentsView
    // never covers the draggable strip.
    const resizeW = this.collapsed ? 0 : INNER_RESIZE_HANDLE_WIDTH
    const x = this.side === 'right' ? resizeW : 0
    return {
      x,
      y: TOOLBAR_HEIGHT,
      width: winW - resizeW,
      height: winH - TOOLBAR_HEIGHT,
    }
  }

  /** Bounds the active view should occupy right now, honouring fullscreen first. */
  private currentViewBounds() {
    if (this.fullscreen) return this.viewBounds()
    return this.collapsed ? this.hiddenViewBounds() : this.viewBounds()
  }

  private hiddenViewBounds() {
    const [winW] = this.win.getContentSize()
    return {
      x: this.side === 'left' ? winW : -1,
      y: 0,
      width: 1,
      height: 1,
    }
  }

  private hidePageScrollbars(tab: Tab) {
    tab.view.webContents.insertCSS(HIDE_SCROLLBARS_CSS).catch(() => {})
  }

  private emit() {
    const state = this.getState()
    this.listeners.forEach(l => l(state))
  }

  private emitPinnedSites() {
    const sites = this.getPinnedSites()
    this.pinnedListeners.forEach(l => l(sites))
  }

  private loadPinnedSites() {
    try {
      const raw = fs.readFileSync(this.pinnedSitesPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(site =>
        typeof site?.id === 'string' &&
        typeof site?.title === 'string' &&
        typeof site?.url === 'string'
      ).map(site => ({
        id: site.id,
        title: site.title,
        url: site.url,
        faviconDataUrl: typeof site?.faviconDataUrl === 'string' || site?.faviconDataUrl === null ? site.faviconDataUrl : null,
        expandedWidth: typeof site?.expandedWidth === 'number' ? site.expandedWidth : undefined,
        partition: typeof site?.partition === 'string' ? site.partition : undefined,
        userAgent: typeof site?.userAgent === 'string' ? site.userAgent : undefined,
      })) as PinnedSiteInfo[]
    } catch {
      return []
    }
  }

  private savePinnedSites() {
    fs.mkdirSync(path.dirname(this.pinnedSitesPath), { recursive: true })
    fs.writeFileSync(this.pinnedSitesPath, JSON.stringify(this.pinnedSites, null, 2))
    this.emitPinnedSites()
  }

  private scheduleSavePinnedSites() {
    if (this.pinnedSitesSaveTimer) clearTimeout(this.pinnedSitesSaveTimer)
    this.pinnedSitesSaveTimer = setTimeout(() => {
      this.pinnedSitesSaveTimer = null
      this.savePinnedSites()
    }, 250)
  }

  flushPinnedSitesSave() {
    if (this.pinnedSitesSaveTimer) {
      clearTimeout(this.pinnedSitesSaveTimer)
      this.pinnedSitesSaveTimer = null
    }
    this.savePinnedSites()
  }

  onStateChange(listener: TabStateListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onPinnedSitesChange(listener: PinnedSitesListener) {
    this.pinnedListeners.add(listener)
    return () => this.pinnedListeners.delete(listener)
  }

  setBeforeInputHandler(handler: BeforeInputHandler) {
    this.beforeInputHandler = handler
  }

  setNewTabRequestHandler(handler: NewTabRequestHandler) {
    this.newTabRequestHandler = handler
  }

  setHtmlFullscreenHandler(handler: HtmlFullscreenHandler) {
    this.htmlFullscreenHandler = handler
  }

  getActiveTabId(): number | null {
    return this.activeId
  }

  getActiveTabUrl(): string | null {
    return this.activeTab()?.url ?? null
  }

  isFullscreen() {
    return this.fullscreen
  }

  /**
   * Hands the whole pane window to the page. The caller is responsible for
   * resizing that window to cover the display; this only controls view layout.
   */
  setFullscreen(fullscreen: boolean) {
    if (this.fullscreen === fullscreen) return
    this.fullscreen = fullscreen
    const active = this.activeTab()
    if (!active) return
    // Re-attach in case we were collapsed, where the view is parked off-window.
    try { this.win.contentView.addChildView(active.view) } catch {}
    active.view.setBounds(this.currentViewBounds())
  }

  /**
   * Registers a hook run once per session. Called for sessions already in use so
   * a hook installed after startup still sees them.
   */
  setSessionHook(hook: SessionHook) {
    this.sessionHook = hook
    hook(session.fromPartition(BROWSER_PARTITION))
    for (const site of this.pinnedSites) {
      if (site.partition) hook(session.fromPartition(site.partition))
    }
  }

  getPinnedSites(): PinnedSiteInfo[] {
    return this.pinnedSites.map(site => ({ ...site }))
  }

  getState(): TabInfo[] {
    return this.tabs.map(t => {
      // During teardown, Electron may have already destroyed the WebContents.
      const wc = (t.view as unknown as { webContents?: unknown })?.webContents as
        | Electron.WebContents
        | undefined
      return {
        id: t.id,
        title: t.title,
        url: t.url,
        faviconDataUrl: t.faviconDataUrl,
        isActive: t.id === this.activeId,
        canGoBack: typeof wc?.canGoBack === 'function' ? wc.canGoBack() : false,
        canGoForward: typeof wc?.canGoForward === 'function' ? wc.canGoForward() : false,
        pinnedSiteId: t.pinnedSiteId,
        hasMedia: t.hasMedia,
        isAudioPlaying: t.isAudioPlaying,
        unreadCount: t.unreadCount > 0 ? t.unreadCount : undefined,
        unreadDot: t.unreadDot || undefined,
      }
    })
  }

  createTab(
    url = 'https://www.google.com',
    expandedWidth = DEFAULT_PANE_WIDTH,
    pinnedSiteId?: string,
    activate = true,
  ) {
    const ses = this.sessionFor(pinnedSiteId)

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        sandbox: true,
      },
    })

    const id = this.nextId++
    const tab: Tab = {
      id,
      view,
      title: 'New Tab',
      url,
      faviconDataUrl: null,
      expandedWidth,
      pinnedSiteId,
      hasMedia: false,
      isAudioPlaying: false,
      unreadCount: 0,
      unreadDot: false,
    }
    this.tabs.push(tab)

    const wc = view.webContents
    wc.on('before-input-event', (event, input) => {
      this.beforeInputHandler?.(event, input)
    })

    const userAgent = pinnedSiteId
      ? this.pinnedSites.find(s => s.id === pinnedSiteId)?.userAgent
      : undefined
    if (userAgent) wc.setUserAgent(userAgent)

    wc.setWindowOpenHandler(details => this.handleWindowOpen(details))

    // Not all Electron typings expose this on WebContents across versions.
    ;(wc as unknown as { setBackgroundColor?: (color: string) => void }).setBackgroundColor?.('#0f0f1a')
    wc.on('dom-ready', () => this.hidePageScrollbars(tab))
    wc.on('dom-ready', () => {
      const currentUrl = wc.getURL()
      if (currentUrl === 'about:blank') {
        wc.insertCSS(NEW_TAB_DARK_CSS).catch(() => {})
      }
    })

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title
      const unread = parseUnreadFromTitle(title)
      tab.unreadCount = unread.count
      tab.unreadDot = unread.dot
      this.emit()
    })

    const setAudioPlaying = (playing: boolean) => {
      const hadMedia = tab.hasMedia
      if (playing) tab.hasMedia = true
      if (tab.isAudioPlaying === playing && hadMedia === tab.hasMedia) return
      tab.isAudioPlaying = playing
      this.emit()
    }

    wc.on('media-started-playing', () => setAudioPlaying(true))
    wc.on('media-paused', () => setAudioPlaying(false))
    wc.on('destroyed', () => setAudioPlaying(false))

    // A video player's fullscreen button: present the whole pane window fullscreen.
    wc.on('enter-html-full-screen', () => this.htmlFullscreenHandler?.(id, true))
    wc.on('leave-html-full-screen', () => this.htmlFullscreenHandler?.(id, false))

    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons.length === 0) return
      const faviconUrl = favicons[0]

      // If it's already a data URL, use it directly
      if (faviconUrl.startsWith('data:')) {
        tab.faviconDataUrl = faviconUrl
        this.emit()
        return
      }

      // Fetch via the tab's own session so auth/cookies work, then convert to
      // a base64 data URL so the renderer never needs cross-origin image access.
      ses.fetch(faviconUrl)
        .then(async res => {
          const mime = res.headers.get('content-type') ?? 'image/png'
          const buf = Buffer.from(await res.arrayBuffer())
          tab.faviconDataUrl = `data:${mime.split(';')[0]};base64,${buf.toString('base64')}`
          this.emit()
        })
        .catch(() => {
          // Fall back to the raw URL if the fetch fails
          tab.faviconDataUrl = faviconUrl
          this.emit()
        })
    })

    wc.on('did-navigate', (_e, navUrl) => {
      tab.url = navUrl
      tab.hasMedia = false
      tab.isAudioPlaying = false
      tab.unreadCount = 0
      tab.unreadDot = false
      this.emit()
    })

    wc.on('did-navigate-in-page', (_e, navUrl) => {
      tab.url = navUrl
      this.emit()
    })

    if (activate) this.activateTab(id)
    else this.emit()
    wc.loadURL(url).catch(() => {})
    return id
  }

  /**
   * Decides what a page's `window.open` / `target=_blank` should do.
   *
   * Sized popups (the shape OAuth and share dialogs use) stay real windows so the
   * opener relationship — and therefore `postMessage` back to the page — survives.
   * Everything else becomes a sidebar tab, and non-web schemes go to the OS.
   */
  private handleWindowOpen(
    details: Electron.HandlerDetails,
  ): { action: 'deny' } | { action: 'allow'; overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions } {
    const url = details.url

    let protocol = ''
    try {
      protocol = new URL(url).protocol
    } catch {
      return { action: 'deny' }
    }

    if (protocol !== 'http:' && protocol !== 'https:') {
      // mailto:, tel:, msteams: and friends belong to the OS, not the sidebar.
      shell.openExternal(url).catch(() => {})
      return { action: 'deny' }
    }

    if (isSizedPopup(details.features)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          // Sit above the always-on-top shell, or the popup opens behind it.
          alwaysOnTop: true,
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        },
      }
    }

    const background = details.disposition === 'background-tab'
    if (this.newTabRequestHandler) this.newTabRequestHandler(url, background)
    else this.createTab(url, this.getActiveExpandedWidth(), undefined, !background)
    return { action: 'deny' }
  }

  pinTab(id: number) {
    const tab = this.tabs.find(t => t.id === id)
    if (!tab || tab.url === 'about:blank') return

    const existing = this.pinnedSites.find(site => site.url === tab.url)
    if (existing) {
      tab.pinnedSiteId = existing.id
      this.emit()
      return
    }

    const siteId = `pin-${Date.now()}-${Math.round(Math.random() * 100000)}`
    const site: PinnedSiteInfo = {
      id: siteId,
      title: tab.title || tab.url,
      url: tab.url,
      faviconDataUrl: tab.faviconDataUrl,
      expandedWidth: tab.expandedWidth,
      // New pins get their own cookie jar so the same site can be pinned twice
      // under different accounts. Costs one sign-in the next time it is opened.
      partition: `persist:site-${siteId}`,
    }
    this.pinnedSites.push(site)
    tab.pinnedSiteId = site.id
    this.savePinnedSites()
    this.emit()
  }

  launchPinnedSite(siteId: string) {
    const site = this.pinnedSites.find(p => p.id === siteId)
    if (!site) return

    const existing = this.tabs.find(t => t.pinnedSiteId === siteId)
    if (existing) {
      this.activateTab(existing.id)
      return
    }

    this.createTab(site.url, site.expandedWidth ?? this.getActiveExpandedWidth(), site.id)
  }

  /** The pinned site that owns this URL's host, if any. */
  findPinnedSiteIdForUrl(url: string): string | null {
    return this.pinnedSites.find(site => isSameHost(site.url, url))?.id ?? null
  }

  /**
   * Opens `url` inside a pinned site instead of a fresh tab, reusing that
   * site's existing tab so the ribbon never grows a duplicate icon for a site
   * it already hosts.
   */
  openInPinnedSite(siteId: string, url: string): boolean {
    const site = this.pinnedSites.find(s => s.id === siteId)
    if (!site) return false

    const existing = this.tabs.find(t => t.pinnedSiteId === siteId)
    if (existing) {
      this.activateTab(existing.id)
      // navigate() acts on the active tab, which the line above just made this one.
      if (existing.url !== url) this.navigate(url)
      return true
    }

    this.createTab(url, site.expandedWidth ?? this.getActiveExpandedWidth(), siteId)
    return true
  }

  getOpenTabIdForPinnedSite(siteId: string): number | null {
    return this.tabs.find(t => t.pinnedSiteId === siteId)?.id ?? null
  }

  getPinnedSite(siteId: string): PinnedSiteInfo | null {
    const site = this.pinnedSites.find(s => s.id === siteId)
    return site ? { ...site } : null
  }

  /**
   * Switches a pinned site between the shared cookie jar and its own.
   * Open tabs are closed because a live WebContents cannot change session.
   */
  setPinnedSiteIsolated(siteId: string, isolated: boolean) {
    const site = this.pinnedSites.find(s => s.id === siteId)
    if (!site) return
    const nextPartition = isolated ? `persist:site-${siteId}` : undefined
    if (site.partition === nextPartition) return

    site.partition = nextPartition
    if (nextPartition) this.sessionHook?.(session.fromPartition(nextPartition))

    for (const id of this.tabs.filter(t => t.pinnedSiteId === siteId).map(t => t.id)) {
      this.closeTab(id)
    }
    this.savePinnedSites()
  }

  /** Sets (or clears, with undefined) the UA override and reloads open tabs. */
  setPinnedSiteUserAgent(siteId: string, userAgent: string | undefined) {
    const site = this.pinnedSites.find(s => s.id === siteId)
    if (!site) return
    if (site.userAgent === userAgent) return

    site.userAgent = userAgent
    this.savePinnedSites()

    for (const tab of this.tabs.filter(t => t.pinnedSiteId === siteId)) {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) continue
      // Empty string restores Electron's default UA for this WebContents.
      wc.setUserAgent(userAgent ?? wc.session.getUserAgent())
      wc.reload()
    }
  }

  getTabCount(): number {
    return this.tabs.length
  }

  getTabWebContentsById(tabId: number): Electron.WebContents | null {
    const tab = this.tabs.find(t => t.id === tabId)
    return tab?.view.webContents ?? null
  }

  async getAudioInfo(tabId: number): Promise<MediaPlayerInfo | null> {
    const tab = this.tabs.find(t => t.id === tabId)
    if (!tab) return null

    const wc = tab.view.webContents
    if (wc.isDestroyed()) return null

    const pageInfo = await wc.executeJavaScript(MEDIA_INFO_SCRIPT, true).catch(() => null) as
      | {
          title?: unknown
          artist?: unknown
          album?: unknown
          artworkUrl?: unknown
          hasMedia?: unknown
          mediaPaused?: unknown
        }
      | null

    const clean = (value: unknown) => typeof value === 'string' ? value.trim() : ''
    const title = clean(pageInfo?.title) || tab.title || displayUrl(tab.url)
    if (pageInfo?.hasMedia === true && !tab.hasMedia) {
      tab.hasMedia = true
      this.emit()
    }

    return {
      tabId: tab.id,
      title,
      artist: clean(pageInfo?.artist),
      album: clean(pageInfo?.album),
      artworkUrl: clean(pageInfo?.artworkUrl) || null,
      sourceTitle: tab.title || displayUrl(tab.url),
      sourceUrl: tab.url,
      faviconDataUrl: tab.faviconDataUrl,
      isMuted: wc.isAudioMuted(),
      isPlaying: pageInfo?.mediaPaused === false || tab.isAudioPlaying,
    }
  }

  /** Remove pinned site and close every tab opened from it (ribbon “Close app”). */
  closePinnedSite(siteId: string) {
    const ids = this.tabs.filter(tab => tab.pinnedSiteId === siteId).map(t => t.id)
    for (const id of ids) {
      this.closeTab(id)
    }
    const before = this.pinnedSites.length
    this.pinnedSites = this.pinnedSites.filter(site => site.id !== siteId)
    if (this.pinnedSites.length !== before) this.savePinnedSites()
  }

  unpinSite(siteId: string) {
    const beforePinCount = this.pinnedSites.length
    this.pinnedSites = this.pinnedSites.filter(site => site.id !== siteId)
    if (this.pinnedSites.length === beforePinCount) return

    let tabsChanged = false
    for (const tab of this.tabs) {
      if (tab.pinnedSiteId === siteId) {
        tab.pinnedSiteId = undefined
        tabsChanged = true
      }
    }

    this.savePinnedSites()
    if (tabsChanged) this.emit()
  }

  reorderTabs(fromId: number, toId: number, before: boolean) {
    if (fromId === toId) return
    const fromIdx = this.tabs.findIndex(t => t.id === fromId)
    const toIdx = this.tabs.findIndex(t => t.id === toId)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = this.tabs.splice(fromIdx, 1)
    let targetIdx = toIdx
    if (fromIdx < toIdx) targetIdx -= 1
    if (!before) targetIdx += 1
    targetIdx = Math.max(0, Math.min(this.tabs.length, targetIdx))
    this.tabs.splice(targetIdx, 0, moved)
    this.emit()
  }

  reorderPinnedSites(fromSiteId: string, toSiteId: string, before: boolean) {
    if (fromSiteId === toSiteId) return
    const fromIdx = this.pinnedSites.findIndex(s => s.id === fromSiteId)
    const toIdx = this.pinnedSites.findIndex(s => s.id === toSiteId)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = this.pinnedSites.splice(fromIdx, 1)
    let targetIdx = toIdx
    if (fromIdx < toIdx) targetIdx -= 1
    if (!before) targetIdx += 1
    targetIdx = Math.max(0, Math.min(this.pinnedSites.length, targetIdx))
    this.pinnedSites.splice(targetIdx, 0, moved)
    // Persist and notify ribbon.
    this.savePinnedSites()
  }

  activateTab(id: number) {
    const tab = this.tabs.find(t => t.id === id)
    if (!tab) return

    // Detach currently active view
    if (this.activeId !== null) {
      const prev = this.tabs.find(t => t.id === this.activeId)
      if (prev) {
        try { this.win.contentView.removeChildView(prev.view) } catch {}
      }
    }

    this.activeId = id

    this.win.contentView.addChildView(tab.view)
    tab.view.setBounds(this.currentViewBounds())

    this.emit()
  }

  closeTab(id: number) {
    const idx = this.tabs.findIndex(t => t.id === id)
    if (idx === -1) return

    // Closing the tab that is presenting fullscreen must restore the shell,
    // otherwise the ribbon stays hidden with nothing on screen to bring it back.
    if (this.fullscreen && this.activeId === id) this.htmlFullscreenHandler?.(id, false)

    const tab = this.tabs[idx]
    try { this.win.contentView.removeChildView(tab.view) } catch {}
    tab.view.webContents.close()

    this.tabs.splice(idx, 1)

    if (this.activeId === id) {
      this.activeId = null
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)]
      if (next) {
        this.activateTab(next.id)
      } else {
        // Allow no-tabs state; ribbon can remain visible without a placeholder tab.
        this.emit()
      }
    } else {
      this.emit()
    }
  }

  navigate(url: string) {
    const tab = this.activeTab()
    if (!tab) return
    // Auto-prepend https if missing scheme
    const target = /^https?:\/\//i.test(url)
      ? url
      : url.includes('.')
      ? `https://${url}`
      : `https://www.google.com/search?q=${encodeURIComponent(url)}`
    tab.view.webContents.loadURL(target).catch(() => {})
    tab.url = target
    this.emit()
  }

  back() { this.activeTab()?.view.webContents.goBack() }
  forward() { this.activeTab()?.view.webContents.goForward() }
  reload() { this.activeTab()?.view.webContents.reload() }

  isCollapsed() {
    return this.collapsed
  }

  getActiveExpandedWidth() {
    return this.activeTab()?.expandedWidth ?? DEFAULT_PANE_WIDTH
  }

  setActiveExpandedWidth(width: number) {
    const active = this.activeTab()
    if (!active) return
    active.expandedWidth = width

    if (active.pinnedSiteId) {
      const pinned = this.pinnedSites.find(p => p.id === active.pinnedSiteId)
      if (pinned) {
        pinned.expandedWidth = width
        this.scheduleSavePinnedSites()
      }
    }
  }

  setSide(side: Side) {
    this.side = side
    this.relayout()
  }

  setCollapsed(collapsed: boolean) {
    this.collapsed = collapsed
    const active = this.activeTab()
    if (!active) return

    try { this.win.contentView.addChildView(active.view) } catch {}
    active.view.setBounds(this.currentViewBounds())
  }

  relayout() {
    const active = this.activeTab()
    if (!active) return
    active.view.setBounds(this.currentViewBounds())
  }

  private activeTab(): Tab | undefined {
    return this.tabs.find(t => t.id === this.activeId)
  }
}

function displayUrl(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
