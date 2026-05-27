import { create } from 'zustand'
import type { EphemeralChatMessage } from '../domain/messages/types'
import type { AttachmentTransferState, TransferHistoryEntry } from '../domain/transfers/types'
import type { SharedAttachmentItem } from '../lib/tauri'

export type MessageBuckets = Record<string, EphemeralChatMessage[]>

function bucketKey(signingPubkey: string, chatId: string): string {
  return `${signingPubkey}::${chatId}`
}

export interface EphemeralMessagesState {
  messagesByBucket: MessageBuckets
  messagesById: Record<string, EphemeralChatMessage>
  attachmentTransfers: AttachmentTransferState[]
  transfersByRequestId: Record<string, AttachmentTransferState>
  activeDownloadIds: string[]
  activeUploadIds: string[]
  transferHistory: TransferHistoryEntry[]
  transferHistoryByRequestId: Record<string, TransferHistoryEntry>
  historyIds: string[]
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

function isActiveTransfer(t: AttachmentTransferState): boolean {
  return t.status === 'queued' || t.status === 'requesting' || t.status === 'connecting' || t.status === 'transferring'
}

function indexTransfers(transfers: AttachmentTransferState[]) {
  const transfersByRequestId: Record<string, AttachmentTransferState> = {}
  const activeDownloadIds: string[] = []
  const activeUploadIds: string[] = []
  for (const transfer of transfers) {
    transfersByRequestId[transfer.request_id] = transfer
    if (!isActiveTransfer(transfer)) continue
    if (transfer.direction === 'download') activeDownloadIds.push(transfer.request_id)
    else activeUploadIds.push(transfer.request_id)
  }
  return { transfersByRequestId, activeDownloadIds, activeUploadIds }
}

function indexTransferHistory(history: TransferHistoryEntry[]) {
  const transferHistoryByRequestId: Record<string, TransferHistoryEntry> = {}
  const historyIds: string[] = []
  for (const entry of history) {
    transferHistoryByRequestId[entry.request_id] = entry
    historyIds.push(entry.request_id)
  }
  return { transferHistoryByRequestId, historyIds }
}

function indexMessages(messagesByBucket: MessageBuckets): Record<string, EphemeralChatMessage> {
  const messagesById: Record<string, EphemeralChatMessage> = {}
  for (const list of Object.values(messagesByBucket)) {
    for (const message of list) {
      messagesById[message.id] = message
    }
  }
  return messagesById
}

export const useEphemeralMessagesStore = create<EphemeralMessagesState>((set) => ({
  messagesByBucket: {},
  messagesById: {},
  attachmentTransfers: [],
  transfersByRequestId: {},
  activeDownloadIds: [],
  activeUploadIds: [],
  transferHistory: [],
  transferHistoryByRequestId: {},
  historyIds: [],
  sharedAttachments: [],
  serverSharedSha: {},
  contentCacheBySha: {},
  setMessagesByBucket: (updater) =>
    set((s) => {
      const messagesByBucket = runUpdater(updater, s.messagesByBucket)
      return { messagesByBucket, messagesById: indexMessages(messagesByBucket) }
    }),
  setAttachmentTransfers: (updater) =>
    set((s) => {
      const attachmentTransfers = runUpdater(updater, s.attachmentTransfers)
      return { attachmentTransfers, ...indexTransfers(attachmentTransfers) }
    }),
  setTransferHistory: (updater) =>
    set((s) => {
      const transferHistory = runUpdater(updater, s.transferHistory)
      return { transferHistory, ...indexTransferHistory(transferHistory) }
    }),
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

export function useMessageById(messageId: string | undefined): EphemeralChatMessage | undefined {
  return useEphemeralMessagesStore((state) => (messageId ? state.messagesById[messageId] : undefined))
}

export function getBucketKey(signingPubkey: string, chatId: string): string {
  return bucketKey(signingPubkey, chatId)
}

export function useTransferByRequestId(requestId: string | undefined): AttachmentTransferState | undefined {
  return useEphemeralMessagesStore((state) => (requestId ? state.transfersByRequestId[requestId] : undefined))
}

export function useTransferHistoryByRequestId(requestId: string | undefined): TransferHistoryEntry | undefined {
  return useEphemeralMessagesStore((state) => (requestId ? state.transferHistoryByRequestId[requestId] : undefined))
}
