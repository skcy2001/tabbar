import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { PinnedSiteInfo, TabInfo } from '../../shared/types'

interface Props {
  tabs: TabInfo[]
  pinnedSites: PinnedSiteInfo[]
  collapsed: boolean
  onActivate: (id: number) => void
  onNew: () => void
  onActivatePinnedSite: (id: string) => void
  onPinnedSiteContextMenu: (id: string, clientX: number, clientY: number) => void
}

const DRAG_COMMIT_MIN_SQ = 16
const REORDER_MIN_SQ = 16

// ---- Favicon ----

function FaviconImg({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false)
  const letter = title?.[0]?.toUpperCase() ?? '?'

  if (!url || failed) {
    return <span className="tab-favicon-letter" aria-hidden="true">{letter}</span>
  }

  return (
    <img
      src={url}
      alt=""
      className="tab-favicon-img"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}

function DragRegionGripIcon() {
  return (
    <svg
      className="ribbon-drag-grip-icon"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="6" cy="5" r="1.35" opacity="0.85" />
      <circle cx="12" cy="5" r="1.35" opacity="0.85" />
      <circle cx="6" cy="9" r="1.35" opacity="0.85" />
      <circle cx="12" cy="9" r="1.35" opacity="0.85" />
      <circle cx="6" cy="13" r="1.35" opacity="0.85" />
      <circle cx="12" cy="13" r="1.35" opacity="0.85" />
    </svg>
  )
}

type DragPayload =
  | { kind: 'pinned'; id: string }
  | { kind: 'tab'; id: number }

function parseDragTarget(el: Element | null): DragPayload | null {
  if (!el) return null
  const pinned = el.closest<HTMLElement>('.pinned-site-btn')
  if (pinned) {
    const id = pinned.dataset.siteId
    if (id) return { kind: 'pinned', id }
  }
  const tab = el.closest<HTMLElement>('.tab-item')
  if (tab) {
    const raw = tab.dataset.tabId
    const id = raw ? Number(raw) : NaN
    if (Number.isFinite(id)) return { kind: 'tab', id }
  }
  return null
}

/** Commit ribbon+pane placement on pointer release; window does not move during drag (no native drag). */
function RibbonPlacementHandle() {
  const startRef = useRef<{ x: number; y: number } | null>(null)

  const endGesture = (el: HTMLElement, pointerId: number) => {
    try {
      el.releasePointerCapture(pointerId)
    } catch {
      /* already released */
    }
    window.sidebarApi?.shell.setDragging(false)
    startRef.current = null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    startRef.current = { x: e.screenX, y: e.screenY }
    window.sidebarApi?.shell.setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    const start = startRef.current
    if (!start) return
    const dx = e.screenX - start.x
    const dy = e.screenY - start.y
    const moved = dx * dx + dy * dy >= DRAG_COMMIT_MIN_SQ
    endGesture(e.currentTarget, e.pointerId)
    if (!moved) return
    window.sidebarApi?.shell.commitPlacement(e.screenX, e.screenY)
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    endGesture(e.currentTarget, e.pointerId)
  }

  return (
    <button
      type="button"
      className="ribbon-drag-handle"
      title="Drag, then release — dock to nearest screen edge"
      aria-label="Move Tabbar to screen edge"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <DragRegionGripIcon />
    </button>
  )
}

// ---- Tab strip ----

export function TabStrip({
  tabs,
  pinnedSites,
  collapsed,
  onActivate,
  onNew,
  onActivatePinnedSite,
  onPinnedSiteContextMenu,
}: Props) {
  const dragStart = useRef<{ x: number; y: number; payload: DragPayload } | null>(null)
  const isReorderDragging = useRef(false)
  const recentReorder = useRef(false)
  const [insertHint, setInsertHint] = useState<{ kind: DragPayload['kind']; targetId: string | number; before: boolean } | null>(null)
  const pendingDrop = useRef<{ target: DragPayload; before: boolean } | null>(null)
  // Set while a drag has crossed the divider, turning the drop into a pin/unpin.
  const [crossHint, setCrossHint] = useState<'pin' | 'unpin' | null>(null)
  const pendingCross = useRef<'pin' | 'unpin' | null>(null)
  const playerHoverTimer = useRef<number | null>(null)
  const cancelPlayerHover = () => {
    if (playerHoverTimer.current != null) window.clearTimeout(playerHoverTimer.current)
    playerHoverTimer.current = null
  }
  useEffect(() => cancelPlayerHover, [])

  const handleContextMenu = (e: React.MouseEvent, tabId: number) => {
    e.preventDefault()
    window.sidebarApi?.tabs.showContextMenu(tabId, e.clientX, e.clientY)
  }

  const handleEmptyStripContextMenu = (e: React.MouseEvent) => {
    const target = e.target
    if (!(target instanceof Element)) return
    // Only on empty background (not on a tab/pin/new/drag/etc).
    if (target.closest('.tab-item, .pinned-site-btn, .tab-new-btn, .ribbon-drag-handle, .mini-player')) return
    e.preventDefault()
    window.sidebarApi?.shell.showContextMenu(e.clientX, e.clientY)
  }

  const activePinnedSiteId = tabs.find(tab => tab.isActive)?.pinnedSiteId
  const pinnedUnreadBySiteId = useMemo(() => {
    const m = new Map<string, { count?: number; dot?: boolean }>()
    for (const t of tabs) {
      if (t.pinnedSiteId) m.set(t.pinnedSiteId, { count: t.unreadCount, dot: t.unreadDot })
    }
    return m
  }, [tabs])
  const pinnedOpenTabIdBySiteId = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tabs) {
      if (t.pinnedSiteId) m.set(t.pinnedSiteId, t.id)
    }
    return m
  }, [tabs])
  const unpinnedTabs = tabs.filter(tab => !tab.pinnedSiteId)
  const showPinnedDivider = pinnedSites.length > 0 && unpinnedTabs.length > 0

  const tabHasPlayerMedia = (tab: TabInfo) => tab.hasMedia === true
  const shouldShowPlayer = (tab: TabInfo) => tabHasPlayerMedia(tab) && (collapsed || !tab.isActive)

  const showPlayerWindow = (tabId: number, anchorEl: HTMLElement) => {
    const iconEl = anchorEl.querySelector<HTMLElement>('.tab-icon') ?? anchorEl
    const r = iconEl.getBoundingClientRect()
    const screenX = window.screenX + r.right
    const screenY = window.screenY + r.top + r.height / 2
    const anchorX = window.screenX + r.left
    const anchorY = window.screenY + r.top
    window.sidebarApi?.shell.showPlayer(tabId, screenX, screenY, anchorX, anchorY, r.width, r.height)
  }

  const handleAudioHover = (tab: TabInfo | undefined, anchorEl: HTMLElement) => {
    cancelPlayerHover()
    if (!tab || !shouldShowPlayer(tab)) return
    playerHoverTimer.current = window.setTimeout(() => {
      playerHoverTimer.current = null
      if (anchorEl.isConnected) showPlayerWindow(tab.id, anchorEl)
    }, 100)
  }

  const onStripPointerDownCapture = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // Prevent auto-hide while the user is interacting (including reordering icons).
    window.sidebarApi?.shell.setDragging(true)
    const payload = parseDragTarget(e.target instanceof Element ? e.target : null)
    if (!payload) return
    dragStart.current = { x: e.clientX, y: e.clientY, payload }
    isReorderDragging.current = false
    pendingDrop.current = null
    pendingCross.current = null
    setInsertHint(null)
    setCrossHint(null)
  }

  const onStripPointerMoveCapture = (e: React.PointerEvent) => {
    const start = dragStart.current
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    const moved = dx * dx + dy * dy >= REORDER_MIN_SQ
    if (!moved) return
    isReorderDragging.current = true

    const kind = start.payload.kind

    // Dragging over the far side of the divider converts the drop into a
    // pin (tab -> pinned) or unpin (pinned -> tabs).
    const zone = zoneAtY(e.clientY)
    const cross: 'pin' | 'unpin' | null =
      zone === null
        ? null
        : kind === 'tab' && zone === 'pinned'
        ? 'pin'
        : kind === 'pinned' && zone === 'tabs'
        ? 'unpin'
        : null

    if (cross) {
      pendingCross.current = cross
      pendingDrop.current = null
      setCrossHint(cross)
      setInsertHint(null)
      return
    }

    pendingCross.current = null
    setCrossHint(null)

    const selector = kind === 'pinned' ? '.pinned-site-btn' : '.tab-item'
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector))
    if (nodes.length === 0) return

    // Compute insertion location purely from mouse Y, so the placeholder follows the pointer
    // even when you're between icons or over the placeholder itself.
    let best: { target: DragPayload; before: boolean } | null = null
    for (const node of nodes) {
      const r = node.getBoundingClientRect()
      const mid = r.top + r.height / 2
      if (e.clientY <= mid) {
        const payload = parseDragTarget(node)
        if (payload && payload.kind === kind) {
          best = { target: payload, before: true }
        }
        break
      }
    }
    if (!best) {
      const last = nodes[nodes.length - 1]
      const payload = parseDragTarget(last)
      if (payload && payload.kind === kind) {
        best = { target: payload, before: false }
      }
    }
    if (!best) return

    // Dropping onto yourself, or either side adjacent to yourself, lands the item
    // exactly where it already is. The main process discards those, so showing an
    // insert line would promise a move that never happens.
    const ids = nodes.map(n => parseDragTarget(n)?.id)
    const fromIdx = ids.indexOf(start.payload.id)
    const toIdx = ids.indexOf(best.target.id)
    if (fromIdx !== -1 && toIdx !== -1 && resolvesToSamePosition(fromIdx, toIdx, best.before, nodes.length)) {
      pendingDrop.current = null
      setInsertHint(null)
      return
    }

    pendingDrop.current = best
    setInsertHint({ kind, targetId: best.target.id, before: best.before })
  }

  const onStripPointerUpCapture = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    window.sidebarApi?.shell.setDragging(false)
    const start = dragStart.current
    dragStart.current = null
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    const moved = dx * dx + dy * dy >= REORDER_MIN_SQ
    setInsertHint(null)
    setCrossHint(null)
    isReorderDragging.current = false
    const cross = pendingCross.current
    pendingCross.current = null
    if (!moved) return

    if (cross) {
      // Suppress the click that follows this pointer-up, so pinning does not
      // also activate the icon under the cursor.
      recentReorder.current = true
      window.setTimeout(() => { recentReorder.current = false }, 0)
      if (cross === 'pin' && start.payload.kind === 'tab') {
        window.sidebarApi?.tabs.pin(start.payload.id)
      } else if (cross === 'unpin' && start.payload.kind === 'pinned') {
        window.sidebarApi?.tabs.unpin(start.payload.id)
      }
      return
    }

    const drop = pendingDrop.current
    pendingDrop.current = null
    const target = drop?.target ?? parseDragTarget(document.elementFromPoint(e.clientX, e.clientY))
    const before = drop?.before ?? true
    if (!target) return

    if (start.payload.kind === 'pinned' && target.kind === 'pinned') {
      recentReorder.current = true
      window.setTimeout(() => { recentReorder.current = false }, 0)
      window.sidebarApi?.tabs.reorderPinned(start.payload.id, target.id, before)
      return
    }
    if (start.payload.kind === 'tab' && target.kind === 'tab') {
      recentReorder.current = true
      window.setTimeout(() => { recentReorder.current = false }, 0)
      window.sidebarApi?.tabs.dispatch({ type: 'reorderTabs', fromId: start.payload.id, toId: target.id, before })
    }
  }

  const onStripPointerCancelCapture = () => {
    window.sidebarApi?.shell.setDragging(false)
    dragStart.current = null
    pendingDrop.current = null
    pendingCross.current = null
    isReorderDragging.current = false
    setInsertHint(null)
    setCrossHint(null)
  }

  return (
    <div
      className="tab-strip"
      role="tablist"
      aria-orientation="vertical"
      onContextMenu={handleEmptyStripContextMenu}
      onPointerDownCapture={onStripPointerDownCapture}
      onPointerMoveCapture={onStripPointerMoveCapture}
      onPointerUpCapture={onStripPointerUpCapture}
      onPointerCancelCapture={onStripPointerCancelCapture}
    >
      <div className="tab-list">
        <button
          className="tab-new-btn"
          title="New tab"
          onClick={onNew}
          aria-label="New tab"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z" />
          </svg>
        </button>

        {pinnedSites.length > 0 && (
          <div className="pinned-site-list" aria-label="Pinned sites">
            {pinnedSites.flatMap(site => {
              const unread = pinnedUnreadBySiteId.get(site.id)
              const audio = tabs.some(t => t.pinnedSiteId === site.id && tabHasPlayerMedia(t))
              const openTabId = pinnedOpenTabIdBySiteId.get(site.id) ?? null
              const placeholderBefore =
                insertHint?.kind === 'pinned' &&
                insertHint.targetId === site.id &&
                insertHint.before
              const placeholderAfter =
                insertHint?.kind === 'pinned' &&
                insertHint.targetId === site.id &&
                !insertHint.before
              const parts: React.ReactNode[] = []
              if (placeholderBefore) {
                parts.push(<div key={`ph-pinned-${site.id}-before`} className="reorder-placeholder" aria-hidden="true" />)
              }
              parts.push(
                <button
                  key={`pinned-${site.id}`}
                  className={`pinned-site-btn ${site.id === activePinnedSiteId ? 'active' : ''}`}
                  data-site-id={site.id}
                  title={audio && (collapsed || site.id !== activePinnedSiteId) ? undefined : site.title}
                  onClick={() => {
                    if (recentReorder.current) return
                    onActivatePinnedSite(site.id)
                  }}
                  onContextMenu={e => {
                    e.preventDefault()
                    onPinnedSiteContextMenu(site.id, e.clientX, e.clientY)
                  }}
                  onMouseEnter={e => {
                    if (openTabId == null) return
                    const tab = tabs.find(t => t.id === openTabId)
                    handleAudioHover(tab, e.currentTarget as HTMLElement)
                  }}
                  onMouseLeave={() => {
                    cancelPlayerHover()
                    window.sidebarApi?.shell.hidePlayer()
                  }}
                  aria-label={site.title}
                >
                  <span className={`tab-icon ${audio ? 'audio' : ''}`}>
                    <FaviconImg url={site.faviconDataUrl} title={site.title} />
                    <UnreadBadge count={unread?.count} dot={unread?.dot} />
                    {audio && <span className="tab-audio-badge" aria-hidden="true" />}
                  </span>
                </button>
              )
              if (placeholderAfter) {
                parts.push(<div key={`ph-pinned-${site.id}-after`} className="reorder-placeholder" aria-hidden="true" />)
              }
              return parts
            })}
            {crossHint === 'pin' && (
              <div className="reorder-placeholder" aria-hidden="true" />
            )}
          </div>
        )}

        {showPinnedDivider && (
          <div className="tab-strip-pinned-divider" aria-hidden="true" />
        )}

        {crossHint === 'unpin' && (
          <div className="reorder-placeholder" aria-hidden="true" />
        )}

        {unpinnedTabs.flatMap(tab => {
          const audio = tabHasPlayerMedia(tab)
          const placeholderBefore =
            insertHint?.kind === 'tab' &&
            insertHint.targetId === tab.id &&
            insertHint.before
          const placeholderAfter =
            insertHint?.kind === 'tab' &&
            insertHint.targetId === tab.id &&
            !insertHint.before
          const parts: React.ReactNode[] = []
          if (placeholderBefore) {
            parts.push(<div key={`ph-tab-${tab.id}-before`} className="reorder-placeholder" aria-hidden="true" />)
          }
          parts.push(
            <div
              key={`tab-${tab.id}`}
              role="tab"
              aria-label={tab.title}
              aria-selected={tab.isActive}
              data-tab-id={tab.id}
              className={`tab-item ${tab.isActive ? 'active' : ''}`}
              onClick={() => {
                if (recentReorder.current) return
                onActivate(tab.id)
              }}
              onContextMenu={e => handleContextMenu(e, tab.id)}
              onMouseEnter={e => {
                handleAudioHover(tab, e.currentTarget as HTMLElement)
              }}
              onMouseLeave={() => {
                cancelPlayerHover()
                window.sidebarApi?.shell.hidePlayer()
              }}
              title={shouldShowPlayer(tab) ? undefined : tab.title}
            >
              <span className={`tab-icon ${audio ? 'audio' : ''}`}>
                <FaviconImg url={tab.faviconDataUrl} title={tab.title} />
                <UnreadBadge count={tab.unreadCount} dot={tab.unreadDot} />
                {audio && <span className="tab-audio-badge" aria-hidden="true" />}
              </span>
            </div>
          )
          if (placeholderAfter) {
            parts.push(<div key={`ph-tab-${tab.id}-after`} className="reorder-placeholder" aria-hidden="true" />)
          }
          return parts
        })}
      </div>

      <RibbonPlacementHandle />
    </div>
  )
}

/**
 * Whether a drop would leave the item at its current index. Mirrors the splice
 * arithmetic in TabManager.reorderTabs, so the hint and the result agree.
 */
function resolvesToSamePosition(fromIdx: number, toIdx: number, before: boolean, count: number): boolean {
  if (fromIdx === toIdx) return true
  let targetIdx = toIdx
  if (fromIdx < toIdx) targetIdx -= 1
  if (!before) targetIdx += 1
  targetIdx = Math.max(0, Math.min(count - 1, targetIdx))
  return targetIdx === fromIdx
}

/**
 * Which side of the pinned/unpinned divider a pointer is on. Returns null when
 * there is no divider to cross — with nothing pinned yet there is no line, and
 * treating the top of the strip as a pin zone would break reorder-to-first.
 */
function zoneAtY(clientY: number): 'pinned' | 'tabs' | null {
  const list = document.querySelector('.pinned-site-list')
  if (!list) return null
  const divider = document.querySelector('.tab-strip-pinned-divider')
  const boundary = divider
    ? divider.getBoundingClientRect().bottom
    : list.getBoundingClientRect().bottom
  return clientY <= boundary ? 'pinned' : 'tabs'
}

/** Renders the unread count parsed in the main process, or a plain dot. */
function UnreadBadge({ count, dot }: { count?: number; dot?: boolean }) {
  if (count && count > 0) {
    return (
      <span className="tab-unread-count" aria-label={`${count} unread`}>
        {count > 99 ? '99+' : count}
      </span>
    )
  }
  if (dot) return <span className="tab-unread-dot" aria-label="unread" />
  return null
}
