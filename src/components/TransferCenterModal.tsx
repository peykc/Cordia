import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowUpDown } from 'lucide-react'
import { WebviewWindow } from '@tauri-apps/api/window'
import { useWindowSize } from '../lib/useWindowSize'
import { Button } from './ui/button'
import { useTransferCenterModal } from '../contexts/TransferCenterModalContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { TransferCenterPanel } from './TransferCenterPanel'
import { cn } from '../lib/utils'

const GAP_BELOW_ICON = 8
const H_GUTTER = 16
const V_GUTTER = 16
/** Upper bound for popup panel height (viewport clamp still applies on small windows). */
const POPUP_MAX_HEIGHT_PX = 555
/** Upper bound for popup panel width (viewport clamp still applies on narrow windows). */
const POPUP_MAX_WIDTH_PX = 655

function clampPopupLeft(left: number, popupWidth: number, vw: number): number {
  const maxLeft = vw - H_GUTTER - popupWidth
  return Math.max(H_GUTTER, Math.min(left, maxLeft))
}

/** Popup panel is fixed just under the transfer toolbar icon; recenters on resize/scroll. */
export function TransferCenterModal() {
  const { isOpen, closeTransferCenter, anchorRect, anchorRef } = useTransferCenterModal()
  const { width, height } = useWindowSize()
  const { refreshSharedAttachments, refreshTransferHistoryAccessibility } = useEphemeralMessages()
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({})

  const layoutPanel = useCallback(() => {
    const el = anchorRef.current
    const rect = el?.getBoundingClientRect() ?? anchorRect
    if (!rect) return
    const horizontalPad = H_GUTTER * 2
    /** Never wider than viewport minus gutters. */
    const maxUsableWidth = Math.max(0, width - horizontalPad)
    const popupWidth = Math.min(POPUP_MAX_WIDTH_PX, maxUsableWidth)
    let top = rect.bottom + GAP_BELOW_ICON
    let availableHeight = height - top - V_GUTTER
    /** If anchor is low, pull the panel up so it fits vertically. */
    const minDesiredH = 200
    if (availableHeight < minDesiredH) {
      top = Math.max(V_GUTTER, height - V_GUTTER - Math.max(minDesiredH, Math.floor(height * 0.92)))
      availableHeight = height - top - V_GUTTER
    }
    availableHeight = Math.max(0, availableHeight)
    const left = clampPopupLeft(rect.left, popupWidth, width)
    const popupMaxHeight = Math.max(
      120,
      Math.min(availableHeight, Math.floor(height * 0.92), POPUP_MAX_HEIGHT_PX)
    )
    const minH = Math.min(420, Math.max(160, popupMaxHeight))
    const safeMinH = Math.min(minH, popupMaxHeight)
    setPanelStyle({
      top,
      left,
      width: popupWidth,
      maxHeight: popupMaxHeight,
      minHeight: safeMinH,
    })
  }, [anchorRect, anchorRef, width, height])

  useLayoutEffect(() => {
    if (!isOpen) {
      setPanelStyle({})
      return
    }
    layoutPanel()
    const onMove = () => layoutPanel()
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [isOpen, layoutPanel])

  useEffect(() => {
    if (!isOpen) return
    refreshSharedAttachments().catch(() => {})
    const t = window.setTimeout(() => {
      refreshTransferHistoryAccessibility().catch(() => {})
    }, 180)
    return () => window.clearTimeout(t)
  }, [isOpen, refreshSharedAttachments, refreshTransferHistoryAccessibility])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTransferCenter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, closeTransferCenter])

  if (!isOpen) return null

  const popupEl = (
    <div className="fixed inset-0 z-[70] pointer-events-none">
      {/*
        Transparent scrim: closes on outside click without dimming/blurring the app (avoids color mismatch behind the popup).
      */}
      <div
        className="absolute inset-0 bg-transparent pointer-events-auto"
        aria-hidden
        onMouseDown={closeTransferCenter}
      />
      <div
        className={cn(
          'fixed z-[71] flex flex-col overflow-hidden rounded-none border-2 border-border/70',
          'bg-[hsl(220deg_7%_20%_/_50%)] backdrop-blur-md shadow-2xl ring-1 ring-black/10 dark:ring-white/10',
          'pointer-events-auto'
        )}
        style={panelStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 border-b border-border/60 px-3 py-3 flex items-center gap-2.5 bg-[hsl(220deg_7%_20%_/_85%)] min-h-[52px]">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={closeTransferCenter} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/70">
            <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
          </div>
          <h1 className="min-w-0 flex-1 text-sm font-medium tracking-tight text-foreground flex items-center min-h-9">
            Transfers
          </h1>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden px-3 py-3 flex flex-col">
          <TransferCenterPanel variant="popup" />
        </div>
        <footer className="shrink-0 border-t border-border/60 px-3 py-2 flex items-center justify-center bg-muted/20">
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            onClick={() => {
              const existing = WebviewWindow.getByLabel('transfers-window')
              if (existing) {
                existing.setFocus()
              } else {
                new WebviewWindow('transfers-window', {
                  title: 'Transfers',
                  width: 1024,
                  height: 720,
                  minWidth: 800,
                  minHeight: 560,
                  resizable: true,
                  decorations: false,
                  url: '/transfers',
                })
              }
              closeTransferCenter()
            }}
          >
            Open full transfer hub window
          </button>
        </footer>
      </div>
    </div>
  )

  if (typeof document === 'undefined') return null
  return createPortal(popupEl, document.body)
}
