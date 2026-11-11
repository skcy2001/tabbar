import { useEffect, useRef, useState } from 'react'
import type { MediaPlayerInfo } from '../../shared/types'
import { useTabs } from '../state/useTabs'

export function PlayerPreview() {
  const { tabs, side } = useTabs()
  const [tabId, setTabId] = useState<number | null>(null)
  const [info, setInfo] = useState<MediaPlayerInfo | null>(null)
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [controlError, setControlError] = useState<string | null>(null)
  const pendingControls = useRef(new Set<number>())
  const mediaRequest = useRef(0)
  const currentTarget = useRef(tabId)
  currentTarget.current = tabId
  const shellRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    let receivedTarget = false
    const unsubscribe = window.sidebarApi?.shell.onPlayerTargetChange(id => {
      receivedTarget = true
      if (alive) setTabId(id)
    })
    window.sidebarApi?.shell.getPlayerTarget().then(id => {
      if (alive && !receivedTarget) setTabId(id)
    })
    return () => { alive = false; unsubscribe?.() }
  }, [])

  useEffect(() => {
    setInfo(null)
    setFailedArtwork(null)
    setControlError(null)
    setBusy(tabId != null && pendingControls.current.has(tabId))
    mediaRequest.current += 1
    if (tabId == null) return
    let cancelled = false
    let mediaTimer = 0
    const refreshMedia = async () => {
      if (pendingControls.current.has(tabId)) {
        mediaTimer = window.setTimeout(refreshMedia, 1000)
        return
      }
      const request = ++mediaRequest.current
      const next = await window.sidebarApi?.tabs.getAudioInfo(tabId).catch(() => null)
      if (cancelled) return
      if (request === mediaRequest.current && !pendingControls.current.has(tabId)) setInfo(next ?? null)
      mediaTimer = window.setTimeout(refreshMedia, 1000)
    }
    void refreshMedia()
    return () => {
      cancelled = true
      window.clearTimeout(mediaTimer)
    }
  }, [tabId])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    let lastHeight = 0
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(shell.getBoundingClientRect().height)
      if (height > 0 && Math.abs(height - lastHeight) >= 2) {
        lastHeight = height
        window.sidebarApi?.shell.resizePlayer(height)
      }
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  const tab = tabs.find(tab => tab.id === tabId)
  // A late media response must never appear under another tab's title.
  const media = info?.tabId === tabId ? info : null
  const artwork = media?.artworkUrl || null
  const favicon = media?.faviconDataUrl || tab?.faviconDataUrl
  const title = media?.title || tab?.title || 'Media preview'
  const available = !!media && media.hasMedia !== false
  const canPlay = available && media.canPlayPause !== false
  const canNext = available && media.canNextTrack !== false
  const canMute = available && media.canMute !== false
  const control = async (action: 'togglePlayPause' | 'nextTrack' | 'toggleMute') => {
    const id = tabId
    if (id == null || pendingControls.current.has(id)) return
    if (!(action === 'togglePlayPause' ? canPlay : action === 'nextTrack' ? canNext : canMute)) return
    pendingControls.current.add(id)
    mediaRequest.current += 1 // Discard any poll started before this action.
    setBusy(true)
    setControlError(null)
    try {
      const result = await window.sidebarApi?.tabs[action](id)
      if (currentTarget.current === id && action === 'nextTrack' && result === false) {
        setControlError('No next track is available.')
      }
    } catch {
      if (currentTarget.current === id) setControlError('Couldn’t control this track. Open the tab to continue.')
    } finally {
      if (currentTarget.current === id) {
        const request = ++mediaRequest.current
        const next = await window.sidebarApi?.tabs.getAudioInfo(id).catch(() => null)
        if (currentTarget.current === id && request === mediaRequest.current) setInfo(next ?? null)
      }
      pendingControls.current.delete(id)
      if (currentTarget.current === id) setBusy(false)
    }
  }

  return (
    <div ref={shellRef} className="player-shell" data-side={side}
      onMouseEnter={() => window.sidebarApi?.shell.keepPlayerOpen()}
      onMouseLeave={() => window.sidebarApi?.shell.hidePlayer()}>
      <div className="player-header">
        {favicon ? <img className="player-favicon" src={favicon} alt="" /> : <MusicIcon />}
        <span className="player-window-title" title={[title, media?.artist].filter(Boolean).join(' — ')}>{title}</span>
      </div>
      <button className="player-thumbnail" type="button" aria-label={`Open ${title}`}
        onClick={() => window.sidebarApi?.shell.openPlayerTarget()}>
        <span key={tabId} className="player-thumbnail-content">
          {artwork && failedArtwork !== artwork
            ? <img src={artwork} alt="Media artwork" draggable={false} onError={() => setFailedArtwork(artwork)} />
            : <span className="player-thumbnail-placeholder"><MusicIcon /></span>}
        </span>
      </button>
      <div className="player-controls" aria-label="Media controls" aria-busy={busy}>
        <button className="player-btn" type="button" onClick={() => void control('togglePlayPause')}
          disabled={busy || !canPlay}
          aria-label={media?.isPlaying ? 'Pause' : 'Play'} title={media?.isPlaying ? 'Pause' : 'Play'}>
          <MediaIcon kind={media?.isPlaying ? 'pause' : 'play'} />
        </button>
        <button className="player-btn" type="button" onClick={() => void control('nextTrack')} disabled={busy || !canNext} aria-label="Next" title="Next">
          <MediaIcon kind="next" />
        </button>
        <button className="player-btn" type="button" onClick={() => void control('toggleMute')}
          disabled={busy || !canMute}
          aria-label={media?.isMuted ? 'Unmute' : 'Mute'} title={media?.isMuted ? 'Unmute' : 'Mute'}>
          <MediaIcon kind={media?.isMuted ? 'muted' : 'volume'} />
        </button>
      </div>
      {controlError && <div className="player-control-error" role="status">{controlError}</div>}
    </div>
  )
}

function MusicIcon() {
  return <svg className="player-window-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 11V4l7-2v7M6 6l7-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <ellipse cx="4" cy="12" rx="2" ry="1.5" fill="currentColor" />
    <ellipse cx="11" cy="10" rx="2" ry="1.5" fill="currentColor" />
  </svg>
}

function MediaIcon({ kind }: { kind: 'play' | 'pause' | 'next' | 'volume' | 'muted' }) {
  const paths = {
    play: 'M5 3v10l8-5-8-5Z',
    pause: 'M4 3h3v10H4V3Zm5 0h3v10H9V3Z',
    next: 'M3 3v10l7-5-7-5Zm8 0h2v10h-2V3Z',
    volume: 'M8 3 4.5 6H2v4h2.5L8 13V3Zm3 1.5-.9.9a3.7 3.7 0 0 1 0 5.2l.9.9a5 5 0 0 0 0-7Z',
    muted: 'M8 3 4.5 6H2v4h2.5L8 13V3Zm2.7 2.7-.9.9L11.2 8 9.8 9.4l.9.9 1.4-1.4 1.4 1.4.9-.9L13 8l1.4-1.4-.9-.9-1.4 1.4-1.4-1.4Z',
  }
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d={paths[kind]} /></svg>
}
