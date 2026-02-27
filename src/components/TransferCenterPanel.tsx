import { useMemo, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, Trash2, X, MoreHorizontal, ChevronDown } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { useMediaPreview } from '../contexts/MediaPreviewContext'
import { Button } from './ui/button'
import { FilenameEllipsis } from './FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { openPathInFileExplorer } from '../lib/tauri'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useIdentity } from '../contexts/IdentityContext'
import { useServers } from '../contexts/ServersContext'

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

function formatRate(kbps?: number): string {
  const safe = Math.max(0, kbps ?? 0)
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} MB/s`
  return `${Math.round(safe)} KB/s`
}

export function TransferCenterPanel() {
  const { identity } = useIdentity()
  const remoteProfiles = useRemoteProfiles()
  const {
    transferHistory,
    attachmentTransfers,
    sharedAttachments,
    getServersForSha,
    unshareFromServer,
    removeTransferHistoryEntry,
    cancelTransferRequest,
    unshareAttachmentById,
  } = useEphemeralMessages()
  const { setMediaPreview } = useMediaPreview()
  const { servers } = useServers()
  const [openUploadMenuSha, setOpenUploadMenuSha] = useState<string | null>(null)
  const [uploadMenuAnchorRect, setUploadMenuAnchorRect] = useState<DOMRect | null>(null)
  const uploadMenuRef = useRef<HTMLDivElement>(null)
  const uploadMenuButtonRef = useRef<HTMLElement | null>(null)

  const serverNameBySigningPubkey = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of servers) map.set(s.signing_pubkey, s.name)
    return map
  }, [servers])

  const closeUploadMenu = useMemo(
    () => () => {
      setOpenUploadMenuSha(null)
      setUploadMenuAnchorRect(null)
      uploadMenuButtonRef.current = null
    },
    []
  )

  useEffect(() => {
    if (openUploadMenuSha === null) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (uploadMenuRef.current?.contains(target)) return
      if (uploadMenuButtonRef.current?.contains(target)) return
      closeUploadMenu()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [openUploadMenuSha, closeUploadMenu])

  const downloadRows = useMemo(
    () =>
      transferHistory
        .filter(
          (h) =>
            h.direction === 'download' &&
            h.status !== 'rejected' &&
            h.status !== 'failed'
        )
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [transferHistory]
  )

  const latestUploadByAttachment = useMemo(() => {
    const map = new Map<
      string,
      { status: string; progress: number; debugKbps?: number; etaSeconds?: number }
    >()
    for (const t of attachmentTransfers) {
      if (t.direction !== 'upload') continue
      map.set(t.attachment_id, {
        status: t.status,
        progress: t.progress,
        debugKbps: t.debug_kbps,
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

  const MAX_LIST_ENTRIES = 6
  const downloadDisplayCount = Math.min(downloadRows.length, downloadRows.length > MAX_LIST_ENTRIES ? MAX_LIST_ENTRIES - 1 : MAX_LIST_ENTRIES)
  const downloadMoreCount = downloadRows.length > MAX_LIST_ENTRIES ? downloadRows.length - (MAX_LIST_ENTRIES - 1) : 0

  /** One row per content (sha256); representative item is first in group for file info. */
  const uploadsGroupedBySha = useMemo(() => {
    const bySha = new Map<string, typeof sharedAttachments>()
    for (const item of sharedAttachments) {
      const sha = item.sha256 || item.attachment_id
      const list = bySha.get(sha) ?? []
      list.push(item)
      bySha.set(sha, list)
    }
    return Array.from(bySha.entries()).map(([sha, items]) => ({ sha, items, representative: items[0]! }))
  }, [sharedAttachments])

  const uploadDisplayCount = Math.min(uploadsGroupedBySha.length, uploadsGroupedBySha.length > MAX_LIST_ENTRIES ? MAX_LIST_ENTRIES - 1 : MAX_LIST_ENTRIES)
  const uploadMoreCount = uploadsGroupedBySha.length > MAX_LIST_ENTRIES ? uploadsGroupedBySha.length - (MAX_LIST_ENTRIES - 1) : 0

  return (
    <>
    <div className="flex min-h-0">
        <section className="flex-1 min-w-0 flex flex-col pr-2 shrink-0">
          <div className="px-1 pb-1">
            <h2 className="text-[11px] tracking-wider uppercase text-muted-foreground">Downloads</h2>
          </div>
          <div className={`space-y-1.5 overflow-y-auto pr-1 ${downloadRows.length > 6 ? 'max-h-[342px]' : ''}`}>
            {downloadRows.length === 0 && (
              <p className="text-[11px] text-muted-foreground px-1">No downloads yet.</p>
            )}
            {downloadRows.slice(0, downloadDisplayCount).map((row) => {
              const live = liveTransferByRequest.get(row.request_id)
              const status = live?.status ?? row.status
              const progress = live?.progress ?? row.progress
              const inaccessible = row.is_inaccessible === true
              const canCancel =
                status === 'queued' || status === 'requesting' || status === 'connecting' || status === 'transferring'
              const canRemove = inaccessible || status === 'rejected'
              const pct = status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round(progress * 100)))
              const showBar = !inaccessible && (status === 'transferring' || status === 'completed')
              const speed = formatRate(live?.debug_kbps)
              const eta = formatEta(live?.debug_eta_seconds)
              return (
                <div
                  key={row.request_id}
                  className={`group border border-border/50 px-2 py-1.5 flex gap-2 items-start ${
                    inaccessible ? 'bg-card/30 opacity-65' : 'bg-card/60'
                  }`}
                >
                  <FileIcon
                    fileName={row.file_name}
                    savedPath={inaccessible ? undefined : row.saved_path}
                    onMediaClick={(url, type, attachmentId, fileName) => setMediaPreview({ type, url, attachmentId, fileName })}
                  />
                  <div className="min-w-0 flex-1">
                    <FilenameEllipsis name={row.file_name} className="block text-[11px] truncate leading-4" />
                    <div className="text-[10px] text-muted-foreground truncate">
                      {row.from_user_id === identity?.user_id
                        ? 'You'
                        : (remoteProfiles.getProfile(row.from_user_id)?.display_name?.trim()
                            ? remoteProfiles.getProfile(row.from_user_id)!.display_name
                            : `User ${row.from_user_id.slice(0, 8)}`)} • {formatBytes(row.size_bytes)}
                    </div>
                    {showBar && (
                      <div className="mt-0.5 h-1 bg-foreground/15 overflow-hidden rounded-none">
                        <div className={`h-full ${status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85'}`} style={{ width: `${Math.max(2, pct)}%` }} />
                      </div>
                    )}
                    {!inaccessible && (status === 'queued' || status === 'requesting' || status === 'connecting' || status === 'transferring') && (
                      <div className="text-[9px] text-muted-foreground truncate mt-0.5">
                        {`${speed} • ETA ${eta}`}
                      </div>
                    )}
                    {inaccessible && <div className="text-[9px] text-muted-foreground mt-0.5">Not accessible</div>}
                  </div>
                  <div className="shrink-0 w-14 flex justify-end">
                    <span className="text-[10px] text-muted-foreground group-hover:hidden">{pct}%</span>
                    <div className="hidden group-hover:flex items-center gap-1">
                      {!inaccessible && row.saved_path && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => openPathInFileExplorer(directoryForPath(row.saved_path!))}
                          title={row.saved_path}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canCancel && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-amber-300 hover:text-amber-200"
                          onClick={() => cancelTransferRequest(row.request_id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canRemove && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-red-300 hover:text-red-200"
                          onClick={() => removeTransferHistoryEntry(row.request_id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {downloadMoreCount > 0 && (
              <div className="border border-border/50 bg-card/40 px-2 py-1.5 flex gap-2 items-center text-muted-foreground">
                <div className="w-10 h-10 shrink-0 grid place-items-center rounded border border-border/50 bg-muted/30">
                  <MoreHorizontal className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1 text-[11px]">
                  {downloadMoreCount} more download{downloadMoreCount !== 1 ? 's' : ''}
                </div>
              </div>
            )}
          </div>
        </section>
        <div className="w-px bg-foreground/15 mx-2" />
        <section className="flex-1 min-w-0 flex flex-col pl-2 shrink-0">
          <div className="px-1 pb-1">
            <h2 className="text-[11px] tracking-wider uppercase text-muted-foreground">Uploads</h2>
          </div>
          <div className={`space-y-1.5 overflow-y-auto pr-1 ${uploadsGroupedBySha.length > 6 ? 'max-h-[342px]' : ''}`}>
            {uploadsGroupedBySha.length === 0 && (
              <p className="text-[11px] text-muted-foreground px-1">No shared files.</p>
            )}
            {uploadsGroupedBySha.slice(0, uploadDisplayCount).map(({ sha, representative: item }) => {
              const live = latestUploadByAttachment.get(item.attachment_id)
              const serverCount = getServersForSha(item.sha256).length
              const status = live?.status ?? (item.can_share_now ? 'available' : 'unavailable')
              const p = live?.status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round((live?.progress ?? 0) * 100)))
              const showBar = !!live && (live.status === 'transferring' || live.status === 'completed')
              return (
                <div key={sha} className="group border border-border/50 bg-card/60 px-2 py-1.5 flex gap-2 items-start">
                  <FileIcon
                    fileName={item.file_name}
                    attachmentId={item.can_share_now && !item.file_path ? item.attachment_id : null}
                    savedPath={item.file_path ?? undefined}
                    thumbnailPath={item.thumbnail_path ?? undefined}
                    onMediaClick={(url, type, attachmentId, fileName) => setMediaPreview({ type, url, attachmentId, fileName })}
                  />
                  <div className="min-w-0 flex-1">
                    <FilenameEllipsis name={item.file_name} className="block text-[11px] truncate leading-4" />
                    <div className="text-[10px] text-muted-foreground truncate">
                      {formatBytes(item.size_bytes)} • {item.storage_mode === 'program_copy' ? 'Cordia copy' : 'path'}
                      {serverCount > 0 && ` • Shared in ${serverCount} server${serverCount !== 1 ? 's' : ''}`}
                    </div>
                    {showBar && (
                      <div className="mt-0.5 h-1 bg-foreground/15 overflow-hidden rounded-none">
                        <div className={`h-full ${live?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85'}`} style={{ width: `${Math.max(2, p)}%` }} />
                      </div>
                    )}
                    {!!live && (live.status === 'requesting' || live.status === 'connecting' || live.status === 'transferring') && (
                      <div className="text-[9px] text-muted-foreground truncate mt-0.5">
                        {`${formatRate(live.debugKbps)} • ETA ${formatEta(live.etaSeconds)}`}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 w-14 flex justify-end items-center gap-0.5">
                    <span className="text-[10px] text-muted-foreground group-hover:hidden">{showBar ? `${p}%` : status}</span>
                    <div className="hidden group-hover:flex items-center gap-0.5">
                      {!!item.file_path && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => openPathInFileExplorer(directoryForPath(item.file_path!))}
                          title={item.file_path!}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        title="Remove from server(s)"
                        onClick={(e) => {
                          const el = e.currentTarget
                          const rect = el.getBoundingClientRect()
                          if (openUploadMenuSha === sha) {
                            closeUploadMenu()
                            return
                          }
                          setUploadMenuAnchorRect(rect)
                          setOpenUploadMenuSha(sha)
                          uploadMenuButtonRef.current = el
                        }}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
            {uploadMoreCount > 0 && (
              <div className="border border-border/50 bg-card/40 px-2 py-1.5 flex gap-2 items-center text-muted-foreground">
                <div className="w-10 h-10 shrink-0 grid place-items-center rounded border border-border/50 bg-muted/30">
                  <MoreHorizontal className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1 text-[11px]">
                  {uploadMoreCount} more upload{uploadMoreCount !== 1 ? 's' : ''}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
      {openUploadMenuSha && uploadMenuAnchorRect && (() => {
        const group = uploadsGroupedBySha.find((g) => g.sha === openUploadMenuSha)
        const item = group?.representative
        if (!item) return null
        const rect = uploadMenuAnchorRect
        return createPortal(
          <div
            ref={uploadMenuRef}
            className="min-w-[160px] py-1 rounded-md border border-border bg-popover text-popover-foreground shadow-md z-[9999]"
            style={{
              position: 'fixed',
              right: window.innerWidth - rect.right,
              top: rect.bottom + 2,
            }}
          >
            {getServersForSha(item.sha256).map((serverKey) => (
              <button
                key={serverKey}
                type="button"
                className="w-full px-2 py-1.5 text-left text-[11px] hover:bg-accent hover:text-accent-foreground truncate"
                onClick={() => {
                  unshareFromServer(serverKey, item.sha256)
                  closeUploadMenu()
                }}
              >
                Remove from server ({serverNameBySigningPubkey.get(serverKey) ?? `${serverKey.slice(0, 8)}…`})
              </button>
            ))}
            <button
              type="button"
              className="w-full px-2 py-1.5 text-left text-[11px] text-red-600 hover:bg-red-500/10 flex items-center gap-1.5"
              onClick={() => {
                unshareAttachmentById(item.attachment_id)
                closeUploadMenu()
              }}
            >
              <Trash2 className="h-3 w-3 shrink-0" />
              Remove from all (unshare)
            </button>
          </div>,
          document.body
        )
      })()}
    </>
  )
}
