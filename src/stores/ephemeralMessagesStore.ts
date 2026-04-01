import { create } from 'zustand'
import type { EphemeralChatMessage } from '../contexts/EphemeralMessagesContext'
import type { AttachmentTransferState, TransferHistoryEntry } from '../contexts/EphemeralMessagesContext'
import type { SharedAttachmentItem } from '../lib/tauri'

export type MessageBuckets = Record<string, EphemeralChatMessage[]>

function bucketKey(signingPubkey: string, chatId: string): string {
  return `${signingPubkey}::${chatId}`
}

export interface EphemeralMessagesState {
  messagesByBucket: MessageBuckets
  attachmentTransfers: AttachmentTransferState[]
  transferHistory: TransferHistoryEntry[]
  sharedAttachments: SharedAttachmentItem[]
  serverSharedSha: Record<string, string[]>
  contentCacheBySha: Record<string, string>
  setMessagesByBucket: (updater: MessageBuckets | ((prev: MessageBuckets) => MessageBuckets)) => void
  setAttachmentTransfers: (updater: AttachmentTransferState[] | ((prev: AttachmentTransferState[]) => AttachmentTransferState[])) => void
  setTransferHistory: (updater: TransferHistoryEntry[] | ((prev: TransferHistoryEntry[]) => TransferHistoryEntry[])) => void
  setSharedAttachments: (updater: SharedAttachmentItem[] | ((prev: SharedAttachmentItem[]) => SharedAttachmentItem[])) => void
  setServerSharedSha: (updater: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>)) => void
  setContentCacheBySha: (updater: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void
}

function runUpdater<T>(updater: T | ((prev: T) => T), prev: T): T {
  return typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater
}

export const useEphemeralMessagesStore = create<EphemeralMessagesState>((set) => ({
  messagesByBucket: {},
  attachmentTransfers: [],
  transferHistory: [],
  sharedAttachments: [],
  serverSharedSha: {},
  contentCacheBySha: {},
  setMessagesByBucket: (updater) => set((s) => ({ messagesByBucket: runUpdater(updater, s.messagesByBucket) })),
  setAttachmentTransfers: (updater) => set((s) => ({ attachmentTransfers: runUpdater(updater, s.attachmentTransfers) })),
  setTransferHistory: (updater) => set((s) => ({ transferHistory: runUpdater(updater, s.transferHistory) })),
  setSharedAttachments: (updater) => set((s) => ({ sharedAttachments: runUpdater(updater, s.sharedAttachments) })),
  setServerSharedSha: (updater) => set((s) => ({ serverSharedSha: runUpdater(updater, s.serverSharedSha) })),
  setContentCacheBySha: (updater) => set((s) => ({ contentCacheBySha: runUpdater(updater, s.contentCacheBySha) })),
}))

const EMPTY_MESSAGES: EphemeralChatMessage[] = []

/** Selector hook: subscribe only to messages for one chat. Re-renders only when that bucket changes. */
export function useChatMessages(signingPubkey: string | undefined, chatId: string | undefined): EphemeralChatMessage[] {
  const key = signingPubkey && chatId ? bucketKey(signingPubkey, chatId) : ''
  return useEphemeralMessagesStore((state) => (key ? state.messagesByBucket[key] ?? EMPTY_MESSAGES : EMPTY_MESSAGES))
}

export function getBucketKey(signingPubkey: string, chatId: string): string {
  return bucketKey(signingPubkey, chatId)
}
