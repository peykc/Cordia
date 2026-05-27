import type { EphemeralAttachmentMeta } from '../../domain/attachments/types'
import type { AttachmentTransferState, TransferHistoryEntry } from '../../domain/transfers/types'

export type AttachmentAvailability = {
  local: 'local' | 'cached' | 'missing' | 'unknown'
  remote: 'available' | 'unavailable' | 'unknown'
  transfer: 'idle' | 'queued' | 'active' | 'failed'
  share: 'shared_here' | 'shared_elsewhere' | 'not_shared'
}

export type SharedAttachmentPresentationItem = {
  attachment_id: string
  can_share_now?: boolean
  file_path?: string | null
  thumbnail_path?: string | null
  sha256?: string
}

export type UnsharedAttachmentRecord = {
  file_path?: string | null
  thumbnail_path?: string | null
}

export type AttachmentPresentation = {
  attachmentRefId: string
  contentId?: string
  fileName: string
  availability: AttachmentAvailability
  sharedItem?: SharedAttachmentPresentationItem
  hasPath?: string
  thumbPath?: string
  notDownloaded: boolean
  liveDownload?: AttachmentTransferState
  downloadProgress: number
  showDownloadProgress: boolean
}

export function buildAttachmentPresentation({
  att,
  isOwn,
  attachmentTransferRows,
  transferHistory,
  sharedAttachments,
  sharedByAttachmentId,
  completedDownloadPathByAttachmentId,
  unsharedAttachmentRecords,
  hasAccessibleCompletedDownload,
  getCachedPathForSha,
}: {
  att: EphemeralAttachmentMeta
  isOwn: boolean
  attachmentTransferRows: AttachmentTransferState[]
  transferHistory: TransferHistoryEntry[]
  sharedAttachments: SharedAttachmentPresentationItem[]
  sharedByAttachmentId?: Record<string, SharedAttachmentPresentationItem | undefined>
  completedDownloadPathByAttachmentId?: Record<string, string | undefined>
  unsharedAttachmentRecords: Record<string, UnsharedAttachmentRecord | null | undefined>
  hasAccessibleCompletedDownload: (id: string | null | undefined) => boolean
  getCachedPathForSha: (sha: string | undefined) => string | null
}): AttachmentPresentation {
  const sharedItem = sharedByAttachmentId
    ? sharedByAttachmentId[att.attachment_id]
    : sharedAttachments.find((s) => s.attachment_id === att.attachment_id)
  const unsharedRec = unsharedAttachmentRecords[att.attachment_id]
  const completedDownloadPath = completedDownloadPathByAttachmentId
    ? completedDownloadPathByAttachmentId[att.attachment_id]
    : transferHistory.find(
        (h) =>
          h.direction === 'download' &&
          h.attachment_id === att.attachment_id &&
          h.status === 'completed' &&
          h.saved_path
      )?.saved_path
  const cachedPath = getCachedPathForSha(att.sha256) ?? undefined
  const liveDownload = attachmentTransferRows.find(
    (t) =>
      t.direction === 'download' &&
      t.attachment_id === att.attachment_id &&
      (t.status === 'requesting' || t.status === 'connecting' || t.status === 'transferring')
  )
  const hasCompletedDownload = hasAccessibleCompletedDownload(att.attachment_id)
  const hasPath = isOwn
    ? (sharedItem?.file_path ?? unsharedRec?.file_path ?? cachedPath ?? att.preview_path ?? undefined)
    : (completedDownloadPath ?? cachedPath ?? undefined)
  const thumbPath = isOwn
    ? (sharedItem?.thumbnail_path ?? unsharedRec?.thumbnail_path ?? undefined)
    : undefined
  const notDownloaded = !isOwn && !hasCompletedDownload && !hasPath
  const downloadProgress = liveDownload
    ? Math.max(0, Math.min(100, Math.round((liveDownload.progress ?? 0) * 100)))
    : 0
  const showDownloadProgress =
    !!liveDownload && (liveDownload.status === 'transferring' || liveDownload.status === 'completed')

  const transferStatus: AttachmentAvailability['transfer'] =
    liveDownload?.status === 'failed' || liveDownload?.status === 'rejected'
      ? 'failed'
      : liveDownload?.status === 'queued'
        ? 'queued'
        : liveDownload
          ? 'active'
          : 'idle'
  const localAvailability: AttachmentAvailability['local'] = hasPath
    ? cachedPath && hasPath === cachedPath
      ? 'cached'
      : 'local'
    : notDownloaded
      ? 'missing'
      : 'unknown'
  const remoteAvailability: AttachmentAvailability['remote'] = isOwn
    ? sharedItem?.can_share_now
      ? 'available'
      : 'unknown'
    : notDownloaded
      ? 'unknown'
      : 'available'
  const shareStatus: AttachmentAvailability['share'] = sharedItem ? 'shared_here' : 'not_shared'

  return {
    attachmentRefId: att.attachment_id,
    contentId: att.sha256,
    fileName: att.file_name,
    availability: {
      local: localAvailability,
      remote: remoteAvailability,
      transfer: transferStatus,
      share: shareStatus,
    },
    sharedItem,
    hasPath,
    thumbPath,
    notDownloaded,
    liveDownload,
    downloadProgress,
    showDownloadProgress,
  }
}
