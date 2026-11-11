import React, { useState, useRef, useEffect } from 'react'
import type { DownloadInfo, TabInfo } from '../../shared/types'

interface Props {
  activeTab: TabInfo | null
  collapsed: boolean
  focusRequest: number
  downloads: DownloadInfo[]
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onNavigate: (url: string) => void
}

export function Toolbar({
  activeTab,
  collapsed,
  focusRequest,
  downloads,
  onBack,
  onForward,
  onReload,
  onNavigate,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [inputVal, setInputVal] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef(false)
  const lastAppliedFocusRequest = useRef(0)

  useEffect(() => {
    if (!editing) setInputVal(activeTab?.url ?? '')
  }, [activeTab?.url, editing])

  useEffect(() => {
    setEditing(false)
    setInputVal(activeTab?.url ?? '')
  }, [activeTab?.id])

  useEffect(() => {
    if (focusRequest === 0) return
    pendingFocus.current = true
    if (collapsed) return
    // Apply immediately when pane is visible.
    lastAppliedFocusRequest.current = focusRequest
    pendingFocus.current = false
    setInputVal('')
    setEditing(true)
  }, [collapsed, focusRequest])

  useEffect(() => {
    if (collapsed) return
    if (!pendingFocus.current) return
    // Apply after expand OR after tab creation finishes swapping activeTab.
    lastAppliedFocusRequest.current = focusRequest
    pendingFocus.current = false
    setInputVal('')
    setEditing(true)
  }, [collapsed])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing, focusRequest])

  useEffect(() => {
    // If we just requested focus (plus button), don't immediately cancel editing
    // due to the new activeTab swapping in.
    if (collapsed) {
      setEditing(false)
      setInputVal(activeTab?.url ?? '')
      return
    }
    if (pendingFocus.current) return
    if (lastAppliedFocusRequest.current === focusRequest && editing) return
    // When active tab changes via normal clicks, exit editing mode.
    setEditing(false)
    setInputVal(activeTab?.url ?? '')
  }, [activeTab?.id])

  const commit = () => {
    setEditing(false)
    if (inputVal.trim()) onNavigate(inputVal.trim())
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') { setEditing(false); setInputVal(activeTab?.url ?? '') }
  }

  const title = activeTab?.title?.trim() || displayUrl(activeTab?.url)
  const activeDownloads = downloads.filter(d => d.state === 'progressing' || d.state === 'paused')
  const downloadProgress = overallProgress(activeDownloads)

  const openDownloads = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    // Anchor just under the button, in screen coordinates.
    window.sidebarApi?.downloads.togglePanel(
      window.screenX + r.left + r.width / 2,
      window.screenY + r.bottom + 4,
    )
  }

  return (
    <div className={`toolbar ${editing ? 'editing' : ''} ${downloads.length > 0 ? 'has-downloads' : ''}`}>
      {!collapsed && (
        <>
          <div className="toolbar-title" title={title}>
            {title}
          </div>

          <div className="toolbar-controls">
            <button
              className="toolbar-btn"
              disabled={!activeTab?.canGoBack}
              onClick={onBack}
              title="Back"
              aria-label="Go back"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11 2 5 8l6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>

            <button
              className="toolbar-btn"
              disabled={!activeTab?.canGoForward}
              onClick={onForward}
              title="Forward"
              aria-label="Go forward"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5 2l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>

            <button
              className="toolbar-btn"
              onClick={onReload}
              title="Reload"
              aria-label="Reload"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M13.5 2.5A6.5 6.5 0 1 1 7 1.5"/>
                <path d="M7 1.5V5l2.5-2L7 1.5Z" fill="currentColor" stroke="none"/>
              </svg>
            </button>

            <div className="url-bar-wrap">
              {editing ? (
                <input
                  ref={inputRef}
                  className="url-input"
                  value={inputVal}
                  onChange={e => setInputVal(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={commit}
                  spellCheck={false}
                  autoFocus
                />
              ) : (
                <button
                  className="url-display"
                  onClick={() => {
                    setInputVal(activeTab?.url ?? '')
                    setEditing(true)
                    setTimeout(() => inputRef.current?.select(), 10)
                  }}
                  title={activeTab?.url}
                >
                  <span className="url-text">{displayUrl(activeTab?.url)}</span>
                </button>
              )}
            </div>
          </div>

          {/* Outside .toolbar-controls: that container is hidden until hover, and
              these need to stay visible. */}
          <div className="toolbar-corner">
            {window.sidebarApi?.tabs.toggleFullscreen && (
              <button className="toolbar-btn" onClick={() => window.sidebarApi.tabs.toggleFullscreen?.()} title="Toggle fullscreen" aria-label="Toggle fullscreen">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" /></svg>
              </button>
            )}
            {downloads.length > 0 && (
              <button
                className={`toolbar-btn downloads-btn ${activeDownloads.length > 0 ? 'active' : ''}`}
                onClick={openDownloads}
                title={
                  activeDownloads.length > 0
                    ? `${activeDownloads.length} downloading`
                    : 'Downloads'
                }
                aria-label="Downloads"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v8" />
                  <path d="M4.5 7 8 10.5 11.5 7" />
                  <path d="M2.5 13h11" />
                </svg>
                {downloadProgress !== null && (
                  <span
                    className="downloads-progress"
                    style={{ '--p': `${Math.round(downloadProgress * 100)}%` } as React.CSSProperties}
                    aria-hidden="true"
                  />
                )}
              </button>
            )}

            <button
              className="toolbar-btn open-external-btn"
              disabled={!isWebUrl(activeTab?.url)}
              onClick={() => window.sidebarApi?.tabs.openActiveInDefaultBrowser()}
              title="Open in default browser"
              aria-label="Open in default browser"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 2.5h4.5V7" />
                <path d="M13.5 2.5 7.5 8.5" />
                <path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Combined 0..1 progress across in-flight downloads, or null when unknowable. */
function overallProgress(active: DownloadInfo[]): number | null {
  if (active.length === 0) return null
  const total = active.reduce((sum, d) => sum + d.totalBytes, 0)
  if (total <= 0) return null
  const received = active.reduce((sum, d) => sum + d.receivedBytes, 0)
  return Math.min(1, received / total)
}

/** Only http(s) pages can meaningfully be handed to the OS browser. */
function isWebUrl(url?: string): boolean {
  if (!url) return false
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function displayUrl(url?: string) {
  if (!url) return 'about:blank'
  try {
    const u = new URL(url)
    return u.hostname + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}
