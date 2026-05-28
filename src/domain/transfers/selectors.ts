import type { AttachmentTransferState } from './types'

export type EphemeralMessagesTransferSlice = {
  transfersByRequestId: Record<string, AttachmentTransferState>
  activeDownloadIds: string[]
  activeUploadIds: string[]
  transferHistoryByRequestId: Record<string, import('./types').TransferHistoryEntry>
  historyIds: string[]
}

export function selectTransfer(
  state: EphemeralMessagesTransferSlice,
  requestId: string | undefined
): AttachmentTransferState | undefined {
  if (!requestId) return undefined
  return state.transfersByRequestId[requestId]
}

export function selectActiveDownloadTransfers(state: EphemeralMessagesTransferSlice): AttachmentTransferState[] {
  return state.activeDownloadIds
    .map((id) => state.transfersByRequestId[id])
    .filter((t): t is AttachmentTransferState => t != null)
}

export function selectActiveUploadTransfers(state: EphemeralMessagesTransferSlice): AttachmentTransferState[] {
  return state.activeUploadIds
    .map((id) => state.transfersByRequestId[id])
    .filter((t): t is AttachmentTransferState => t != null)
}

export type ActiveUploadGroupView = {
  attachmentId: string
  requestIds: string[]
}

/** Group active uploads by attachment_id using keyed indexes only. */
export function groupActiveUploadsByAttachmentId(state: EphemeralMessagesTransferSlice): ActiveUploadGroupView[] {
  const byAttachment = new Map<string, string[]>()
  for (const requestId of state.activeUploadIds) {
    const transfer = state.transfersByRequestId[requestId]
    if (!transfer || transfer.direction !== 'upload') continue
    const list = byAttachment.get(transfer.attachment_id) ?? []
    list.push(requestId)
    byAttachment.set(transfer.attachment_id, list)
  }
  return Array.from(byAttachment.entries())
    .map(([attachmentId, requestIds]) => ({ attachmentId, requestIds: requestIds.sort() }))
    .sort((a, b) => a.attachmentId.localeCompare(b.attachmentId))
}

export function selectActiveDownloadQueuedCount(state: EphemeralMessagesTransferSlice): number {
  let count = 0
  for (const id of state.activeDownloadIds) {
    if (state.transfersByRequestId[id]?.status === 'queued') count += 1
  }
  return count
}

export function selectAggregateActiveDownloadKbps(state: EphemeralMessagesTransferSlice): number {
  let sum = 0
  for (const id of state.activeDownloadIds) {
    const kbps = state.transfersByRequestId[id]?.debug_kbps
    if (kbps != null && Number.isFinite(kbps)) sum += Math.max(0, kbps)
  }
  return sum
}

export function selectAggregateActiveUploadKbps(state: EphemeralMessagesTransferSlice): number {
  let sum = 0
  for (const id of state.activeUploadIds) {
    const kbps = state.transfersByRequestId[id]?.debug_kbps
    if (kbps != null && Number.isFinite(kbps)) sum += Math.max(0, kbps)
  }
  return sum
}

export function selectActiveUploadSessionCount(state: EphemeralMessagesTransferSlice): number {
  return state.activeUploadIds.length
}
