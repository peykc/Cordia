import type { EphemeralMessagesState } from '../../stores/ephemeralMessagesStore'
import {
  groupActiveUploadsByAttachmentId,
  type ActiveUploadGroupView,
} from '../../domain/transfers/selectors'

/** Stable while only upload progress/debug changes — same attachment_id groups. */
export function selectActiveUploadGroupKeysSig(s: EphemeralMessagesState): string {
  return groupActiveUploadsByAttachmentId(s)
    .map((g) => g.attachmentId)
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
