import type { EphemeralAttachmentMeta } from '../../domain/attachments/types'
import type { AttachmentTransferState } from '../../domain/transfers/types'
import { useLiveDownloadForAttachment } from '../../stores/ephemeralMessagesStore'
import {
  buildAttachmentPresentationFromFacts,
  type AttachmentPresentation,
  type SharedAttachmentPresentationItem,
  type UnsharedAttachmentRecord,
} from './buildAttachmentPresentation'

export type UseAttachmentPresentationOptions = {
  attachmentRef: EphemeralAttachmentMeta
  isOwn: boolean
  sharedItem?: SharedAttachmentPresentationItem
  completedDownloadPath?: string
  unsharedRec?: UnsharedAttachmentRecord | null
  hasAccessibleCompletedDownload: (id: string | null | undefined) => boolean
  getCachedPathForSha: (sha: string | undefined) => string | null
}

/** Keyed subscription: live download for one attachment only (no full-array scan). */
export function useAttachmentPresentation({
  attachmentRef,
  isOwn,
  sharedItem,
  completedDownloadPath,
  unsharedRec,
  hasAccessibleCompletedDownload,
  getCachedPathForSha,
}: UseAttachmentPresentationOptions): AttachmentPresentation {
  const liveDownload = useLiveDownloadForAttachment(attachmentRef.attachment_id)
  const cachedPath = getCachedPathForSha(attachmentRef.sha256) ?? undefined

  return buildAttachmentPresentationFromFacts({
    attachmentRef,
    isOwn,
    liveDownload,
    completedDownloadPath,
    sharedItem,
    cachedPath,
    unsharedRec,
    hasAccessibleCompletedDownload,
  })
}

export function resolveLiveDownloadForAttachment(
  transfersByRequestId: Record<string, AttachmentTransferState>,
  activeDownloadIds: string[],
  attachmentId: string
): AttachmentTransferState | undefined {
  for (const requestId of activeDownloadIds) {
    const transfer = transfersByRequestId[requestId]
    if (
      transfer?.attachment_id === attachmentId &&
      transfer.direction === 'download' &&
      (transfer.status === 'requesting' ||
        transfer.status === 'connecting' ||
        transfer.status === 'transferring' ||
        transfer.status === 'queued')
    ) {
      return transfer
    }
  }
  return undefined
}
