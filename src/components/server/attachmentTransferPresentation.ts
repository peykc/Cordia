import type { EphemeralAttachmentMeta } from '../../domain/attachments/types'
import type { AttachmentTransferState, TransferHistoryEntry } from '../../domain/transfers/types'
import {
  buildAttachmentPresentation,
  type SharedAttachmentPresentationItem,
  type UnsharedAttachmentRecord,
} from '../../features/chat/buildAttachmentPresentation'

type SharedAttachmentItem = SharedAttachmentPresentationItem
type UnsharedRecord = UnsharedAttachmentRecord

export function buildAttachmentTransferPresentation({
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
  sharedAttachments: SharedAttachmentItem[]
  sharedByAttachmentId?: Record<string, SharedAttachmentItem | undefined>
  completedDownloadPathByAttachmentId?: Record<string, string | undefined>
  unsharedAttachmentRecords: Record<string, UnsharedRecord | null | undefined>
  hasAccessibleCompletedDownload: (id: string | null | undefined) => boolean
  getCachedPathForSha: (sha: string | undefined) => string | null
}) {
  return buildAttachmentPresentation({
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
  })
}
