import type { EphemeralAttachmentMeta } from '../../domain/attachments/types'
import type { AttachmentTransferState } from '../../domain/transfers/types'
import { useEphemeralMessagesStore } from '../../stores/ephemeralMessagesStore'
import {
  buildAttachmentPresentationFromFacts,
  type AttachmentPresentation,
  type SharedAttachmentPresentationItem,
  type UnsharedAttachmentRecord,
} from './buildAttachmentPresentation'

export type ResolveChatAttachmentPresentationInput = {
  att: EphemeralAttachmentMeta
  isOwn: boolean
  sharedByAttachmentId?: Record<string, SharedAttachmentPresentationItem | undefined>
  unsharedAttachmentRecords?: Record<string, UnsharedAttachmentRecord | null | undefined>
  hasAccessibleCompletedDownload: (id: string | null | undefined) => boolean
  getCachedPathForSha: (sha: string | undefined) => string | null
  /** Optional override for reactive callers that already have live download. */
  liveDownload?: AttachmentTransferState
}

/** Sync resolver for event handlers — uses store indexes, not full-array scans. */
export function resolveChatAttachmentPresentation({
  att,
  isOwn,
  sharedByAttachmentId,
  unsharedAttachmentRecords,
  hasAccessibleCompletedDownload,
  getCachedPathForSha,
  liveDownload: liveDownloadOverride,
}: ResolveChatAttachmentPresentationInput): AttachmentPresentation {
  const state = useEphemeralMessagesStore.getState()
  const requestId = state.activeDownloadRequestIdByAttachmentId[att.attachment_id]
  const liveDownload =
    liveDownloadOverride ??
    (requestId ? state.transfersByRequestId[requestId] : undefined)
  const sharedItem = sharedByAttachmentId?.[att.attachment_id]
  const unsharedRec = unsharedAttachmentRecords?.[att.attachment_id]
  const completedDownloadPath = state.completedDownloadPathByAttachmentId[att.attachment_id]
  const cachedPath = getCachedPathForSha(att.sha256) ?? undefined

  return buildAttachmentPresentationFromFacts({
    attachmentRef: att,
    isOwn,
    liveDownload,
    completedDownloadPath,
    sharedItem,
    cachedPath,
    unsharedRec,
    hasAccessibleCompletedDownload,
  })
}
