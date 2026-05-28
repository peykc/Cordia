import { create } from 'zustand'
import type { EphemeralChatMessage } from '../domain/messages/types'
import type { AttachmentTransferState, TransferHistoryEntry } from '../domain/transfers/types'
import {
  EMPTY_ATTACHMENT_INDEXES,
  mergeAttachmentIndexes,
  sameStringArray,
  selectChatAttachmentRowFactsSig,
  type AttachmentTransferIndexes,
} from '../domain/transfers/attachmentIndexes'
import type { SharedAttachmentItem } from '../lib/tauri'

export type MessageBuckets = Record<string, EphemeralChatMessage[]>

function bucketKey(signingPubkey: string, chatId: string): string {
  return `${signingPubkey}::${chatId}`
}

export interface EphemeralMessagesState extends AttachmentTransferIndexes {
  messagesByBucket: MessageBuckets
  messagesById: Record<string, EphemeralChatMessage>
  /** Derived compatibility array — prefer keyed lookups for subscriptions. */
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
  /** Compatibility setter — prefer upsertTransferByRequestId / removeTransferByRequestId. */
  setAttachmentTransfers: (updater: AttachmentTransferState[] | ((prev: AttachmentTransferState[]) => AttachmentTransferState[])) => void
  upsertTransferByRequestId: (
    requestId: string,
    updater: (prev: AttachmentTransferState | undefined) => AttachmentTransferState
  ) => void
  removeTransferByRequestId: (requestId: string) => void
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

function indexTransfers(transfersByRequestId: Record<string, AttachmentTransferState>) {
  const attachmentTransfers = Object.values(transfersByRequestId)
  const activeDownloadIds: string[] = []
  const activeUploadIds: string[] = []
  for (const transfer of attachmentTransfers) {
    if (!isActiveTransfer(transfer)) continue
    if (transfer.direction === 'download') activeDownloadIds.push(transfer.request_id)
    else activeUploadIds.push(transfer.request_id)
  }
  activeDownloadIds.sort()
  activeUploadIds.sort()
  return { attachmentTransfers, transfersByRequestId, activeDownloadIds, activeUploadIds }
}

function mergeActiveIdArrays(
  prev: EphemeralMessagesState,
  nextActiveDownloadIds: string[],
  nextActiveUploadIds: string[]
): { activeDownloadIds: string[]; activeUploadIds: string[] } {
  return {
    activeDownloadIds: sameStringArray(prev.activeDownloadIds, nextActiveDownloadIds)
      ? prev.activeDownloadIds
      : nextActiveDownloadIds,
    activeUploadIds: sameStringArray(prev.activeUploadIds, nextActiveUploadIds)
      ? prev.activeUploadIds
      : nextActiveUploadIds,
  }
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

function withAttachmentIndexes(
  prev: EphemeralMessagesState,
  transfersByRequestId: Record<string, AttachmentTransferState>,
  activeDownloadIds: string[],
  activeUploadIds: string[],
  transferHistory: TransferHistoryEntry[]
): AttachmentTransferIndexes {
  return mergeAttachmentIndexes(
    {
      rejectedDownloadByAttachmentId: prev.rejectedDownloadByAttachmentId,
      activeUploadByAttachmentId: prev.activeUploadByAttachmentId,
      completedDownloadPathByAttachmentId: prev.completedDownloadPathByAttachmentId,
      activeDownloadRequestIdByAttachmentId: prev.activeDownloadRequestIdByAttachmentId,
      activeUploadRequestIdsByAttachmentId: prev.activeUploadRequestIdsByAttachmentId,
    },
    transfersByRequestId,
    activeDownloadIds,
    activeUploadIds,
    transferHistory
  )
}

export { selectChatAttachmentRowFactsSig }

export const useEphemeralMessagesStore = create<EphemeralMessagesState>((set) => ({
  messagesByBucket: {},
  messagesById: {},
  ...EMPTY_ATTACHMENT_INDEXES,
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
      const transfersByRequestId: Record<string, AttachmentTransferState> = {}
      for (const transfer of attachmentTransfers) {
        transfersByRequestId[transfer.request_id] = transfer
      }
      const transferIndex = indexTransfers(transfersByRequestId)
      const { activeDownloadIds, activeUploadIds } = mergeActiveIdArrays(
        s,
        transferIndex.activeDownloadIds,
        transferIndex.activeUploadIds
      )
      const attachmentIndexes = withAttachmentIndexes(
        s,
        transferIndex.transfersByRequestId,
        activeDownloadIds,
        activeUploadIds,
        s.transferHistory
      )
      return { ...transferIndex, activeDownloadIds, activeUploadIds, ...attachmentIndexes }
    }),
  upsertTransferByRequestId: (requestId, updater) =>
    set((s) => {
      const nextTransfer = updater(s.transfersByRequestId[requestId])
      const transfersByRequestId = { ...s.transfersByRequestId, [requestId]: nextTransfer }
      const transferIndex = indexTransfers(transfersByRequestId)
      const { activeDownloadIds, activeUploadIds } = mergeActiveIdArrays(
        s,
        transferIndex.activeDownloadIds,
        transferIndex.activeUploadIds
      )
      const attachmentIndexes = withAttachmentIndexes(
        s,
        transferIndex.transfersByRequestId,
        activeDownloadIds,
        activeUploadIds,
        s.transferHistory
      )
      return { ...transferIndex, activeDownloadIds, activeUploadIds, ...attachmentIndexes }
    }),
  removeTransferByRequestId: (requestId) =>
    set((s) => {
      if (!s.transfersByRequestId[requestId]) return s
      const { [requestId]: _removed, ...rest } = s.transfersByRequestId
      const transferIndex = indexTransfers(rest)
      const { activeDownloadIds, activeUploadIds } = mergeActiveIdArrays(
        s,
        transferIndex.activeDownloadIds,
        transferIndex.activeUploadIds
      )
      const attachmentIndexes = withAttachmentIndexes(
        s,
        transferIndex.transfersByRequestId,
        activeDownloadIds,
        activeUploadIds,
        s.transferHistory
      )
      return { ...transferIndex, activeDownloadIds, activeUploadIds, ...attachmentIndexes }
    }),
  setTransferHistory: (updater) =>
    set((s) => {
      const transferHistory = runUpdater(updater, s.transferHistory)
      const historyIndex = indexTransferHistory(transferHistory)
      const attachmentIndexes = withAttachmentIndexes(
        s,
        s.transfersByRequestId,
        s.activeDownloadIds,
        s.activeUploadIds,
        transferHistory
      )
      return { transferHistory, ...historyIndex, ...attachmentIndexes }
    }),
  setSharedAttachments: (updater) => set((s) => ({ sharedAttachments: runUpdater(updater, s.sharedAttachments) })),
  setServerSharedSha: (updater) => set((s) => ({ serverSharedSha: runUpdater(updater, s.serverSharedSha) })),
  setContentCacheBySha: (updater) => set((s) => ({ contentCacheBySha: runUpdater(updater, s.contentCacheBySha) })),
}))

const EMPTY_MESSAGES: EphemeralChatMessage[] = []
const EMPTY_REQUEST_IDS: string[] = []

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

export function useActiveUploadRequestIdsForAttachment(attachmentId: string | undefined): string[] {
  return useEphemeralMessagesStore((state) => {
    if (!attachmentId) return EMPTY_REQUEST_IDS
    return state.activeUploadRequestIdsByAttachmentId[attachmentId] ?? EMPTY_REQUEST_IDS
  })
}

export function useActiveUploadForAttachment(attachmentId: string | undefined): boolean {
  return useEphemeralMessagesStore((state) =>
    attachmentId ? !!state.activeUploadByAttachmentId[attachmentId] : false
  )
}

export function useRejectedDownloadForAttachment(attachmentId: string | undefined): boolean {
  return useEphemeralMessagesStore((state) =>
    attachmentId ? !!state.rejectedDownloadByAttachmentId[attachmentId] : false
  )
}

export function useCompletedDownloadPathForAttachment(attachmentId: string | undefined): string | undefined {
  return useEphemeralMessagesStore((state) =>
    attachmentId ? state.completedDownloadPathByAttachmentId[attachmentId] : undefined
  )
}

export function useLiveDownloadForAttachment(attachmentId: string | undefined): AttachmentTransferState | undefined {
  const requestId = useEphemeralMessagesStore((state) =>
    attachmentId ? state.activeDownloadRequestIdByAttachmentId[attachmentId] : undefined
  )
  return useTransferByRequestId(requestId)
}
