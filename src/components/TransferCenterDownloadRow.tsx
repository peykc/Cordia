import { memo, useCallback } from 'react'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { FolderOpen, Trash2 } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { Button } from './ui/button'
import { FilenameEllipsis } from './FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { openPathInFileExplorer } from '../lib/tauri'
import type { AttachmentTransferState, TransferHistoryEntry } from '../contexts/EphemeralMessagesContext'
import type { MediaPreviewState } from '../contexts/MediaPreviewContext'
import { cn } from '../lib/utils'

function directoryForPath(path: string): string {
  const normalized = path.replace(/\//g, '\\')
  const idx = normalized.lastIndexOf('\\')
  return idx > 0 ? normalized.slice(0, idx) : normalized
}

function formatEta(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
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

function formatBuffer(bytes?: number): string {
  if (bytes == null || bytes <= 0) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB buf`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB buf`
  return `${bytes} B buf`
}

type TransferStatus = AttachmentTransferState['status']

export type TransferCenterDownloadRowProps = {
  row: TransferHistoryEntry
  compact: boolean
  /** Resolved live/history status */
  status: TransferStatus
  /** 0..1 */
  progress: number
  debugKbps?: number
  debugEtaSeconds?: number
  debugPendingBytes?: number
  fromLabel: string
  setMediaPreview: (value: MediaPreviewState) => void
  cancelTransferRequest: (requestId: string) => void
  removeTransferHistoryEntry: (requestId: string) => void
}

function TransferCenterDownloadRowInner({
  row,
  compact,
  status,
  progress,
  debugKbps,
  debugEtaSeconds,
  debugPendingBytes,
  fromLabel,
  setMediaPreview,
  cancelTransferRequest,
  removeTransferHistoryEntry,
}: TransferCenterDownloadRowProps) {
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const { findMessageById } = useEphemeralMessages()
  const inaccessible = row.is_inaccessible === true
  const canCancel =
    status === 'queued' || status === 'requesting' || status === 'connecting' || status === 'transferring'
  const canRemove = inaccessible || status === 'rejected' || status === 'failed'
  const pct = status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round(progress * 100)))
  const showBar = !inaccessible && (status === 'transferring' || status === 'completed')

  const onPreview = useCallback(
    (url: string | null, type: 'image' | 'video', attachmentId?: string, fileName?: string) => {
      const uid = row.from_user_id
      const isYou = uid === identity?.user_id
      const rp = remoteProfiles.getProfile(uid)
      const sentFromMsg = findMessageById(row.message_id)?.sent_at
      setMediaPreview({
        type,
        url,
        attachmentId,
        fileName,
        source: 'transfers',
        originUserId: uid,
        originSentAtIso: sentFromMsg ?? row.created_at,
        originDisplayName: fromLabel,
        originAvatarDataUrl: isYou ? profile.avatar_data_url ?? null : rp?.avatar_data_url ?? null,
        localPath: row.saved_path ?? null,
        sizeBytes: row.size_bytes,
        sha256: undefined,
      })
    },
    [
      setMediaPreview,
      row.from_user_id,
      row.message_id,
      row.created_at,
      row.saved_path,
      row.size_bytes,
      fromLabel,
      identity?.user_id,
      profile.avatar_data_url,
      remoteProfiles,
      findMessageById,
    ]
  )

  return (
    <div
      className={cn(
        'group flex items-start gap-2 border-b border-border px-2 py-1.5 transition-colors duration-150 hover:bg-muted/50',
        inaccessible ? 'opacity-60' : '',
        compact ? 'py-1' : ''
      )}
    >
      <FileIcon
        fileName={row.file_name}
        savedPath={inaccessible ? undefined : row.saved_path}
        boxSize={compact ? 28 : 32}
        squareThumb
        onMediaClick={onPreview}
      />
      <div className="min-w-0 flex-1">
        <FilenameEllipsis
          name={row.file_name}
          className="block h-4 text-[11px] font-medium leading-4 text-foreground"
        />
        <div className="text-[10px] text-muted-foreground truncate">
          {fromLabel} · {formatBytes(row.size_bytes)}
        </div>
        {showBar && (
          <div className="mt-0.5 h-0.5 max-w-[200px] rounded-full bg-foreground/10 overflow-hidden">
            <div
              className={cn('h-full rounded-full', status === 'completed' ? 'bg-emerald-500/80' : 'bg-violet-500/70')}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
        )}
        {!inaccessible &&
          (status === 'queued' || status === 'requesting' || status === 'connecting' || status === 'transferring') && (
            <div className="text-[9px] text-muted-foreground mt-0.5 space-x-1">
              <span>{formatRate(debugKbps)}</span>
              <span>·</span>
              <span>ETA {formatEta(debugEtaSeconds)}</span>
              {debugPendingBytes != null && debugPendingBytes > 64 * 1024 && (
                <span title="Pending write buffer">· {formatBuffer(debugPendingBytes)}</span>
              )}
            </div>
          )}
        {inaccessible && <span className="text-[9px] text-amber-200/90">Unavailable</span>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
        <div
          className={cn(
            'flex min-w-0 items-center gap-0.5 overflow-hidden',
            'max-w-0 opacity-0 pointer-events-none',
            'group-hover:pointer-events-auto group-hover:opacity-100 group-hover:max-w-[5.5rem]'
          )}
        >
          {!inaccessible && row.saved_path && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => openPathInFileExplorer(directoryForPath(row.saved_path!))}
              title="Open folder"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          )}
          {canCancel && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-amber-300 hover:text-amber-200"
              onClick={() => cancelTransferRequest(row.request_id)}
              title="Cancel"
            >
              <span className="text-xs font-bold">×</span>
            </Button>
          )}
          {canRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-red-300 hover:text-red-200"
              onClick={() => removeTransferHistoryEntry(row.request_id)}
              title="Remove from list"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Memoized row: live transfer fields are passed as primitives so global progress ticks
 * don’t force every visible history row to re-render.
 */
export const TransferCenterDownloadRow = memo(TransferCenterDownloadRowInner)
