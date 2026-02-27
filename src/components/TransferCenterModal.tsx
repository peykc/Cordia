import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowUpDown } from 'lucide-react'
import { WebviewWindow } from '@tauri-apps/api/window'
import { useWindowSize } from '../lib/useWindowSize'
import { Button } from './ui/button'
import { useTransferCenterModal } from '../contexts/TransferCenterModalContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { TransferCenterPanel } from './TransferCenterPanel'

export function TransferCenterModal() {
  const { isOpen, anchorRect, anchorRef, closeTransferCenter } = useTransferCenterModal()
  const { width, height } = useWindowSize()
  const effectiveAnchorRect = isOpen
    ? (anchorRef?.current?.getBoundingClientRect() ?? anchorRect)
    : null
  const isSmall = width < 1080
  const { transferHistory, sharedAttachments, refreshSharedAttachments, refreshTransferHistoryAccessibility } = useEphemeralMessages()

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

  const downloadRowsCount = useMemo(
    () => transferHistory.filter((h) => h.direction === 'download').length,
    [transferHistory]
  )

  const uploadRowsCount = useMemo(() => {
    const shas = new Set<string>()
    for (const s of sharedAttachments) shas.add(s.sha256 || s.attachment_id)
    return shas.size
  }, [sharedAttachments])

  if (!isOpen || !effectiveAnchorRect) return null

  const popupWidth = Math.min(isSmall ? 430 : 760, width - 24)
  const rowHeight = 52
  const rowGap = 6
  const maxListEntries = 6
  const visibleDownloadRows = downloadRowsCount === 0 ? 0 : Math.min(downloadRowsCount, maxListEntries)
  const visibleUploadRows = uploadRowsCount === 0 ? 0 : Math.min(uploadRowsCount, maxListEntries)
  const visibleRows = Math.max(visibleDownloadRows, visibleUploadRows, 1)
  const listHeight = visibleRows * rowHeight + (visibleRows - 1) * rowGap
  const headerHeight = 40
  const footerHeight = 40
  const sectionHeaders = 20
  const contentPadding = 12
  const contentHeight = sectionHeaders + listHeight
  const popupHeight = Math.min(
    headerHeight + footerHeight + contentPadding * 2 + contentHeight,
    height - 24
  )
  const gutter = 10
  const topBarHeight = 96

  let left = Math.round(effectiveAnchorRect.right - popupWidth)
  left = Math.max(gutter, Math.min(left, width - popupWidth - gutter))
  let top = Math.round(effectiveAnchorRect.bottom + 8)
  if (top + popupHeight > height - gutter) {
    top = Math.round(effectiveAnchorRect.top - popupHeight - 8)
  }
  top = Math.max(topBarHeight, Math.min(top, height - popupHeight - gutter))

  const popupEl = (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 cursor-default" onMouseDown={closeTransferCenter} />
      <div
        className="absolute border-2 border-border bg-card/95 shadow-2xl flex flex-col overflow-hidden rounded-none"
        style={{ left, top, width: popupWidth, height: 'auto', maxHeight: popupHeight }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="h-10 shrink-0 border-b border-border/70 px-2 flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 mr-2"
            onClick={closeTransferCenter}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
          <ArrowUpDown className="h-4 w-4 mr-2" />
          <h1 className="text-xs font-light tracking-wider uppercase">Transfers</h1>
        </header>
        <div className="shrink-0 px-2 pt-1.5 pb-1.5">
          <TransferCenterPanel />
        </div>
        <div className="h-10 shrink-0 border-t border-border/70 px-2 flex items-center justify-center">
          <button
            type="button"
            className="text-[12px] underline underline-offset-2 hover:text-foreground/90"
            onClick={() => {
              const existing = WebviewWindow.getByLabel('transfers-window')
              if (existing) {
                existing.setFocus()
              } else {
                new WebviewWindow('transfers-window', {
                  title: 'Transfers',
                  width: 980,
                  height: 700,
                  minWidth: 760,
                  minHeight: 520,
                  resizable: true,
                  decorations: false,
                  url: '/transfers',
                })
              }
              closeTransferCenter()
            }}
          >
            Show all downloads/uploads
          </button>
        </div>
      </div>
    </div>
  )

  if (typeof document === 'undefined') return null
  return createPortal(popupEl, document.body)
}
