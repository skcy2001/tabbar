export interface TabInfo {
  id: number
  title: string
  url: string
  faviconDataUrl: string | null
  isActive: boolean
  canGoBack: boolean
  canGoForward: boolean
  pinnedSiteId?: string
  hasMedia?: boolean
  isAudioPlaying?: boolean
  /** Unread count parsed from the page title (e.g. "(3) Inbox"); absent when none. */
  unreadCount?: number
  /** Title marks unread without a number (e.g. a leading bullet). */
  unreadDot?: boolean
}

export interface PinnedSiteInfo {
  id: string
  title: string
  url: string
  faviconDataUrl: string | null
  /** Persisted per-site pane width (used when re-opening pinned apps). */
  expandedWidth?: number
  /**
   * Electron session partition for this site. Sites pinned before per-site
   * sessions existed have no partition and keep using the shared browser
   * partition, so nobody is silently signed out; opting in is explicit.
   */
  partition?: string
  /** Overrides the default user agent for tabs opened from this site. */
  userAgent?: string
}

/** Named user-agent presets offered per pinned site. */
export type UserAgentPreset = 'default' | 'mobile' | 'desktop'

export const USER_AGENT_PRESETS: Record<Exclude<UserAgentPreset, 'default'>, string> = {
  mobile:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  desktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadInfo {
  id: number
  filename: string
  url: string
  savePath: string
  state: DownloadState
  receivedBytes: number
  totalBytes: number
  /** Epoch ms when the download started, for newest-first ordering. */
  startedAt: number
}

export interface MediaPlayerInfo {
  hasMedia?: boolean
  canPlayPause?: boolean
  canNextTrack?: boolean
  canMute?: boolean
  tabId: number
  title: string
  artist: string
  album: string
  artworkUrl: string | null
  sourceTitle: string
  sourceUrl: string
  faviconDataUrl: string | null
  isMuted: boolean
  isPlaying: boolean
}

export type Side = 'left' | 'right'

export const DEFAULT_SIDE: Side = 'right'
export const RIBBON_WIDTH = 56
export const INNER_RESIZE_HANDLE_WIDTH = 4
/** @deprecated Total single-window width; pane uses {@link DEFAULT_PANE_WIDTH}. */
export const DEFAULT_EXPANDED_WIDTH = 420
export const CONTENT_GAP = 1
/** Width of the pane window (toolbar + page) when expanded. */
export const DEFAULT_PANE_WIDTH =
  DEFAULT_EXPANDED_WIDTH - RIBBON_WIDTH - CONTENT_GAP - INNER_RESIZE_HANDLE_WIDTH
export const MIN_EXPANDED_WIDTH = 220
export const MAX_EXPANDED_WIDTH = 900

export type TabAction =
  | { type: 'create'; url?: string }
  | { type: 'close'; id: number }
  | { type: 'activate'; id: number }
  | { type: 'reorderTabs'; fromId: number; toId: number; before?: boolean }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'toggleCollapsed' }
  | { type: 'toggleSide' }

export type IpcChannel =
  | 'tabs:state'
  | 'tabs:action'
  | 'tabs:focusAddress'
  | 'window:collapsed'
  | 'window:side'
