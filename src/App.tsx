import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTabs } from './state/useTabs'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { PaneResizeHandle } from './components/PaneResizeHandle'
import {
  INNER_RESIZE_HANDLE_WIDTH,
  RIBBON_WIDTH,
  type DownloadInfo,
} from '../shared/types'
import { PlayerPreview } from './components/PlayerPreview'
import './App.css'

export type ShellRole = 'ribbon' | 'pane' | 'player' | 'edge' | 'downloads'

/** Subscribes to the merged download list from the main process. */
function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadInfo[]>([])

  useEffect(() => {
    const api = window.sidebarApi
    if (!api) return
    api.downloads.getState().then(setDownloads)
    const unsub = api.downloads.onChange(setDownloads)
    return () => unsub()
  }, [])

  return downloads
}

interface ShellProps {
  role: ShellRole
}

const UI_CHANNEL = 'sidebar-ui'

function RibbonShell() {
  const { tabs, pinnedSites, activeTab, collapsed, side, dispatch } = useTabs()
  const uiChannel = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    uiChannel.current = new BroadcastChannel(UI_CHANNEL)
    return () => {
      uiChannel.current?.close()
      uiChannel.current = null
    }
  }, [])

  const handleTabClick = useCallback((id: number) => {
    if (collapsed) {
      if (activeTab?.id !== id) dispatch({ type: 'activate', id })
      dispatch({ type: 'toggleCollapsed' })
      return
    }
    if (activeTab?.id === id) {
      dispatch({ type: 'toggleCollapsed' })
      return
    }
    dispatch({ type: 'activate', id })
  }, [collapsed, activeTab?.id, dispatch])

  const handleNewTab = useCallback(() => {
    uiChannel.current?.postMessage({ type: 'pendingAddressFocus' })
    dispatch({ type: 'create' })
    if (collapsed) dispatch({ type: 'toggleCollapsed' })
  }, [collapsed, dispatch])

  const handlePinnedSiteClick = useCallback((siteId: string) => {
    const isThisPinnedTabActive = activeTab?.pinnedSiteId === siteId

    if (collapsed) {
      if (!isThisPinnedTabActive) {
        window.sidebarApi?.tabs.launchPinnedSite(siteId)
      }
      dispatch({ type: 'toggleCollapsed' })
      return
    }

    if (isThisPinnedTabActive) {
      dispatch({ type: 'toggleCollapsed' })
      return
    }

    window.sidebarApi?.tabs.launchPinnedSite(siteId)
  }, [activeTab?.pinnedSiteId, collapsed, dispatch])

  return (
    <div
      className={`app-layout ribbon-shell ${collapsed ? 'collapsed' : 'expanded'}`}
      data-side={side}
      style={{ '--ribbon-w': `${RIBBON_WIDTH}px` } as CSSProperties}
    >
      <TabStrip
        tabs={tabs}
        pinnedSites={pinnedSites}
        collapsed={collapsed}
        onActivate={handleTabClick}
        onNew={handleNewTab}
        onActivatePinnedSite={handlePinnedSiteClick}
        onPinnedSiteContextMenu={(id, x, y) => window.sidebarApi?.tabs.showPinnedContextMenu(id, x, y)}
      />
    </div>
  )
}

function PaneShell() {
  const { tabs, activeTab, collapsed, side, dispatch } = useTabs()
  const downloads = useDownloads()
  const [addressFocusRequest, setAddressFocusRequest] = useState(0)
  const pendingNewTabFocus = useRef(false)
  const previousTabCount = useRef(0)

  useEffect(() => {
    const chan = new BroadcastChannel(UI_CHANNEL)
    chan.onmessage = e => {
      if ((e.data as { type?: string })?.type === 'pendingAddressFocus') {
        pendingNewTabFocus.current = true
        setAddressFocusRequest(request => request + 1)
      }
    }
    return () => chan.close()
  }, [])

  useEffect(() => {
    const unsub = window.sidebarApi?.tabs.onAddressFocusRequest(() => {
      pendingNewTabFocus.current = true
      setAddressFocusRequest(request => request + 1)
    })
    return () => unsub?.()
  }, [])

  useEffect(() => {
    if (!pendingNewTabFocus.current) {
      previousTabCount.current = tabs.length
      return
    }

    if (tabs.length > previousTabCount.current) {
      pendingNewTabFocus.current = false
    }

    previousTabCount.current = tabs.length
  }, [activeTab?.url, tabs.length])

  return (
    <div
      className={`app-layout pane-shell ${collapsed ? 'collapsed' : 'expanded'}`}
      data-side={side}
      style={
        {
          '--ribbon-w': `${RIBBON_WIDTH}px`,
          '--resize-handle-w': `${INNER_RESIZE_HANDLE_WIDTH}px`,
        } as CSSProperties
      }
    >
      <div className="main-pane">
        <Toolbar
          activeTab={activeTab}
          collapsed={collapsed}
          focusRequest={addressFocusRequest}
          downloads={downloads}
          onBack={() => dispatch({ type: 'back' })}
          onForward={() => dispatch({ type: 'forward' })}
          onReload={() => dispatch({ type: 'reload' })}
          onNavigate={url => dispatch({ type: 'navigate', url })}
        />

        <div className="body-area">
          <div className="content-placeholder" aria-hidden="true" />
        </div>
      </div>

      <PaneResizeHandle side={side} collapsed={collapsed} />
    </div>
  )
}

function DownloadsShell() {
  const downloads = useDownloads()
  const api = window.sidebarApi

  const hasFinished = downloads.some(
    d => d.state !== 'progressing' && d.state !== 'paused',
  )

  return (
    <div className="downloads-shell">
      <div className="downloads-header">
        <span className="downloads-title">Downloads</span>
        <button
          className="downloads-clear"
          type="button"
          disabled={!hasFinished}
          onClick={() => api?.downloads.clearFinished()}
          title="Clear finished downloads"
        >
          Clear
        </button>
      </div>

      {downloads.length === 0 ? (
        <div className="downloads-empty">No downloads yet</div>
      ) : (
        <ul className="downloads-list">
          {downloads.map(d => {
            const inFlight = d.state === 'progressing' || d.state === 'paused'
            const pct = d.totalBytes > 0 ? Math.min(1, d.receivedBytes / d.totalBytes) : null
            return (
              <li key={d.id} className={`download-row ${d.state}`}>
                <button
                  className="download-main"
                  type="button"
                  disabled={d.state !== 'completed'}
                  onClick={() => api?.downloads.open(d.id)}
                  title={d.state === 'completed' ? `Open ${d.filename}` : d.filename}
                >
                  <span className="download-name">{d.filename}</span>
                  <span className="download-meta">{describeDownload(d, pct)}</span>
                  {inFlight && (
                    <span className="download-bar" aria-hidden="true">
                      <span
                        className={`download-bar-fill ${pct === null ? 'indeterminate' : ''}`}
                        style={
                          pct === null ? undefined : ({ width: `${Math.round(pct * 100)}%` } as CSSProperties)
                        }
                      />
                    </span>
                  )}
                </button>

                {inFlight ? (
                  <button
                    className="download-action"
                    type="button"
                    onClick={() => api?.downloads.cancel(d.id)}
                    title="Cancel"
                    aria-label={`Cancel ${d.filename}`}
                  >
                    ×
                  </button>
                ) : (
                  <button
                    className="download-action"
                    type="button"
                    disabled={d.state !== 'completed'}
                    onClick={() => api?.downloads.showInFolder(d.id)}
                    title="Show in folder"
                    aria-label={`Show ${d.filename} in folder`}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.6h5.5A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5Z" />
                    </svg>
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function describeDownload(d: DownloadInfo, pct: number | null): string {
  if (d.state === 'completed') return formatBytes(d.receivedBytes)
  if (d.state === 'cancelled') return 'Cancelled'
  if (d.state === 'interrupted') return 'Failed'
  if (d.state === 'paused') return `Paused — ${formatBytes(d.receivedBytes)}`
  if (pct === null) return formatBytes(d.receivedBytes)
  return `${formatBytes(d.receivedBytes)} of ${formatBytes(d.totalBytes)}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/**
 * The sliver that marks the screen edge while the shell is hidden.
 *
 * It handles nothing: the window is click-through, because Windows will not
 * make it as narrow as it asks and the surplus would swallow clicks on a left
 * dock. Bringing the shell back belongs to the main process now, which watches
 * the cursor in its auto-hide loop rather than waiting to be hovered.
 */
function EdgeShell() {
  return <div className="edge-peek-shell" aria-hidden="true" />
}

export default function App({ role }: ShellProps) {
  if (role === 'ribbon') return <RibbonShell />
  if (role === 'player') return <PlayerPreview />
  if (role === 'edge') return <EdgeShell />
  if (role === 'downloads') return <DownloadsShell />
  return <PaneShell />
}
