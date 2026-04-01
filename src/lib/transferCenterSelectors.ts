import type { EphemeralMessagesState } from '../stores/ephemeralMessagesStore'

/**
 * Stable while only **download** progress/debug fields change — upload rows’ “active server dots” layout unchanged.
 * Used so seeding library list does not re-render on every KB/s tick.
 */
export function selectUploadActiveLayoutSig(s: EphemeralMessagesState): string {
  const keys: string[] = []
  for (const t of s.attachmentTransfers) {
    if (t.direction !== 'upload') continue
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'rejected') continue
    const sha = t.sha256?.trim() ?? ''
    const spk = t.server_signing_pubkey?.trim() ?? ''
    if (!spk) continue
    keys.push(`${sha}\u0000${spk}\u0000${t.attachment_id ?? ''}`)
  }
  keys.sort()
  return keys.join('\n')
}

/**
 * Stable while only **transferring** download progress changes — same set of active download request_ids.
 */
export function selectActiveDownloadRequestIdsSig(s: EphemeralMessagesState): string {
  const ids: string[] = []
  for (const t of s.attachmentTransfers) {
    if (t.direction !== 'download') continue
    if (
      t.status !== 'requesting' &&
      t.status !== 'connecting' &&
      t.status !== 'transferring' &&
      t.status !== 'queued'
    ) {
      continue
    }
    ids.push(t.request_id)
  }
  ids.sort()
  return ids.join('\0')
}
