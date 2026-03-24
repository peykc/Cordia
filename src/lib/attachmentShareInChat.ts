import type { EphemeralChatMessage } from '../contexts/EphemeralMessagesContext'

/**
 * Same rules as inline "Share again" / "Share in this chat" on attachment tiles in chat.
 * Use for preview toolbar so visibility stays in sync with the grid.
 */
export function attachmentShareInChatVisible(opts: {
  isOwn: boolean
  hasPath: boolean
  deliveryStatus: EphemeralChatMessage['delivery_status'] | undefined
  serverSigningPubkey: string
  sha256: string | undefined
  attachmentId: string
  isSharedInServer: (serverSigningPubkey: string, sha256: string) => boolean
  justSharedKeys: Set<string>
  hasActiveUpload: boolean
}): boolean {
  const {
    isOwn,
    hasPath,
    deliveryStatus,
    serverSigningPubkey,
    sha256,
    attachmentId,
    isSharedInServer,
    justSharedKeys,
    hasActiveUpload,
  } = opts
  if (isSharedInServer(serverSigningPubkey, sha256 ?? '')) return false
  if (justSharedKeys.has(`att:${attachmentId}`)) return false
  if (sha256 && justSharedKeys.has(`sha:${sha256}`)) return false
  if (isOwn) {
    if (deliveryStatus === 'bundling') return false
    if (hasActiveUpload) return false
    return true
  }
  if (!hasPath) return false
  return true
}
