import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowUpDown, FolderOpen, Trash2 } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { MediaPreviewModal } from './MediaPreviewModal'
import { useWindowSize } from '../lib/useWindowSize'
import { Button } from './ui/button'
import { useTransferCenterModal } from '../contexts/TransferCenterModalContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { openPathInFileExplorer } from '../lib/tauri'
import { FilenameEllipsis } from './FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useIdentity } from '../contexts/IdentityContext'

function directoryForPath(path: string): string {
  const normalized = path.replace(/\//g, '\\')
  const idx = normalized.lastIndexOf('\\')
  return idx > 0 ? normalized.slice(0, idx) : normalized
}

function formatEta(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.max(0, Math.round(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function TransferCenterModal() {
  const { isOpen, anchorRect, closeTransferCenter } = useTransferCenterModal()
  const { width, height } = useWindowSize()
  const [mediaPreview, setMediaPreview] = useState<{
    type: 'image' | 'video'
    url: string | null
    attachmentId?: string
    fileName?: string
  } | null>(null)
  const isSmall = width < 700
  const { identity } = useIdentity()
  const remoteProfiles = useRemoteProfiles()
  const {
    transferHistory,
    attachmentTransfers,
    sharedAttachments,
    refreshSharedAttachments,
    refreshTransferHistoryAccessibility,
    removeTransferHistoryEntry,
    cancelTransferRequest,
    unshareAttachmentById,
  } = useEphemeralMessages()

  useEffect(() => {
    if (!isOpen) return
    refreshSharedAttachments().catch(() => {})
    // Defer path existence checks so opening the popup stays instant.
    const t = window.setTimeout(() => {
      refreshTransferHistoryAccessibility().catch(() => {})
    }, 180)
    return () => window.clearTimeout(t)
  }, [isOpen, refreshSharedAttachments, refreshTransferHistoryAccessibility])

  // Clear media preview when transfer center closes (e.g. clicking top bar/overlay)
  // Also revoke blob URLs to avoid leaks
  useEffect(() => {
    if (!isOpen) {
      setMediaPreview((prev) => {
        if (prev?.url?.startsWith('blob:')) URL.revokeObjectURL(prev.url)
        return null
      })
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mediaPreview) setMediaPreview(null)
        else closeTransferCenter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, closeTransferCenter, mediaPreview])

  const downloadRows = useMemo(
    () =>
      transferHistory
        .filter((h) => h.direction === 'download')
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [transferHistory]
  )

  const latestUploadByAttachment = useMemo(() => {
    const map = new Map<
      string,
      { status: string; progress: number; debugKbps?: number; bufferedBytes?: number; etaSeconds?: number }
    >()
    for (const t of attachmentTransfers) {
      if (t.direction !== 'upload') continue
      map.set(t.attachment_id, {
        status: t.status,
        progress: t.progress,
        debugKbps: t.debug_kbps,
        bufferedBytes: t.debug_buffered_bytes,
        etaSeconds: t.debug_eta_seconds,
      })
    }
    return map
  }, [attachmentTransfers])

  const liveTransferByRequest = useMemo(() => {
    const map = new Map<string, typeof attachmentTransfers[number]>()
    for (const t of attachmentTransfers) map.set(t.request_id, t)
    return map
  }, [attachmentTransfers])

  const latestUploadHistoryByAttachment = useMemo(() => {
    const map = new Map<string, { peer: string; at: string }>()
    for (const h of transferHistory) {
      if (h.direction !== 'upload') continue
      if (!map.has(h.attachment_id)) {
        map.set(h.attachment_id, { peer: h.to_user_id || h.from_user_id, at: h.updated_at })
      }
    }
    return map
  }, [transferHistory])

  if (!isOpen || !anchorRect) return null

  const popupWidth = Math.min(isSmall ? 420 : 720, width - 24)
  const popupHeight = Math.min(isSmall ? 360 : 460, height - 24)
  const gutter = 10
  // TitleBar (h-8) + header with Home and user card (h-16)
  const topBarHeight = 96

  // Anchor to the button; prefer below-right alignment.
  let left = Math.round(anchorRect.right - popupWidth)
  left = Math.max(gutter, Math.min(left, width - popupWidth - gutter))
  let top = Math.round(anchorRect.bottom + 8)
  if (top + popupHeight > height - gutter) {
    top = Math.round(anchorRect.top - popupHeight - 8)
  }
  top = Math.max(topBarHeight, Math.min(top, height - popupHeight - gutter))

  const popupEl = (
    <div className="fixed inset-0 z-[70]">
      {mediaPreview && (
        <MediaPreviewModal
          type={mediaPreview.type}
          url={mediaPreview.url}
          attachmentId={mediaPreview.attachmentId}
          fileName={mediaPreview.fileName}
          onClose={() => {
            if (mediaPreview.url?.startsWith('blob:')) {
              URL.revokeObjectURL(mediaPreview.url)
            }
            setMediaPreview(null)
          }}
        />
      )}
      {/* Transparent click-catcher (no dim) - default cursor, not pointer */}
      <div className="absolute inset-0 cursor-default" onMouseDown={closeTransferCenter} />
      <div
        className="absolute border-2 border-border bg-card/95 shadow-2xl flex flex-col overflow-hidden rounded-none"
        style={{ left, top, width: popupWidth, height: popupHeight }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="h-10 shrink-0 border-b border-border/70 px-2 flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 mr-2"
            title="Close transfer center"
            onClick={closeTransferCenter}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
          <ArrowUpDown className="h-4 w-4 mr-2" />
          <h1 className="text-xs font-light tracking-wider uppercase">Transfers</h1>
        </header>

        <div className="flex-1 min-h-0 p-2">
          <div className="flex h-full min-h-0">
            <section className="flex-1 min-w-0 min-h-0 flex flex-col pr-2">
              <div className="px-1 pb-1">
                <h2 className="text-[11px] tracking-wider uppercase text-muted-foreground">Downloads</h2>
              </div>
              <div className="space-y-2 overflow-y-auto pr-1">
                {downloadRows.length === 0 && (
                  <p className="text-[11px] text-muted-foreground px-1">No downloads yet.</p>
                )}
                {downloadRows.map((row) => {
                  const live = liveTransferByRequest.get(row.request_id)
                  const status = live?.status ?? row.status
                  const progress = live?.progress ?? row.progress
                  const inaccessible = row.is_inaccessible === true
                  const canCancel =
                    status === 'queued' || status === 'requesting' || status === 'connecting' || status === 'transferring'
                  const canRemoveRejected = status === 'rejected'
                  return (
                  <div
                    key={row.request_id}
                    className={`group border border-border/50 px-2 py-1.5 space-y-1 flex gap-2 ${
                      inaccessible ? 'bg-card/30 opacity-65' : 'bg-card/60'
                    }`}
                  >
                    <FileIcon
                      fileName={row.file_name}
                      savedPath={inaccessible ? undefined : row.saved_path}
                      onMediaClick={(url, type, attachmentId, fileName) => setMediaPreview({ type, url, attachmentId, fileName })}
                    />
                    <div className="min-w-0 flex-1">
                    <FilenameEllipsis name={row.file_name} className="block text-[12px] truncate" />
                    <div className="text-[10px] text-muted-foreground flex items-center justify-between gap-2">
                      <span className="truncate">
                        {row.from_user_id === identity?.user_id
                          ? 'You'
                          : (remoteProfiles.getProfile(row.from_user_id)?.display_name?.trim()
                              ? remoteProfiles.getProfile(row.from_user_id)!.display_name
                              : `User ${row.from_user_id.slice(0, 8)}`)} • {formatBytes(row.size_bytes)}
                      </span>
                      <span className="shrink-0">{inaccessible ? 'Not accessible' : (status === 'transferring' ? `${Math.round(progress * 100)}%` : status)}</span>
                    </div>
                    {!!live && (status === 'queued' || status === 'requesting' || status === 'connecting' || status === 'transferring') && (
                      <div className="text-[9px] text-muted-foreground truncate">
                        {`debug: ${Math.round(live.debug_kbps ?? 0)} KB/s`}
                        {` • ETA ${formatEta(live.debug_eta_seconds)}`}
                        {typeof live.debug_buffered_bytes === 'number' ? ` • buffered ${Math.round(live.debug_buffered_bytes / 1024)} KB` : ''}
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground truncate">
                      {new Date(row.updated_at).toLocaleString()}
                    </div>
                    {!inaccessible && row.saved_path && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => openPathInFileExplorer(directoryForPath(row.saved_path!))}
                        title={row.saved_path}
                      >
                        <FolderOpen className="h-3.5 w-3.5 mr-1" />
                      </Button>
                    )}
                    {canCancel && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-amber-300 hover:text-amber-200 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => cancelTransferRequest(row.request_id)}
                        title="Cancel and remove transfer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {inaccessible && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-red-300 hover:text-red-200 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => removeTransferHistoryEntry(row.request_id)}
                        title="Remove inaccessible entry"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {canRemoveRejected && !inaccessible && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-red-300 hover:text-red-200 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => removeTransferHistoryEntry(row.request_id)}
                        title="Remove rejected entry"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    </div>
                  </div>
                )})}
              </div>
            </section>

            <div className="w-px bg-foreground/15 mx-2" />

            <section className="flex-1 min-w-0 min-h-0 flex flex-col pl-2">
              <div className="px-1 pb-1">
                <h2 className="text-[11px] tracking-wider uppercase text-muted-foreground">Uploads</h2>
              </div>
              <div className="space-y-2 overflow-y-auto pr-1">
                {sharedAttachments.length === 0 && (
                  <p className="text-[11px] text-muted-foreground px-1">No shared files.</p>
                )}
                {sharedAttachments.map((item) => {
                  const live = latestUploadByAttachment.get(item.attachment_id)
                  const latest = latestUploadHistoryByAttachment.get(item.attachment_id)
                  const peerName = latest?.peer
                    ? (latest.peer === identity?.user_id
                        ? 'You'
                        : (remoteProfiles.getProfile(latest.peer)?.display_name?.trim()
                            ? remoteProfiles.getProfile(latest.peer)!.display_name
                            : `User ${latest.peer.slice(0, 8)}`))
                    : null
                  return (
                    <div key={item.attachment_id} className="border border-border/50 bg-card/60 px-2 py-1.5 space-y-1 flex gap-2">
                      <FileIcon
                        fileName={item.file_name}
                        attachmentId={item.can_share_now && !item.file_path ? item.attachment_id : null}
                        savedPath={item.file_path ?? undefined}
                        thumbnailPath={item.thumbnail_path ?? undefined}
                        onMediaClick={(url, type, attachmentId, fileName) => setMediaPreview({ type, url, attachmentId, fileName })}
                      />
                      <div className="min-w-0 flex-1">
                      <FilenameEllipsis name={item.file_name} className="block text-[12px] truncate" />
                      <div className="text-[10px] text-muted-foreground flex items-center justify-between gap-2">
                        <span className="truncate">
                          {formatBytes(item.size_bytes)} • {item.storage_mode === 'program_copy' ? 'Cordia copy' : 'path'}
                        </span>
                        <span className="shrink-0">
                          {live
                            ? (live.status === 'transferring' ? `${Math.round(live.progress * 100)}%` : live.status)
                            : (item.can_share_now ? 'ready' : 'missing')}
                        </span>
                      </div>
                      {live && (live.status === 'requesting' || live.status === 'connecting' || live.status === 'transferring') && (
                        <div className="text-[9px] text-muted-foreground truncate">
                          {`debug: ${Math.round(live.debugKbps ?? 0)} KB/s`}
                          {` • ETA ${formatEta(live.etaSeconds)}`}
                          {typeof live.bufferedBytes === 'number' ? ` • buffered ${Math.round(live.bufferedBytes / 1024)} KB` : ''}
                        </div>
                      )}
                      {latest && (
                        <div className="text-[10px] text-muted-foreground truncate">
                          Last {peerName ?? latest.peer.slice(0, 8)} • {new Date(latest.at).toLocaleString()}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground truncate">
                        {new Date(item.created_at).toLocaleString()}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-red-300 hover:text-red-200"
                        onClick={() => unshareAttachmentById(item.attachment_id)}
                        title="Remove from sharing"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )

  if (typeof document === 'undefined') return null
  return createPortal(popupEl, document.body)
}

