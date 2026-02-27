import { useMemo } from 'react'
import { FolderOpen, Trash2, X, MoreHorizontal } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { useMediaPreview } from '../contexts/MediaPreviewContext'
import { Button } from './ui/button'
import { FilenameEllipsis } from './FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { openPathInFileExplorer } from '../lib/tauri'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
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
    removeTransferHistoryEntry,
    cancelTransferRequest,
    unshareAttachmentById,
  } = useEphemeralMessages()
  const { setMediaPreview } = useMediaPreview()

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
  const uploadDisplayCount = Math.min(sharedAttachments.length, sharedAttachments.length > MAX_LIST_ENTRIES ? MAX_LIST_ENTRIES - 1 : MAX_LIST_ENTRIES)
  const uploadMoreCount = sharedAttachments.length > MAX_LIST_ENTRIES ? sharedAttachments.length - (MAX_LIST_ENTRIES - 1) : 0

  return (
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
          <div className={`space-y-1.5 overflow-y-auto pr-1 ${sharedAttachments.length > 6 ? 'max-h-[342px]' : ''}`}>
            {sharedAttachments.length === 0 && (
              <p className="text-[11px] text-muted-foreground px-1">No shared files.</p>
            )}
            {sharedAttachments.slice(0, uploadDisplayCount).map((item) => {
              const live = latestUploadByAttachment.get(item.attachment_id)
              const status = live?.status ?? (item.can_share_now ? 'available' : 'unavailable')
              const p = live?.status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round((live?.progress ?? 0) * 100)))
              const showBar = !!live && (live.status === 'transferring' || live.status === 'completed')
              return (
                <div key={item.attachment_id} className="group border border-border/50 bg-card/60 px-2 py-1.5 flex gap-2 items-start">
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
                  <div className="shrink-0 w-14 flex justify-end">
                    <span className="text-[10px] text-muted-foreground group-hover:hidden">{showBar ? `${p}%` : status}</span>
                    <div className="hidden group-hover:flex items-center gap-1">
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
                        className="h-6 w-6 text-red-300 hover:text-red-200"
                        onClick={() => unshareAttachmentById(item.attachment_id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
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
  )
}
