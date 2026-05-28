import type { AttachmentTransferState, TransferHistoryEntry } from '../../domain/transfers/types'
import type { EphemeralMessagesState } from '../../stores/ephemeralMessagesStore'
import {
  groupActiveUploadsByAttachmentId,
  type ActiveUploadGroupView,
} from '../../domain/transfers/selectors'

export type ActiveDownloadRowView = {
  requestId: string
  attachmentId: string
  fileName: string
  fromUserId: string
  toUserId: string
  sizeBytes?: number
  createdAt?: string
  messageId?: string
}

export function buildActiveDownloadRowView(
  live: AttachmentTransferState | undefined,
  history: TransferHistoryEntry | undefined
): ActiveDownloadRowView | null {
  const requestId = live?.request_id ?? history?.request_id
  if (!requestId) return null
  return {
    requestId,
    attachmentId: live?.attachment_id ?? history?.attachment_id ?? '',
    fileName: live?.file_name ?? history?.file_name ?? 'attachment.bin',
    fromUserId: live?.from_user_id ?? history?.from_user_id ?? '',
    toUserId: live?.to_user_id ?? history?.to_user_id ?? '',
    sizeBytes: history?.size_bytes,
    createdAt: history?.created_at,
    messageId: live?.message_id ?? history?.message_id,
  }
}

/** Map static active-row metadata to history entry shape for shared row component. */
export function activeDownloadRowViewToHistoryEntry(row: ActiveDownloadRowView): TransferHistoryEntry {
  const createdAt = row.createdAt ?? new Date(0).toISOString()
  return {
    request_id: row.requestId,
    message_id: row.messageId ?? '',
    attachment_id: row.attachmentId,
    file_name: row.fileName,
    size_bytes: row.sizeBytes,
    from_user_id: row.fromUserId,
    to_user_id: row.toUserId,
    direction: 'download',
    status: 'queued',
    progress: 0,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

/** Stable while only upload progress/debug changes — membership by attachment + request IDs. */
export function selectActiveUploadGroupKeysSig(s: EphemeralMessagesState): string {
  return groupActiveUploadsByAttachmentId(s)
    .map((g) => `${g.attachmentId}:${g.requestIds.join(',')}`)
    .join('\0')
}

export function buildActiveUploadGroups(state: EphemeralMessagesState): ActiveUploadGroupView[] {
  return groupActiveUploadsByAttachmentId(state)
}

/** Stable while the set of active download request_ids is unchanged. */
export function selectActiveDownloadRequestIdsSig(s: EphemeralMessagesState): string {
  const ids = [...s.activeDownloadIds]
  ids.sort()
  return ids.join('\0')
}

/**
 * Stable while only download progress/debug fields change — upload rows' seeding dots layout unchanged.
 */
export function selectUploadActiveLayoutSig(s: EphemeralMessagesState): string {
  const keys: string[] = []
  for (const id of s.activeUploadIds) {
    const t = s.transfersByRequestId[id]
    if (!t) continue
    if (t.direction !== 'upload') continue
    const sha = t.sha256?.trim() ?? ''
    const spk = t.server_signing_pubkey?.trim() ?? ''
    if (!spk) continue
    keys.push(`${sha}\u0000${spk}\u0000${t.attachment_id ?? ''}`)
  }
  keys.sort()
  return keys.join('\n')
}
