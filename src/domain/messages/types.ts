import type { EphemeralAttachmentMeta } from '../attachments/types'

export interface EphemeralChatMessage {
  id: string
  signing_pubkey: string
  chat_id: string
  from_user_id: string
  text: string
  kind?: 'text' | 'attachment' | 'mixed'
  /** Single attachment (legacy / single-attachment messages). */
  attachment?: EphemeralAttachmentMeta
  /** Multiple attachments in draft order; attachments render first, then text as caption below. */
  attachments?: EphemeralAttachmentMeta[]
  sent_at: string
  local_only?: boolean
  delivery_status?: 'pending' | 'delivered' | 'bundling'
  delivered_by?: string[]
  /** SHA compute progress 0-100 while bundling. Sender-only. */
  bundling_progress?: number
  /** Cached encrypted payload for background retries. Sender-only. */
  encrypted_payload?: string
}

export interface SendEphemeralChatInput {
  serverId: string
  signingPubkey: string
  chatId: string
  fromUserId: string
  text: string
}

export interface SendEphemeralAttachmentInput {
  serverId: string
  signingPubkey: string
  chatId: string
  fromUserId: string
  attachment: EphemeralAttachmentMeta
}

export interface SendMixedMessageInput {
  serverId: string
  signingPubkey: string
  chatId: string
  fromUserId: string
  /** Attachments in display order (draft order). Shown first in chat. */
  attachments: EphemeralAttachmentMeta[]
  /** Optional caption, shown below the attachment grid. */
  text?: string
  /** When provided, replace this message (e.g. bundling placeholder) instead of appending. */
  replaceMessageId?: string
}

export interface AddBundlingMessageInput {
  messageId: string
  signingPubkey: string
  chatId: string
  fromUserId: string
  /** Staged attachments with path for preview. */
  staged: Array<{ path: string; file_name: string; extension: string; size_bytes: number; spoiler?: boolean }>
  text?: string
}

export type MessageBuckets = Record<string, EphemeralChatMessage[]>
