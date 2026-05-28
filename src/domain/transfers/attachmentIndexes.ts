import type { AttachmentTransferState, TransferHistoryEntry } from './types'

export type AttachmentTransferIndexes = {
  rejectedDownloadByAttachmentId: Record<string, true>
  activeUploadByAttachmentId: Record<string, true>
  completedDownloadPathByAttachmentId: Record<string, string>
  activeDownloadRequestIdByAttachmentId: Record<string, string>
  activeUploadRequestIdsByAttachmentId: Record<string, string[]>
}

export const EMPTY_ATTACHMENT_INDEXES: AttachmentTransferIndexes = {
  rejectedDownloadByAttachmentId: {},
  activeUploadByAttachmentId: {},
  completedDownloadPathByAttachmentId: {},
  activeDownloadRequestIdByAttachmentId: {},
  activeUploadRequestIdsByAttachmentId: {},
}

export function sameRecordKeysAndValues<K extends string, V>(
  prev: Record<K, V>,
  next: Record<K, V>
): boolean {
  const prevKeys = Object.keys(prev)
  if (prevKeys.length !== Object.keys(next).length) return false
  for (const key of prevKeys) {
    if (prev[key as K] !== next[key as K]) return false
  }
  return true
}

export function mergeStableRecord<K extends string, V>(
  prev: Record<K, V>,
  next: Record<K, V>
): Record<K, V> {
  return sameRecordKeysAndValues(prev, next) ? prev : next
}

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function mergeStableStringArrayMap(
  prev: Record<string, string[]>,
  next: Record<string, string[]>
): Record<string, string[]> {
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  if (prevKeys.length !== nextKeys.length) return next
  for (const key of nextKeys) {
    const prevArr = prev[key]
    const nextArr = next[key]
    if (!prevArr || !nextArr || !sameStringArray(prevArr, nextArr)) return next
  }
  return prev
}

export function buildTransferAttachmentIndexes(
  transfersByRequestId: Record<string, AttachmentTransferState>,
  activeDownloadIds: readonly string[],
  activeUploadIds: readonly string[]
): Pick<
  AttachmentTransferIndexes,
  | 'rejectedDownloadByAttachmentId'
  | 'activeUploadByAttachmentId'
  | 'activeDownloadRequestIdByAttachmentId'
  | 'activeUploadRequestIdsByAttachmentId'
> {
  const rejectedDownloadByAttachmentId: Record<string, true> = {}
  const activeUploadByAttachmentId: Record<string, true> = {}
  const activeDownloadRequestIdByAttachmentId: Record<string, string> = {}
  const activeUploadRequestIdsByAttachmentId: Record<string, string[]> = {}

  for (const transfer of Object.values(transfersByRequestId)) {
    if (transfer.direction === 'download' && transfer.status === 'rejected') {
      rejectedDownloadByAttachmentId[transfer.attachment_id] = true
    }
  }

  for (const requestId of activeDownloadIds) {
    const transfer = transfersByRequestId[requestId]
    if (transfer?.direction === 'download') {
      activeDownloadRequestIdByAttachmentId[transfer.attachment_id] = requestId
    }
  }

  for (const requestId of activeUploadIds) {
    const transfer = transfersByRequestId[requestId]
    if (transfer?.direction !== 'upload') continue
    const attachmentId = transfer.attachment_id
    const list = activeUploadRequestIdsByAttachmentId[attachmentId] ?? []
    list.push(requestId)
    activeUploadRequestIdsByAttachmentId[attachmentId] = list
    activeUploadByAttachmentId[attachmentId] = true
  }

  for (const key of Object.keys(activeUploadRequestIdsByAttachmentId)) {
    activeUploadRequestIdsByAttachmentId[key].sort()
  }

  return {
    rejectedDownloadByAttachmentId,
    activeUploadByAttachmentId,
    activeDownloadRequestIdByAttachmentId,
    activeUploadRequestIdsByAttachmentId,
  }
}

export function buildHistoryAttachmentIndexes(
  transferHistory: readonly TransferHistoryEntry[]
): Pick<AttachmentTransferIndexes, 'rejectedDownloadByAttachmentId' | 'completedDownloadPathByAttachmentId'> {
  const rejectedDownloadByAttachmentId: Record<string, true> = {}
  const completedDownloadPathByAttachmentId: Record<string, string> = {}

  for (const entry of transferHistory) {
    if (entry.direction === 'download' && entry.status === 'rejected') {
      rejectedDownloadByAttachmentId[entry.attachment_id] = true
    }
    if (
      entry.direction === 'download' &&
      entry.status === 'completed' &&
      entry.saved_path &&
      !completedDownloadPathByAttachmentId[entry.attachment_id]
    ) {
      completedDownloadPathByAttachmentId[entry.attachment_id] = entry.saved_path
    }
  }

  return { rejectedDownloadByAttachmentId, completedDownloadPathByAttachmentId }
}

function mergeRejectedMaps(
  fromTransfers: Record<string, true>,
  fromHistory: Record<string, true>
): Record<string, true> {
  const merged: Record<string, true> = { ...fromTransfers }
  for (const key of Object.keys(fromHistory)) {
    merged[key] = true
  }
  return merged
}

export function mergeAttachmentIndexes(
  prev: AttachmentTransferIndexes,
  transfersByRequestId: Record<string, AttachmentTransferState>,
  activeDownloadIds: readonly string[],
  activeUploadIds: readonly string[],
  transferHistory: readonly TransferHistoryEntry[]
): AttachmentTransferIndexes {
  const fromTransfers = buildTransferAttachmentIndexes(
    transfersByRequestId,
    activeDownloadIds,
    activeUploadIds
  )
  const fromHistory = buildHistoryAttachmentIndexes(transferHistory)
  const rejectedNext = mergeRejectedMaps(
    fromTransfers.rejectedDownloadByAttachmentId,
    fromHistory.rejectedDownloadByAttachmentId
  )

  return {
    rejectedDownloadByAttachmentId: mergeStableRecord(prev.rejectedDownloadByAttachmentId, rejectedNext),
    activeUploadByAttachmentId: mergeStableRecord(prev.activeUploadByAttachmentId, fromTransfers.activeUploadByAttachmentId),
    completedDownloadPathByAttachmentId: mergeStableRecord(
      prev.completedDownloadPathByAttachmentId,
      fromHistory.completedDownloadPathByAttachmentId
    ),
    activeDownloadRequestIdByAttachmentId: mergeStableRecord(
      prev.activeDownloadRequestIdByAttachmentId,
      fromTransfers.activeDownloadRequestIdByAttachmentId
    ),
    activeUploadRequestIdsByAttachmentId: mergeStableStringArrayMap(
      prev.activeUploadRequestIdsByAttachmentId,
      fromTransfers.activeUploadRequestIdsByAttachmentId
    ),
  }
}

export function selectChatAttachmentRowFactsSig(indexes: AttachmentTransferIndexes): string {
  const rejectedKeys = Object.keys(indexes.rejectedDownloadByAttachmentId).sort().join(',')
  const uploadKeys = Object.keys(indexes.activeUploadByAttachmentId).sort().join(',')
  const completedKeys = Object.keys(indexes.completedDownloadPathByAttachmentId)
    .sort()
    .map((k) => `${k}:${indexes.completedDownloadPathByAttachmentId[k]}`)
    .join(',')
  return `${rejectedKeys}\n${uploadKeys}\n${completedKeys}`
}
