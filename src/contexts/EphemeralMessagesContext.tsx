import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  beginDownloadStream,
  cancelDownloadStream,
  finishDownloadStream,
  listSharedAttachments,
  listServers,
  pathExists,
  readAttachmentChunk,
  writeDownloadStreamChunk,
  type SharedAttachmentItem,
  unshareAttachment,
  decryptEphemeralChatMessageBySigningPubkey,
  encryptEphemeralChatMessage,
  encryptEphemeralChatMessageBySigningPubkey,
} from '../lib/tauri'
import { useAccount } from './AccountContext'
import { useIdentity } from './IdentityContext'
import {
  DEFAULT_MESSAGE_STORAGE_SETTINGS,
  getMessageStorageSettings,
  type MessageStorageSettings,
} from '../lib/messageSettings'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  getDownloadSettings,
  type DownloadSettings,
} from '../lib/downloadSettings'
import { addIceCandidate, createAnswer, createOffer, createPeerConnection, handleAnswer } from '../lib/webrtc'
import { confirm as confirmDialog } from '@tauri-apps/api/dialog'
import { listen } from '@tauri-apps/api/event'
import { getCurrent } from '@tauri-apps/api/window'

export interface EphemeralAttachmentMeta {
  attachment_id: string
  file_name: string
  extension: string
  size_bytes: number
  sha256: string
  spoiler?: boolean
  /** Optional aspect ratio from sender so shimmer/container can match on first paint. */
  aspect_ratio_w?: number
  aspect_ratio_h?: number
}

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
  delivery_status?: 'pending' | 'delivered'
  delivered_by?: string[]
}

interface SendEphemeralChatInput {
  serverId: string
  signingPubkey: string
  chatId: string
  fromUserId: string
  text: string
}

interface SendEphemeralAttachmentInput {
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
}

interface IncomingEphemeralChatDetail {
  signing_pubkey: string
  chat_id: string
  message_id: string
  from_user_id: string
  encrypted_payload: string
  sent_at: string
}

interface IncomingEphemeralReceiptDetail {
  signing_pubkey: string
  chat_id: string
  message_id: string
  from_user_id: string
  receipt_type: 'delivered'
  sent_at: string
}

type EphemeralPayload =
  | { kind: 'text'; text: string; sent_at: string }
  | { kind: 'attachment'; attachment: EphemeralAttachmentMeta; sent_at: string }
  | { kind: 'mixed'; attachments: EphemeralAttachmentMeta[]; text?: string; sent_at: string }
  | { kind: 'attachment_reshared'; attachment_id: string; sent_at: string }

type QueuedDownloadRequest = {
  request_id: string
  message_id: string
  attachment_id: string
  from_user_id: string
  to_user_id: string
  file_name: string
  size_bytes?: number
}

type UploadSubscriber = {
  requestId: string
  toUserId: string
  dc: RTCDataChannel
  ready: boolean
  flowPaused: boolean
  nextOffset: number
  done: boolean
}

type UploadSession = {
  attachmentId: string
  fileName: string
  sha256: string
  totalBytes: number
  chunkSize: number
  cache: Map<number, Uint8Array>
  cacheBytes: number
  nextReadOffset: number
  eof: boolean
  running: boolean
  subscribers: Map<string, UploadSubscriber>
}

const MAX_PARALLEL_DOWNLOADS = 2
const MAX_ACTIVE_UPLOAD_SESSIONS = 2
const MAX_UPLOAD_CACHE_BYTES = 2 * 1024 * 1024
const UPLOAD_SESSION_IDLE_TIMEOUT_MS = 30_000
const UPLOAD_MAX_BUFFER = 8 * 1024 * 1024
const UPLOAD_LOW_WATER = 2 * 1024 * 1024
const MAX_PENDING_BYTES = 1024 * 1024
const RESUME_PENDING_BYTES = 512 * 1024

interface EphemeralMessagesContextType {
  getMessages: (signingPubkey: string, chatId: string) => EphemeralChatMessage[]
  openServerChat: (serverId: string, signingPubkey: string, chatId: string) => void
  getUnreadCount: (serverId: string) => number
  sendMessage: (input: SendEphemeralChatInput) => Promise<void>
  sendAttachmentMessage: (input: SendEphemeralAttachmentInput) => Promise<void>
  sendMixedMessage: (input: SendMixedMessageInput) => Promise<void>
  requestAttachmentDownload: (msg: EphemeralChatMessage, attachment?: EphemeralAttachmentMeta) => Promise<void>
  attachmentTransfers: AttachmentTransferState[]
  transferHistory: TransferHistoryEntry[]
  hasAccessibleCompletedDownload: (attachmentId: string | null | undefined) => boolean
  refreshTransferHistoryAccessibility: () => Promise<void>
  removeTransferHistoryEntry: (requestId: string) => void
  cancelTransferRequest: (requestId: string) => void
  sharedAttachments: SharedAttachmentItem[]
  refreshSharedAttachments: (attachmentIdJustShared?: string) => Promise<void>
  unshareAttachmentById: (attachmentId: string) => Promise<void>
  notifyAttachmentReshared: (signingPubkey: string, chatId: string, attachmentId: string) => Promise<void>
  /** Per-server exposure: which content (by sha256) is shared in which server. */
  markSharedInServer: (serverSigningPubkey: string, sha256: string) => void
  isSharedInServer: (serverSigningPubkey: string, sha256: string) => boolean
  getServersForSha: (sha256: string) => string[]
  /** Remove this content from one server's "shared" list (upload button reappears in that server). Does not unshare from backend. */
  unshareFromServer: (serverSigningPubkey: string, sha256: string) => void
  /** Path for content we already have (e.g. from a previous download with same sha256). Used to avoid re-downloading. */
  getCachedPathForSha: (sha256: string | undefined) => string | null
}

export interface AttachmentTransferState {
  request_id: string
  message_id: string
  attachment_id: string
  from_user_id: string
  to_user_id: string
  file_name: string
  direction: 'upload' | 'download'
  status: 'queued' | 'requesting' | 'connecting' | 'transferring' | 'completed' | 'rejected' | 'failed'
  progress: number
  debug_kbps?: number
  debug_buffered_bytes?: number
  debug_eta_seconds?: number
  saved_path?: string
  error?: string
  sha256?: string
}

export interface TransferHistoryEntry {
  request_id: string
  message_id: string
  attachment_id: string
  file_name: string
  size_bytes?: number
  from_user_id: string
  to_user_id: string
  direction: 'upload' | 'download'
  status: AttachmentTransferState['status']
  progress: number
  saved_path?: string
  is_inaccessible?: boolean
  created_at: string
  updated_at: string
}

const EphemeralMessagesContext = createContext<EphemeralMessagesContextType | null>(null)

type MessageBuckets = Record<string, EphemeralChatMessage[]>
const PERSIST_KEY_PREFIX = 'cordia:ephemeral-bucket'
const TRANSFER_HISTORY_KEY_PREFIX = 'cordia:attachment-transfer-history'
const UNREAD_STATE_KEY_PREFIX = 'cordia:ephemeral-unread-state'
const SERVER_SHARED_SHA_KEY_PREFIX = 'cordia:server-shared-sha'
const CONTENT_CACHE_SHA_KEY_PREFIX = 'cordia:content-cache-sha'

type UnreadState = {
  unread_count_by_server: Record<string, number>
  last_seen_at_by_server: Record<string, string>
}

function bucketKey(signingPubkey: string, chatId: string): string {
  return `${signingPubkey}::${chatId}`
}

function appendMessage(
  prev: MessageBuckets,
  signingPubkey: string,
  chatId: string,
  msg: EphemeralChatMessage
): MessageBuckets {
  const key = bucketKey(signingPubkey, chatId)
  const existing = prev[key] ?? []
  return { ...prev, [key]: [...existing, msg] }
}

function persistKeyForAccount(accountId: string | null): string {
  return accountId ? `${PERSIST_KEY_PREFIX}:${accountId}` : PERSIST_KEY_PREFIX
}

function persistBucketKeyForAccount(accountId: string | null, bucket: string): string {
  return `${persistKeyForAccount(accountId)}:${bucket}`
}

function transferHistoryKeyForAccount(accountId: string | null): string {
  return accountId ? `${TRANSFER_HISTORY_KEY_PREFIX}:${accountId}` : TRANSFER_HISTORY_KEY_PREFIX
}

function unreadStateKeyForAccount(accountId: string | null): string {
  return accountId ? `${UNREAD_STATE_KEY_PREFIX}:${accountId}` : UNREAD_STATE_KEY_PREFIX
}

function serverSharedShaKeyForAccount(accountId: string | null): string {
  return accountId ? `${SERVER_SHARED_SHA_KEY_PREFIX}:${accountId}` : SERVER_SHARED_SHA_KEY_PREFIX
}

function contentCacheShaKeyForAccount(accountId: string | null): string {
  return accountId ? `${CONTENT_CACHE_SHA_KEY_PREFIX}:${accountId}` : CONTENT_CACHE_SHA_KEY_PREFIX
}

function storageBytes(input: string): number {
  return new TextEncoder().encode(input).length
}

function pruneBuckets(
  buckets: MessageBuckets,
  settings: MessageStorageSettings,
  signingPubkey: string
): MessageBuckets {
  const serverEntries = Object.entries(buckets)
    .filter(([k]) => k.startsWith(`${signingPubkey}::`))
    .flatMap(([k, arr]) => arr.map((m) => ({ k, m })))
  serverEntries.sort((a, b) => Date.parse(a.m.sent_at) - Date.parse(b.m.sent_at))

  const maxBytes = settings.max_storage_mb * 1024 * 1024
  let kept = serverEntries
  let candidate: MessageBuckets = {}
  for (const { k, m } of kept) {
    if (!candidate[k]) candidate[k] = []
    candidate[k].push(m)
  }
  let serialized = JSON.stringify(candidate)
  if (storageBytes(serialized) > maxBytes) {
    candidate = {}
    while (kept.length > 0) {
      kept = kept.slice(1)
      const next: MessageBuckets = {}
      for (const { k, m } of kept) {
        if (!next[k]) next[k] = []
        next[k].push(m)
      }
      serialized = JSON.stringify(next)
      if (storageBytes(serialized) <= maxBytes) {
        candidate = next
        break
      }
    }
  }

  const merged: MessageBuckets = {}
  for (const [key, list] of Object.entries(buckets)) {
    if (!key.startsWith(`${signingPubkey}::`)) {
      merged[key] = list
    }
  }
  for (const [key, list] of Object.entries(candidate)) {
    merged[key] = list
  }
  return merged
}

export function EphemeralMessagesProvider({ children }: { children: ReactNode }) {
  const { currentAccountId } = useAccount()
  const { identity } = useIdentity()
  const [settingsBySigningPubkey, setSettingsBySigningPubkey] = useState<Record<string, MessageStorageSettings>>({})
  const [downloadSettings, setDownloadSettingsState] = useState<DownloadSettings>(DEFAULT_DOWNLOAD_SETTINGS)
  const [messagesByBucket, setMessagesByBucket] = useState<MessageBuckets>({})
  const [unreadState, setUnreadState] = useState<UnreadState>({
    unread_count_by_server: {},
    last_seen_at_by_server: {},
  })
  const [attachmentTransfers, setAttachmentTransfers] = useState<AttachmentTransferState[]>([])
  const [transferHistory, setTransferHistory] = useState<TransferHistoryEntry[]>([])
  const [sharedAttachments, setSharedAttachments] = useState<SharedAttachmentItem[]>([])
  /** Per server (signing_pubkey) -> set of sha256 that user has shared in that server. Persisted. */
  const [serverSharedSha, setServerSharedSha] = useState<Record<string, string[]>>({})
  /** Content cache: sha256 -> local path (from completed downloads). Avoids re-downloading same file. Persisted. */
  const [contentCacheBySha, setContentCacheBySha] = useState<Record<string, string>>({})
  const [hydrated, setHydrated] = useState(false)
  const transferPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const transferDataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map())
  const uploadSessionsRef = useRef<Map<string, UploadSession>>(new Map())
  const activeUploadSessionIdsRef = useRef<Set<string>>(new Set())
  const pendingUploadSessionIdsRef = useRef<string[]>([])
  const transferBuffersRef = useRef<Map<string, Uint8Array[]>>(new Map())
  const transferExpectedSizeRef = useRef<Map<string, number>>(new Map())
  const downloadStreamStateRef = useRef<
    Map<
      string,
      {
        expected: number
        receivedBytes: number
        writtenBytes: number
        pending: Uint8Array[]
        pendingBytes: number
        started: boolean
        doneReceived: boolean
        writerRunning: boolean
        flowPauseSent: boolean
      }
    >
  >(new Map())
  const attachmentTransfersRef = useRef<AttachmentTransferState[]>([])
  const messagesByBucketRef = useRef<MessageBuckets>({})
  const sharedAttachmentsRef = useRef<SharedAttachmentItem[]>([])
  const transferHistoryRef = useRef<TransferHistoryEntry[]>([])
  const loadedBucketsRef = useRef<Set<string>>(new Set())
  const activeSigningPubkeyRef = useRef<string | null>(null)
  const receiptSentRef = useRef<Set<string>>(new Set())
  const signingToServerIdRef = useRef<Map<string, string>>(new Map())
  const previousAccountIdRef = useRef<string | null>(null)
  const progressTickRef = useRef<Map<string, number>>(new Map())
  const debugStatsRef = useRef<Map<string, { at: number; bytes: number }>>(new Map())
  const debugSpeedEmaRef = useRef<Map<string, number>>(new Map())
  const debugEtaEmaRef = useRef<Map<string, number>>(new Map())
  const debugTickRef = useRef<Map<string, number>>(new Map())
  const downloadWriterWakeRef = useRef<Map<string, () => void>>(new Map())
  const downloadQueueRef = useRef<QueuedDownloadRequest[]>([])

  const messageSettingsFor = (signingPubkey: string): MessageStorageSettings =>
    settingsBySigningPubkey[signingPubkey] ?? DEFAULT_MESSAGE_STORAGE_SETTINGS

  const ensureSettingsLoaded = (signingPubkey: string): MessageStorageSettings => {
    const existing = settingsBySigningPubkey[signingPubkey]
    if (existing) return existing
    const loaded = getMessageStorageSettings(currentAccountId, signingPubkey)
    setSettingsBySigningPubkey((prev) => ({ ...prev, [signingPubkey]: loaded }))
    return loaded
  }

  const persistBucketIfNeeded = (
    accountId: string | null,
    signingPubkey: string,
    chatId: string,
    list: EphemeralChatMessage[]
  ) => {
    const settings = ensureSettingsLoaded(signingPubkey)
    const bucket = bucketKey(signingPubkey, chatId)
    const key = persistBucketKeyForAccount(accountId, bucket)
    try {
      if (settings.mode === 'ephemeral' || list.length === 0) {
        window.localStorage.removeItem(key)
      } else {
        window.localStorage.setItem(key, JSON.stringify(list))
      }
    } catch {
      // ignore local storage write failures
    }
  }

  const appendAndPruneBySigning = (
    prev: MessageBuckets,
    signingPubkey: string,
    chatId: string,
    msg: EphemeralChatMessage
  ) => {
    const next = appendMessage(prev, signingPubkey, chatId, msg)
    return pruneBuckets(next, ensureSettingsLoaded(signingPubkey), signingPubkey)
  }

  const ensureBucketLoaded = (signingPubkey: string, chatId: string) => {
    if (!currentAccountId || !signingPubkey || !chatId) return
    const bucket = bucketKey(signingPubkey, chatId)
    if (loadedBucketsRef.current.has(bucket)) return
    loadedBucketsRef.current.add(bucket)
    const key = persistBucketKeyForAccount(currentAccountId, bucket)
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return
      const parsed = JSON.parse(raw) as EphemeralChatMessage[]
      if (!Array.isArray(parsed) || parsed.length === 0) return
      const loaded = parsed
      setMessagesByBucket((prev) => {
        if ((prev[bucket] ?? []).length > 0) return prev
      const merged = { ...prev, [bucket]: loaded }
      return pruneBuckets(merged, ensureSettingsLoaded(signingPubkey), signingPubkey)
      })
    } catch {
      // ignore malformed local storage values
    }
  }

  const refreshSigningToServerMap = async () => {
    try {
      const servers = await listServers()
      signingToServerIdRef.current = new Map(servers.map((s) => [s.signing_pubkey, s.id]))
    } catch {
      signingToServerIdRef.current = new Map()
    }
  }

  const incrementUnreadForSigning = (signingPubkey: string) => {
    const serverId = signingToServerIdRef.current.get(signingPubkey)
    if (!serverId) return
    setUnreadState((prev) => ({
      unread_count_by_server: {
        ...prev.unread_count_by_server,
        [serverId]: (prev.unread_count_by_server[serverId] ?? 0) + 1,
      },
      last_seen_at_by_server: { ...prev.last_seen_at_by_server },
    }))
  }

  const markServerSeenBySigning = (signingPubkey: string) => {
    const serverId = signingToServerIdRef.current.get(signingPubkey)
    if (!serverId) return
    const seenAt = new Date().toISOString()
    setUnreadState((prev) => ({
      unread_count_by_server: { ...prev.unread_count_by_server, [serverId]: 0 },
      last_seen_at_by_server: { ...prev.last_seen_at_by_server, [serverId]: seenAt },
    }))
  }

  const upsertTransfer = (requestId: string, updater: (prev?: AttachmentTransferState) => AttachmentTransferState) => {
    setAttachmentTransfers((prev) => {
      const idx = prev.findIndex((t) => t.request_id === requestId)
      if (idx < 0) return [...prev, updater(undefined)]
      const next = [...prev]
      next[idx] = updater(prev[idx])
      return next
    })
  }

  const updateTransferProgress = (requestId: string, progress: number) => {
    const now = Date.now()
    const last = progressTickRef.current.get(requestId) ?? 0
    const clamped = Math.max(0, Math.min(1, progress))
    // Throttle progress writes to keep UI responsive during large transfers.
    if (clamped < 1 && now - last < 120) return
    progressTickRef.current.set(requestId, now)
    upsertTransfer(requestId, (prev) => ({
      ...(prev as AttachmentTransferState),
      progress: clamped,
    }))
  }

  const dispatchDownloadRequest = (peerUserId: string, requestId: string, attachmentId: string) => {
    window.dispatchEvent(
      new CustomEvent('cordia:send-attachment-transfer-request', {
        detail: {
          to_user_id: peerUserId,
          request_id: requestId,
          attachment_id: attachmentId,
        },
      })
    )
  }

  const activeDownloadCount = (excludeRequestId?: string) =>
    attachmentTransfersRef.current.filter(
      (t) =>
        t.direction === 'download' &&
        t.request_id !== excludeRequestId &&
        (t.status === 'requesting' || t.status === 'connecting' || t.status === 'transferring')
    ).length

  const enqueueDownload = (entry: QueuedDownloadRequest) => {
    const q = downloadQueueRef.current
    const isSmall = (entry.size_bytes ?? Number.MAX_SAFE_INTEGER) <= 10 * 1024 * 1024
    if (isSmall) q.unshift(entry)
    else q.push(entry)
    downloadQueueRef.current = q
  }

  const removeQueuedDownloadRequest = (requestId: string) => {
    downloadQueueRef.current = downloadQueueRef.current.filter((x) => x.request_id !== requestId)
  }

  const tryStartNextQueuedDownload = () => {
    const slots = MAX_PARALLEL_DOWNLOADS - activeDownloadCount()
    if (slots <= 0) return
    const q = downloadQueueRef.current
    if (q.length === 0) return
    for (let i = 0; i < slots && q.length > 0; i += 1) {
      const nextIdx = q.reduce((best, item, idx) => {
        const cur = item.size_bytes ?? Number.MAX_SAFE_INTEGER
        const bestSize = q[best].size_bytes ?? Number.MAX_SAFE_INTEGER
        return cur < bestSize ? idx : best
      }, 0)
      const [next] = q.splice(nextIdx, 1)
      const now = new Date().toISOString()
      upsertTransfer(next.request_id, (prev) => ({
        ...(prev as AttachmentTransferState),
        status: 'requesting',
        progress: 0,
        error: undefined,
      }))
      upsertHistory(next.request_id, (prev) => ({
        ...(prev as TransferHistoryEntry),
        request_id: next.request_id,
        message_id: next.message_id,
        attachment_id: next.attachment_id,
        file_name: next.file_name,
        size_bytes: next.size_bytes ?? prev?.size_bytes,
        from_user_id: next.from_user_id,
        to_user_id: next.to_user_id,
        direction: 'download',
        status: 'requesting',
        progress: 0,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      }))
      dispatchDownloadRequest(next.from_user_id, next.request_id, next.attachment_id)
    }
    downloadQueueRef.current = q
  }

  const updateTransferDebug = (
    requestId: string,
    totalBytes: number,
    bufferedBytes?: number,
    totalExpectedBytes?: number
  ) => {
    const now = Date.now()
    const prev = debugStatsRef.current.get(requestId)
    const lastTick = debugTickRef.current.get(requestId) ?? 0
    const isDownload = bufferedBytes === undefined
    const speedAlpha = isDownload ? 0.15 : 0.25
    const etaBeta = 0.2
    const maxEtaUpwardRatio = 1.15

    let speedEma = debugSpeedEmaRef.current.get(requestId) ?? null
    let etaEma = debugEtaEmaRef.current.get(requestId) ?? null

    if (prev && now > prev.at) {
      const dtSec = (now - prev.at) / 1000
      const db = totalBytes - prev.bytes
      if (dtSec > 0 && db >= 0) {
        const instantKbps = db / dtSec / 1024
        if (instantKbps > 0) {
          speedEma =
            speedEma == null ? instantKbps : speedEma * (1 - speedAlpha) + instantKbps * speedAlpha
          debugSpeedEmaRef.current.set(requestId, speedEma)
        }
      }
    }
    debugStatsRef.current.set(requestId, { at: now, bytes: totalBytes })

    let etaSeconds: number | undefined
    if (totalExpectedBytes != null && totalExpectedBytes > 0) {
      if (totalBytes >= totalExpectedBytes) {
        etaEma = 0
        etaSeconds = 0
      } else if ((speedEma ?? 0) > 0) {
        const remaining = totalExpectedBytes - totalBytes
        let effectiveRemaining = remaining
        if (isDownload && speedEma != null) {
          const inFlightEst = Math.min(remaining, speedEma * 1024 * 0.3)
          effectiveRemaining = Math.max(0, remaining - inFlightEst)
        }
        const instEta = effectiveRemaining / ((speedEma as number) * 1024)
        const rawEtaEma = etaEma == null ? instEta : etaEma * (1 - etaBeta) + instEta * etaBeta
        const prevEta = etaEma ?? instEta
        if (instEta <= prevEta) {
          etaEma = rawEtaEma
        } else {
          etaEma = Math.min(rawEtaEma, prevEta * maxEtaUpwardRatio)
        }
        debugEtaEmaRef.current.set(requestId, etaEma)
        etaSeconds = etaEma
      }
    }

    if (now - lastTick < 150 && bufferedBytes === undefined) return
    debugTickRef.current.set(requestId, now)

    const prevState = attachmentTransfersRef.current.find((t) => t.request_id === requestId)
    const prevDisplayedEta = prevState?.debug_eta_seconds
    let finalEta = etaSeconds ?? prevDisplayedEta
    if (finalEta != null && prevDisplayedEta != null && finalEta > prevDisplayedEta) {
      const delta = finalEta - prevDisplayedEta
      if (delta < 1 && (prevDisplayedEta <= 0 || delta / prevDisplayedEta < 0.05)) {
        finalEta = prevDisplayedEta
      }
    }

    upsertTransfer(requestId, (state) => ({
      ...(state as AttachmentTransferState),
      debug_kbps: speedEma ?? state?.debug_kbps,
      debug_buffered_bytes: bufferedBytes ?? state?.debug_buffered_bytes,
      debug_eta_seconds: finalEta ?? state?.debug_eta_seconds,
    }))
  }

  const startDownloadWriter = (requestId: string) => {
    const st = downloadStreamStateRef.current.get(requestId)
    if (!st || !st.started || st.writerRunning) return
    st.writerRunning = true
    downloadStreamStateRef.current.set(requestId, st)
    const run = async () => {
      const targetBatchBytes = 512 * 1024
      while (true) {
        const cur = downloadStreamStateRef.current.get(requestId)
        if (!cur || !cur.started) return
        if (cur.flowPauseSent && cur.pendingBytes <= RESUME_PENDING_BYTES) {
          const dc = transferDataChannelsRef.current.get(requestId)
          if (dc && dc.readyState === 'open') {
            try {
              dc.send(JSON.stringify({ type: 'flow_resume' }))
              cur.flowPauseSent = false
              downloadStreamStateRef.current.set(requestId, cur)
            } catch {
              // ignore transient channel send failures; transfer error path handles hard failures
            }
          }
        }
        if (cur.pendingBytes <= 0) {
          if (cur.doneReceived) break
          await new Promise<void>((resolve) => {
            downloadWriterWakeRef.current.set(requestId, resolve)
          })
          continue
        }
        const outSize = Math.min(targetBatchBytes, cur.pendingBytes)
        const out = new Uint8Array(outSize)
        let remaining = outSize
        let writeOff = 0
        while (remaining > 0 && cur.pending.length > 0) {
          const first = cur.pending[0]
          if (first.byteLength <= remaining) {
            out.set(first, writeOff)
            writeOff += first.byteLength
            remaining -= first.byteLength
            cur.pending.shift()
          } else {
            out.set(first.subarray(0, remaining), writeOff)
            cur.pending[0] = first.subarray(remaining)
            writeOff += remaining
            remaining = 0
          }
        }
        cur.pendingBytes -= outSize
        downloadStreamStateRef.current.set(requestId, cur)
        try {
          await writeDownloadStreamChunk(requestId, out)
          const afterWrite = downloadStreamStateRef.current.get(requestId)
          if (!afterWrite || !afterWrite.started) return
          afterWrite.writtenBytes += outSize
          downloadStreamStateRef.current.set(requestId, afterWrite)
          updateTransferProgress(
            requestId,
            afterWrite.expected > 0 ? Math.min(1, afterWrite.writtenBytes / afterWrite.expected) : 0
          )
          updateTransferDebug(requestId, afterWrite.receivedBytes, undefined, afterWrite.expected)
        } catch {
          // If transfer was cancelled/cleaned, avoid resurrecting failure state.
          if (!downloadStreamStateRef.current.has(requestId)) return
          upsertTransfer(requestId, (prev) => ({
            ...(prev as AttachmentTransferState),
            status: 'failed',
            error: 'Failed writing download chunk',
          }))
          cleanupTransferPeer(requestId)
          tryStartNextQueuedDownload()
          return
        }
      }
      try {
        const savePath = await finishDownloadStream(requestId)
        if (!downloadStreamStateRef.current.has(requestId)) return
        const sha = attachmentTransfersRef.current.find((t) => t.request_id === requestId)?.sha256
        upsertTransfer(requestId, (prev) => ({
          ...(prev as AttachmentTransferState),
          status: 'completed',
          progress: 1,
          saved_path: savePath,
        }))
        if (sha) setContentCacheBySha((c) => ({ ...c, [sha]: savePath }))
        cleanupTransferPeer(requestId)
        tryStartNextQueuedDownload()
      } catch {
        if (!downloadStreamStateRef.current.has(requestId)) return
        upsertTransfer(requestId, (prev) => ({
          ...(prev as AttachmentTransferState),
          status: 'failed',
          error: 'Failed finalizing download file',
        }))
        cleanupTransferPeer(requestId)
        tryStartNextQueuedDownload()
      }
    }
    run().finally(() => {
      downloadWriterWakeRef.current.delete(requestId)
      const latest = downloadStreamStateRef.current.get(requestId)
      if (!latest) return
      latest.writerRunning = false
      downloadStreamStateRef.current.set(requestId, latest)
    })
  }

  const getOrCreateUploadSession = (
    attachmentId: string,
    attachment: { file_name: string; sha256: string; size_bytes: number }
  ): UploadSession => {
    const existing = uploadSessionsRef.current.get(attachmentId)
    if (existing) return existing
    const created: UploadSession = {
      attachmentId,
      fileName: attachment.file_name,
      sha256: attachment.sha256,
      totalBytes: attachment.size_bytes,
      chunkSize: 64 * 1024,
      cache: new Map<number, Uint8Array>(),
      cacheBytes: 0,
      nextReadOffset: 0,
      eof: false,
      running: false,
      subscribers: new Map<string, UploadSubscriber>(),
    }
    uploadSessionsRef.current.set(attachmentId, created)
    return created
  }

  const hasRunnableUploadSubscriber = (session: UploadSession) =>
    Array.from(session.subscribers.values()).some(
      (s) => !s.done && s.ready && s.dc.readyState === 'open'
    )

  const enqueueUploadSession = (attachmentId: string) => {
    if (pendingUploadSessionIdsRef.current.includes(attachmentId)) return
    pendingUploadSessionIdsRef.current.push(attachmentId)
  }

  const dequeueUploadSession = (attachmentId: string) => {
    pendingUploadSessionIdsRef.current = pendingUploadSessionIdsRef.current.filter((id) => id !== attachmentId)
  }

  const removeUploadSubscriber = (session: UploadSession, requestId: string) => {
    session.subscribers.delete(requestId)
    if (session.subscribers.size === 0) {
      uploadSessionsRef.current.delete(session.attachmentId)
      dequeueUploadSession(session.attachmentId)
      activeUploadSessionIdsRef.current.delete(session.attachmentId)
    }
  }

  const failUploadSubscriber = (session: UploadSession, requestId: string, error: string) => {
    const current = attachmentTransfersRef.current.find((t) => t.request_id === requestId)
    const alreadyTerminal =
      current?.status === 'failed' || current?.status === 'completed' || current?.status === 'rejected'
    if (!alreadyTerminal) {
      upsertTransfer(requestId, (prev) => ({
        ...(prev as AttachmentTransferState),
        status: 'failed',
        error,
      }))
    }
    cleanupTransferPeer(requestId)
    removeUploadSubscriber(session, requestId)
  }

  const startUploadSessionPump = (session: UploadSession) => {
    const schedule = () => {
      if (session.running) return
      if (!hasRunnableUploadSubscriber(session)) return
      if (!activeUploadSessionIdsRef.current.has(session.attachmentId)) {
        enqueueUploadSession(session.attachmentId)
      }
      while (
        activeUploadSessionIdsRef.current.size < MAX_ACTIVE_UPLOAD_SESSIONS &&
        pendingUploadSessionIdsRef.current.length > 0
      ) {
        const nextId = pendingUploadSessionIdsRef.current.shift()!
        const nextSession = uploadSessionsRef.current.get(nextId)
        if (!nextSession || nextSession.running || !hasRunnableUploadSubscriber(nextSession)) continue
        activeUploadSessionIdsRef.current.add(nextId)
        runSession(nextSession)
      }
    }

    const runSession = (runForSession: UploadSession) => {
      if (runForSession.running) return
      runForSession.running = true
        const run = async () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
          const MAX_BUFFER = UPLOAD_MAX_BUFFER
        let lastProgressAt = Date.now()
        while (runForSession.subscribers.size > 0) {
          let progressed = false
          // Read next block if any subscriber needs data beyond what we cached.
          const needRead = Array.from(runForSession.subscribers.values()).some(
            (s) => !s.done && s.ready && s.nextOffset >= runForSession.nextReadOffset && !runForSession.eof
          )
          if (needRead && runForSession.cacheBytes < MAX_UPLOAD_CACHE_BYTES) {
            const next = Math.min(runForSession.totalBytes, runForSession.nextReadOffset + runForSession.chunkSize)
            try {
              const block = await readAttachmentChunk(runForSession.attachmentId, runForSession.nextReadOffset, next - runForSession.nextReadOffset)
              if (block.byteLength === 0) {
                runForSession.eof = true
              } else {
                runForSession.cache.set(runForSession.nextReadOffset, block)
                runForSession.cacheBytes += block.byteLength
                runForSession.nextReadOffset += block.byteLength
                progressed = true
              }
            } catch {
              for (const sub of Array.from(runForSession.subscribers.values())) {
                failUploadSubscriber(runForSession, sub.requestId, 'Failed reading attachment chunk')
              }
              runForSession.cache.clear()
              runForSession.cacheBytes = 0
              return
            }
          }

          for (const sub of runForSession.subscribers.values()) {
            if (sub.done || !sub.ready || sub.dc.readyState !== 'open') continue
            while (!sub.flowPaused && sub.dc.readyState === 'open') {
              if (sub.dc.bufferedAmount > MAX_BUFFER) break
              const chunk = runForSession.cache.get(sub.nextOffset)
              if (!chunk) break
              const sendChunk = new Uint8Array(chunk.byteLength)
              sendChunk.set(chunk)
              sub.dc.send(sendChunk)
              sub.nextOffset += chunk.byteLength
              progressed = true
              const p = runForSession.totalBytes > 0 ? Math.min(1, sub.nextOffset / runForSession.totalBytes) : 1
              updateTransferProgress(sub.requestId, p)
              updateTransferDebug(sub.requestId, sub.nextOffset, sub.dc.bufferedAmount, runForSession.totalBytes)
            }
            if (!sub.done && runForSession.eof && sub.nextOffset >= runForSession.totalBytes && sub.dc.readyState === 'open') {
              sub.dc.send(JSON.stringify({ type: 'done' }))
              sub.done = true
              upsertTransfer(sub.requestId, (prev) => ({
                ...(prev as AttachmentTransferState),
                status: 'completed',
                progress: 1,
              }))
              cleanupTransferPeer(sub.requestId)
              removeUploadSubscriber(runForSession, sub.requestId)
              progressed = true
            }
          }

          // Evict cache blocks all active subscribers have passed.
          const minOffset = Array.from(runForSession.subscribers.values())
            .filter((s) => !s.done)
            .reduce((min, s) => Math.min(min, s.nextOffset), Number.POSITIVE_INFINITY)
          if (Number.isFinite(minOffset)) {
            for (const offset of runForSession.cache.keys()) {
              const chunk = runForSession.cache.get(offset)
              if (!chunk) continue
              if (offset + chunk.byteLength <= minOffset) {
                runForSession.cache.delete(offset)
                runForSession.cacheBytes = Math.max(0, runForSession.cacheBytes - chunk.byteLength)
              }
            }
          } else if (runForSession.subscribers.size === 0) {
            runForSession.cache.clear()
            runForSession.cacheBytes = 0
            break
          }

          if (progressed) {
            lastProgressAt = Date.now()
          } else {
            if (Date.now() - lastProgressAt > UPLOAD_SESSION_IDLE_TIMEOUT_MS) {
              for (const sub of Array.from(runForSession.subscribers.values())) {
                failUploadSubscriber(runForSession, sub.requestId, 'Upload session timed out')
              }
              runForSession.cache.clear()
              runForSession.cacheBytes = 0
              return
            }
            await sleep(4)
          }
        }
      }
      run().finally(() => {
        runForSession.running = false
        activeUploadSessionIdsRef.current.delete(runForSession.attachmentId)
        if (runForSession.subscribers.size === 0) {
          uploadSessionsRef.current.delete(runForSession.attachmentId)
          dequeueUploadSession(runForSession.attachmentId)
        }
        schedule()
      })
    }

    schedule()
  }

  const removeTransferHistoryEntry = (requestId: string) => {
    if (!requestId) return
    setTransferHistory((prev) => prev.filter((h) => h.request_id !== requestId))
  }

  const cancelTransferRequest = (requestId: string) => {
    if (!requestId) return
    const transfer = attachmentTransfersRef.current.find((t) => t.request_id === requestId)
    removeQueuedDownloadRequest(requestId)
    cleanupTransferPeer(requestId)
    setAttachmentTransfers((prev) => prev.filter((t) => t.request_id !== requestId))
    setTransferHistory((prev) => prev.filter((h) => h.request_id !== requestId))
    if (
      transfer &&
      transfer.direction === 'download' &&
      (transfer.status === 'requesting' || transfer.status === 'connecting' || transfer.status === 'transferring')
    ) {
      setTimeout(() => tryStartNextQueuedDownload(), 0)
    }
  }

  const hasAccessibleCompletedDownload = (attachmentId: string | null | undefined): boolean => {
    if (!attachmentId) return false
    return transferHistoryRef.current.some(
      (h) =>
        h.direction === 'download' &&
        h.attachment_id === attachmentId &&
        h.status === 'completed' &&
        Boolean(h.saved_path) &&
        h.is_inaccessible !== true
    )
  }

  const refreshTransferHistoryAccessibility: EphemeralMessagesContextType['refreshTransferHistoryAccessibility'] = async () => {
    const candidates = transferHistoryRef.current.filter(
      (h) => h.direction === 'download' && h.status === 'completed' && Boolean(h.saved_path)
    )
    if (candidates.length === 0) return

    const checks = await Promise.all(
      candidates.map(async (h) => {
        try {
          const exists = await pathExists(h.saved_path!)
          return { requestId: h.request_id, inaccessible: !exists }
        } catch {
          return { requestId: h.request_id, inaccessible: true }
        }
      })
    )
    const nextMap = new Map(checks.map((c) => [c.requestId, c.inaccessible]))
    setTransferHistory((prev) =>
      prev.map((h) => {
        const nextInaccessible = nextMap.get(h.request_id)
        if (nextInaccessible === undefined) return h
        if ((h.is_inaccessible ?? false) === nextInaccessible) return h
        return { ...h, is_inaccessible: nextInaccessible }
      })
    )
  }

  const cleanupTransferPeer = (requestId: string) => {
    const pc = transferPeersRef.current.get(requestId)
    if (pc) {
      try { pc.close() } catch {}
      transferPeersRef.current.delete(requestId)
    }
    transferDataChannelsRef.current.delete(requestId)
    transferBuffersRef.current.delete(requestId)
    transferExpectedSizeRef.current.delete(requestId)
    const wake = downloadWriterWakeRef.current.get(requestId)
    if (wake) {
      downloadWriterWakeRef.current.delete(requestId)
      wake()
    }
    const st = downloadStreamStateRef.current.get(requestId)
    if (st?.started) {
      cancelDownloadStream(requestId).catch(() => {})
    }
    downloadStreamStateRef.current.delete(requestId)
    progressTickRef.current.delete(requestId)
    debugStatsRef.current.delete(requestId)
    debugSpeedEmaRef.current.delete(requestId)
    debugEtaEmaRef.current.delete(requestId)
    debugTickRef.current.delete(requestId)
    for (const session of uploadSessionsRef.current.values()) {
      if (!session.subscribers.has(requestId)) continue
      session.subscribers.delete(requestId)
      if (session.subscribers.size === 0) {
        uploadSessionsRef.current.delete(session.attachmentId)
        dequeueUploadSession(session.attachmentId)
        activeUploadSessionIdsRef.current.delete(session.attachmentId)
      }
    }
  }

  const upsertHistory = (
    requestId: string,
    updater: (prev?: TransferHistoryEntry) => TransferHistoryEntry | null
  ) => {
    setTransferHistory((prev) => {
      const idx = prev.findIndex((h) => h.request_id === requestId)
      if (idx < 0) {
        const created = updater(undefined)
        if (!created) return prev
        return [created, ...prev].slice(0, 300)
      }
      const updated = updater(prev[idx])
      if (!updated) {
        const next = [...prev]
        next.splice(idx, 1)
        return next
      }
      const next = [...prev]
      next[idx] = updated
      return next
    })
  }

  useEffect(() => {
    attachmentTransfersRef.current = attachmentTransfers
  }, [attachmentTransfers])

  useEffect(() => {
    messagesByBucketRef.current = messagesByBucket
  }, [messagesByBucket])

  useEffect(() => {
    transferHistoryRef.current = transferHistory
  }, [transferHistory])

  useEffect(() => {
    sharedAttachmentsRef.current = sharedAttachments
  }, [sharedAttachments])

  useEffect(() => {
    const now = new Date().toISOString()
    for (const t of attachmentTransfers) {
      upsertHistory(t.request_id, (prev) => {
        if (!prev && (t.status === 'completed' || t.status === 'failed' || t.status === 'rejected')) {
          return null
        }
        return {
        request_id: t.request_id,
        message_id: t.message_id || prev?.message_id || '',
        attachment_id: t.attachment_id,
        file_name: t.file_name || prev?.file_name || 'attachment.bin',
        size_bytes: prev?.size_bytes,
        from_user_id: t.from_user_id || prev?.from_user_id || '',
        to_user_id: t.to_user_id || prev?.to_user_id || '',
        direction: t.direction || prev?.direction || 'download',
        status: t.status,
        progress: t.progress,
        saved_path: t.saved_path ?? prev?.saved_path,
        is_inaccessible: prev?.is_inaccessible,
        created_at: prev?.created_at || now,
        updated_at: now,
        }
      })
    }
  }, [attachmentTransfers])

  // Reset account-scoped state and load lightweight metadata only.
  useEffect(() => {
    setHydrated(false)
    downloadQueueRef.current = []
    downloadWriterWakeRef.current.clear()
    uploadSessionsRef.current.clear()
    activeUploadSessionIdsRef.current.clear()
    pendingUploadSessionIdsRef.current = []
    loadedBucketsRef.current.clear()
    setSettingsBySigningPubkey({})
    setDownloadSettingsState(getDownloadSettings(currentAccountId))

    if (!currentAccountId) {
      setMessagesByBucket({})
      setUnreadState({ unread_count_by_server: {}, last_seen_at_by_server: {} })
      setTransferHistory([])
      setSharedAttachments([])
      setServerSharedSha({})
      setContentCacheBySha({})
      setHydrated(true)
      return
    }

    setMessagesByBucket({})
    refreshSigningToServerMap().catch(() => {})
    try {
      const rawUnread = window.localStorage.getItem(unreadStateKeyForAccount(currentAccountId))
      if (!rawUnread) {
        setUnreadState({ unread_count_by_server: {}, last_seen_at_by_server: {} })
      } else {
        const parsedUnread = JSON.parse(rawUnread) as UnreadState
        setUnreadState({
          unread_count_by_server: parsedUnread?.unread_count_by_server ?? {},
          last_seen_at_by_server: parsedUnread?.last_seen_at_by_server ?? {},
        })
      }
    } catch {
      setUnreadState({ unread_count_by_server: {}, last_seen_at_by_server: {} })
    }
    setHydrated(true)

    try {
      const raw = window.localStorage.getItem(transferHistoryKeyForAccount(currentAccountId))
      if (!raw) {
        setTransferHistory([])
      } else {
        const parsed = JSON.parse(raw) as TransferHistoryEntry[]
        const list = Array.isArray(parsed) ? parsed.slice(0, 300) : []
        // On launch/login, drop rejected download entries so "Removed" cards are retested (files may have been re-shared).
        const withoutRejectedDownloads = list.filter(
          (h) => !(h.direction === 'download' && h.status === 'rejected')
        )
        setTransferHistory(withoutRejectedDownloads)
      }
    } catch {
      setTransferHistory([])
    }

    try {
      const rawSha = window.localStorage.getItem(serverSharedShaKeyForAccount(currentAccountId))
      if (!rawSha) {
        setServerSharedSha({})
      } else {
        const parsed = JSON.parse(rawSha) as Record<string, string[]>
        setServerSharedSha(typeof parsed === 'object' && parsed !== null ? parsed : {})
      }
    } catch {
      setServerSharedSha({})
    }

    try {
      const rawCache = window.localStorage.getItem(contentCacheShaKeyForAccount(currentAccountId))
      if (!rawCache) {
        setContentCacheBySha({})
      } else {
        const parsed = JSON.parse(rawCache) as Record<string, string>
        setContentCacheBySha(typeof parsed === 'object' && parsed !== null ? parsed : {})
      }
    } catch {
      setContentCacheBySha({})
    }

    listSharedAttachments()
      .then((list) => setSharedAttachments(list))
      .catch(() => setSharedAttachments([]))
  }, [currentAccountId])

  // On logout, prune inaccessible entries from the previous account's persisted history.
  useEffect(() => {
    const prev = previousAccountIdRef.current
    if (!currentAccountId && prev) {
      try {
        const key = transferHistoryKeyForAccount(prev)
        const raw = window.localStorage.getItem(key)
        if (raw) {
          const parsed = JSON.parse(raw) as TransferHistoryEntry[]
          const pruned = (Array.isArray(parsed) ? parsed : []).filter((h) => h.is_inaccessible !== true).slice(0, 300)
          window.localStorage.setItem(key, JSON.stringify(pruned))
        }
      } catch {
        // ignore local storage read/write failures
      }
    }
    previousAccountIdRef.current = currentAccountId
  }, [currentAccountId])

  useEffect(() => {
    const unlistenPromise = listen<{ attachment_id: string; ok: boolean; error?: string }>(
      'cordia:attachment-ready',
      () => {
        listSharedAttachments().then(setSharedAttachments).catch(() => {})
      }
    )
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ signing_pubkey: string; settings: MessageStorageSettings }>).detail
      if (!detail) return
      const signing = detail.signing_pubkey
      const next = detail.settings
      if (!signing) return
      setSettingsBySigningPubkey((prev) => ({ ...prev, [signing]: next }))
      setMessagesByBucket((prev) => pruneBuckets(prev, next, signing))
    }
    window.addEventListener('cordia:message-storage-settings-changed', onChanged as EventListener)
    return () => {
      window.removeEventListener('cordia:message-storage-settings-changed', onChanged as EventListener)
    }
  }, [])

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<DownloadSettings>).detail
      if (!detail) return
      setDownloadSettingsState(detail)
    }
    window.addEventListener('cordia:download-settings-changed', onChanged as EventListener)
    return () => {
      window.removeEventListener('cordia:download-settings-changed', onChanged as EventListener)
    }
  }, [])

  useEffect(() => {
    refreshSigningToServerMap().catch(() => {})
    const onServersUpdated = () => {
      refreshSigningToServerMap().catch(() => {})
    }
    window.addEventListener('cordia:servers-updated', onServersUpdated)
    return () => {
      window.removeEventListener('cordia:servers-updated', onServersUpdated)
    }
  }, [])

  useEffect(() => {
    const onActiveServerChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ signing_pubkey?: string | null }>).detail
      const signing = detail?.signing_pubkey?.trim() || null
      activeSigningPubkeyRef.current = signing
      if (signing) {
        markServerSeenBySigning(signing)
        if (currentAccountId && identity?.user_id) {
          const settings = getMessageStorageSettings(currentAccountId, signing)
          if (settings.mode === 'persistent') {
            const buckets = messagesByBucketRef.current
            for (const [bucket, list] of Object.entries(buckets)) {
              if (!bucket.startsWith(`${signing}::`)) continue
              const [, chatId] = bucket.split('::')
              if (!chatId) continue
              for (const msg of list) {
                if (msg.from_user_id === identity.user_id) continue
                const receiptKey = `${signing}::${chatId}::${msg.id}`
                if (receiptSentRef.current.has(receiptKey)) continue
                receiptSentRef.current.add(receiptKey)
                window.dispatchEvent(
                  new CustomEvent('cordia:send-ephemeral-receipt', {
                    detail: {
                      signing_pubkey: signing,
                      chat_id: chatId,
                      message_id: msg.id,
                      receipt_type: 'delivered',
                    },
                  })
                )
              }
            }
          }
        }
      }
    }
    window.addEventListener('cordia:active-server-changed', onActiveServerChanged as EventListener)
    return () => {
      window.removeEventListener('cordia:active-server-changed', onActiveServerChanged as EventListener)
    }
  }, [currentAccountId, identity?.user_id])

  useEffect(() => {
    if (!hydrated || !currentAccountId) return
    for (const [bucket, list] of Object.entries(messagesByBucket)) {
      const [signingPubkey, chatId] = bucket.split('::')
      if (!signingPubkey || !chatId) continue
      persistBucketIfNeeded(currentAccountId, signingPubkey, chatId, list)
      const settings = getMessageStorageSettings(currentAccountId, signingPubkey)
      const didPersist = settings.mode === 'persistent' && list.length > 0
      const serverOpen = activeSigningPubkeyRef.current === signingPubkey
      if (didPersist && serverOpen && identity?.user_id) {
        for (const msg of list) {
          if (msg.from_user_id === identity.user_id) continue
          const receiptKey = `${signingPubkey}::${chatId}::${msg.id}`
          if (receiptSentRef.current.has(receiptKey)) continue
          receiptSentRef.current.add(receiptKey)
          window.dispatchEvent(
            new CustomEvent('cordia:send-ephemeral-receipt', {
              detail: {
                signing_pubkey: signingPubkey,
                chat_id: chatId,
                message_id: msg.id,
                receipt_type: 'delivered',
              },
            })
          )
        }
      }
    }
  }, [messagesByBucket, hydrated, currentAccountId, settingsBySigningPubkey, identity?.user_id])

  useEffect(() => {
    if (!currentAccountId) return
    try {
      window.localStorage.setItem(
        unreadStateKeyForAccount(currentAccountId),
        JSON.stringify(unreadState)
      )
    } catch {
      // ignore local storage write failures
    }
  }, [unreadState, currentAccountId])

  useEffect(() => {
    if (!currentAccountId) return
    try {
      window.localStorage.setItem(
        transferHistoryKeyForAccount(currentAccountId),
        JSON.stringify(transferHistory.slice(0, 300))
      )
    } catch {
      // ignore local storage write failures
    }
  }, [transferHistory, currentAccountId])

  useEffect(() => {
    if (!currentAccountId) return
    try {
      window.localStorage.setItem(
        serverSharedShaKeyForAccount(currentAccountId),
        JSON.stringify(serverSharedSha)
      )
    } catch {
      // ignore local storage write failures
    }
  }, [serverSharedSha, currentAccountId])

  useEffect(() => {
    if (!currentAccountId) return
    try {
      window.localStorage.setItem(
        contentCacheShaKeyForAccount(currentAccountId),
        JSON.stringify(contentCacheBySha)
      )
    } catch {
      // ignore
    }
  }, [contentCacheBySha, currentAccountId])

  useEffect(() => {
    if (!currentAccountId) return
    let unlisten: (() => void) | undefined
    getCurrent()
      .onCloseRequested(() => {
        const pruned = transferHistoryRef.current.filter((h) => h.is_inaccessible !== true).slice(0, 300)
        try {
          window.localStorage.setItem(transferHistoryKeyForAccount(currentAccountId), JSON.stringify(pruned))
        } catch {
          // ignore local storage write failures
        }
        setTransferHistory(pruned)
      })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})

    return () => {
      unlisten?.()
    }
  }, [currentAccountId])

  useEffect(() => {
    let cancelled = false
    const onIncoming = async (e: Event) => {
      const detail = (e as CustomEvent<IncomingEphemeralChatDetail>).detail
      if (!detail?.signing_pubkey || !detail.chat_id || !detail.encrypted_payload || !detail.message_id) return

      try {
        const plaintext = await decryptEphemeralChatMessageBySigningPubkey(
          detail.signing_pubkey,
          detail.encrypted_payload
        )
        if (cancelled) return
        const parsed = JSON.parse(plaintext) as Partial<EphemeralPayload> & Record<string, any>
        const payloadSentAt = typeof parsed.sent_at === 'string' ? parsed.sent_at : ''
        const effectiveSentAt = Number.isFinite(Date.parse(payloadSentAt))
          ? payloadSentAt
          : (detail.sent_at || new Date().toISOString())

        if (parsed.kind === 'attachment_reshared' && typeof parsed.attachment_id === 'string' && parsed.attachment_id.trim()) {
          const attachmentId = parsed.attachment_id.trim()
          if (detail.from_user_id !== identity?.user_id) {
            setAttachmentTransfers((prev) =>
              prev.filter((t) => !(t.direction === 'download' && t.attachment_id === attachmentId && t.status === 'rejected'))
            )
            setTransferHistory((prev) =>
              prev.filter((h) => !(h.direction === 'download' && h.attachment_id === attachmentId && h.status === 'rejected'))
            )
          }
          return
        }

        let msg: EphemeralChatMessage
        if (parsed.kind === 'mixed' && Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
          const attachments = parsed.attachments as EphemeralAttachmentMeta[]
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
          msg = {
            id: detail.message_id,
            signing_pubkey: detail.signing_pubkey,
            chat_id: detail.chat_id,
            from_user_id: detail.from_user_id,
            text,
            kind: 'mixed',
            attachments,
            sent_at: effectiveSentAt,
          }
        } else if (parsed.kind === 'attachment' && parsed.attachment) {
          const text = (parsed.attachment.file_name ?? '').trim()
          if (!text) return
          msg = {
            id: detail.message_id,
            signing_pubkey: detail.signing_pubkey,
            chat_id: detail.chat_id,
            from_user_id: detail.from_user_id,
            text,
            kind: 'attachment',
            attachment: parsed.attachment,
            sent_at: effectiveSentAt,
          }
        } else {
          const text = (parsed.text ?? '').trim()
          if (!text) return
          msg = {
            id: detail.message_id,
            signing_pubkey: detail.signing_pubkey,
            chat_id: detail.chat_id,
            from_user_id: detail.from_user_id,
            text,
            kind: 'text',
            sent_at: effectiveSentAt,
          }
        }
        setMessagesByBucket((prev) => {
          const key = bucketKey(detail.signing_pubkey, detail.chat_id)
          const existing = prev[key] ?? []
          if (existing.some((m) => m.id === detail.message_id)) {
            return prev
          }
          return appendAndPruneBySigning(prev, detail.signing_pubkey, detail.chat_id, msg)
        })
        if (detail.signing_pubkey !== activeSigningPubkeyRef.current) {
          incrementUnreadForSigning(detail.signing_pubkey)
        }
      } catch {
        // Ignore payloads we cannot decrypt (e.g. not a member of that server).
      }
    }

    window.addEventListener('cordia:ephemeral-chat-incoming', onIncoming as EventListener)
    return () => {
      cancelled = true
      window.removeEventListener('cordia:ephemeral-chat-incoming', onIncoming as EventListener)
    }
  }, [identity?.user_id, settingsBySigningPubkey])

  // Retry pending outbox messages while we're online, bounded by max_sync_kb.
  useEffect(() => {
    if (!identity?.user_id) return
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const budgetUsedBySigning = new Map<string, number>()
        const pending = Object.values(messagesByBucket)
          .flat()
          .filter((m) => m.from_user_id === identity.user_id && m.delivery_status === 'pending')
          .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))
        for (const m of pending) {
          const settingsForMessage = messageSettingsFor(m.signing_pubkey)
          const maxBudgetBytes = Math.max(32, settingsForMessage.max_sync_kb) * 1024
          const usedBytes = budgetUsedBySigning.get(m.signing_pubkey) ?? 0
          const payload =
            m.kind === 'mixed' && m.attachments?.length
              ? JSON.stringify({ kind: 'mixed', attachments: m.attachments, text: m.text || undefined, sent_at: m.sent_at } satisfies EphemeralPayload)
              : m.kind === 'attachment' && m.attachment
                ? JSON.stringify({ kind: 'attachment', attachment: m.attachment, sent_at: m.sent_at } satisfies EphemeralPayload)
                : JSON.stringify({ kind: 'text', text: m.text, sent_at: m.sent_at } satisfies EphemeralPayload)
          const estimate = storageBytes(payload) + 128
          if (usedBytes + estimate > maxBudgetBytes) continue
          budgetUsedBySigning.set(m.signing_pubkey, usedBytes + estimate)
          try {
            const encrypted_payload = await encryptEphemeralChatMessageBySigningPubkey(m.signing_pubkey, payload)
            if (cancelled) return
            window.dispatchEvent(
              new CustomEvent('cordia:send-ephemeral-chat', {
                detail: {
                  signing_pubkey: m.signing_pubkey,
                  chat_id: m.chat_id,
                  message_id: m.id,
                  encrypted_payload,
                },
              })
            )
          } catch {
            // Ignore encrypt/send errors; keep pending for next retry tick.
          }
        }
      } finally {
        inFlight = false
      }
    }
    // Immediate attempt + periodic retries.
    tick()
    const id = window.setInterval(tick, 5000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [messagesByBucket, identity?.user_id, settingsBySigningPubkey])

  useEffect(() => {
    const onReceipt = (e: Event) => {
      const detail = (e as CustomEvent<IncomingEphemeralReceiptDetail>).detail
      if (!detail?.signing_pubkey || !detail?.chat_id || !detail?.message_id || !detail?.from_user_id) return
      if (detail.receipt_type !== 'delivered') return
      setMessagesByBucket((prev) => {
        const key = bucketKey(detail.signing_pubkey, detail.chat_id)
        const list = prev[key]
        if (!list || list.length === 0) return prev
        let changed = false
        const nextList: EphemeralChatMessage[] = list.map((m) => {
          if (m.id !== detail.message_id) return m
          const deliveredBy = m.delivered_by ?? []
          if (deliveredBy.includes(detail.from_user_id)) return m
          changed = true
          return {
            ...m,
            delivered_by: [...deliveredBy, detail.from_user_id],
            delivery_status: 'delivered',
          }
        })
        if (!changed) return prev
        return { ...prev, [key]: nextList }
      })
    }

    window.addEventListener('cordia:ephemeral-receipt-incoming', onReceipt as EventListener)
    return () => {
      window.removeEventListener('cordia:ephemeral-receipt-incoming', onReceipt as EventListener)
    }
  }, [])

  useEffect(() => {
    if (!identity?.user_id) return

    const sendSignal = (toUserId: string, requestId: string, signalObj: unknown) => {
      window.dispatchEvent(
        new CustomEvent('cordia:send-attachment-transfer-signal', {
          detail: {
            to_user_id: toUserId,
            request_id: requestId,
            signal: JSON.stringify(signalObj),
          },
        })
      )
    }

    const onIncomingRequest = async (e: Event) => {
      const detail = (e as CustomEvent<{ from_user_id?: string; request_id?: string; attachment_id?: string }>).detail
      const fromUserId = detail?.from_user_id?.trim()
      const requestId = detail?.request_id?.trim()
      const attachmentId = detail?.attachment_id?.trim()
      if (!fromUserId || !requestId || !attachmentId) return

      const sharedItem = sharedAttachmentsRef.current.find((s) => s.attachment_id === attachmentId)
      if (!sharedItem?.can_share_now) {
        window.dispatchEvent(new CustomEvent('cordia:send-attachment-transfer-response', {
          detail: { to_user_id: fromUserId, request_id: requestId, accepted: false },
        }))
        return
      }
      const attachment = {
        attachment_id: sharedItem.attachment_id,
        file_name: sharedItem.file_name,
        extension: sharedItem.extension,
        size_bytes: sharedItem.size_bytes,
        sha256: sharedItem.sha256,
      }

      const relatedMessage = Object.values(messagesByBucketRef.current)
        .flat()
        .find(
          (m) =>
            (m.kind === 'attachment' && m.attachment?.attachment_id === attachmentId) ||
            (m.kind === 'mixed' && m.attachments?.some((a) => a.attachment_id === attachmentId))
        )
      const signingPubkey = relatedMessage?.signing_pubkey ?? ''
      const settings = signingPubkey
        ? getMessageStorageSettings(currentAccountId, signingPubkey)
        : DEFAULT_MESSAGE_STORAGE_SETTINGS
      const askFirst = settings.attachment_download_allow === 'ask'
      let approved = !askFirst
      if (askFirst) {
        approved = await confirmDialog(
          `${fromUserId} wants to download "${attachment.file_name}". Allow transfer now?`,
          {
            title: 'Attachment Transfer',
            type: 'info',
            okLabel: 'Allow',
            cancelLabel: 'Deny',
          }
        )
      }
      if (!approved) {
        window.dispatchEvent(new CustomEvent('cordia:send-attachment-transfer-response', {
          detail: { to_user_id: fromUserId, request_id: requestId, accepted: false },
        }))
        return
      }

      upsertTransfer(requestId, () => ({
        request_id: requestId,
        message_id: relatedMessage?.id ?? '',
        attachment_id: attachmentId,
        from_user_id: identity.user_id!,
        to_user_id: fromUserId,
        file_name: attachment.file_name,
        direction: 'upload',
        status: 'connecting',
        progress: 0,
      }))
      window.dispatchEvent(new CustomEvent('cordia:send-attachment-transfer-response', {
        detail: { to_user_id: fromUserId, request_id: requestId, accepted: true },
      }))

      const pc = createPeerConnection()
      transferPeersRef.current.set(requestId, pc)
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return
        sendSignal(fromUserId, requestId, { type: 'ice', candidate: JSON.stringify(ev.candidate) })
      }
      const dc = pc.createDataChannel('cordia-attachment', { ordered: true })
      transferDataChannelsRef.current.set(requestId, dc)
      dc.binaryType = 'arraybuffer'
      dc.bufferedAmountLowThreshold = UPLOAD_LOW_WATER
      const session = getOrCreateUploadSession(attachmentId, attachment)
      const subscriber: UploadSubscriber = {
        requestId,
        toUserId: fromUserId,
        dc,
        ready: false,
        flowPaused: false,
        nextOffset: 0,
        done: false,
      }
      session.subscribers.set(requestId, subscriber)
      dc.onopen = async () => {
        try {
          upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), status: 'transferring' }))
          dc.send(
            JSON.stringify({
              type: 'meta',
              file_name: session.fileName,
              size_bytes: session.totalBytes,
              sha256: session.sha256,
            })
          )
          subscriber.ready = true
          startUploadSessionPump(session)
        } catch (err) {
          upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), status: 'failed', error: String(err) }))
          removeUploadSubscriber(session, requestId)
          cleanupTransferPeer(requestId)
        }
      }
      dc.onmessage = (m) => {
        if (typeof m.data !== 'string') return
        try {
          const control = JSON.parse(m.data) as { type?: string }
          if (control.type === 'flow_pause') {
            subscriber.flowPaused = true
          } else if (control.type === 'flow_resume') {
            subscriber.flowPaused = false
          }
        } catch {
          // ignore malformed control message
        }
      }
      dc.onclose = () => {
        if (!subscriber.done) {
          upsertTransfer(requestId, (prev) => ({
            ...(prev as AttachmentTransferState),
            status: prev?.status === 'completed' ? 'completed' : 'failed',
            error: prev?.status === 'completed' ? undefined : 'Receiver disconnected',
          }))
        }
        removeUploadSubscriber(session, requestId)
        cleanupTransferPeer(requestId)
      }
      dc.onerror = () => {
        if (!subscriber.done) {
          upsertTransfer(requestId, (prev) => ({
            ...(prev as AttachmentTransferState),
            status: 'failed',
            error: 'Data channel error during upload',
          }))
        }
        removeUploadSubscriber(session, requestId)
        cleanupTransferPeer(requestId)
      }

      const offerSdp = await createOffer(pc)
      sendSignal(fromUserId, requestId, { type: 'offer', sdp: offerSdp })
    }

    const onIncomingResponse = async (e: Event) => {
      const detail = (e as CustomEvent<{ from_user_id?: string; request_id?: string; accepted?: boolean }>).detail
      const fromUserId = detail?.from_user_id?.trim()
      const requestId = detail?.request_id?.trim()
      if (!fromUserId || !requestId) return
      const existing = attachmentTransfersRef.current.find((t) => t.request_id === requestId)
      if (!existing || existing.direction !== 'download') return
      if (!detail?.accepted) {
        upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), status: 'rejected' }))
        cleanupTransferPeer(requestId)
        tryStartNextQueuedDownload()
        return
      }
      upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), status: 'connecting' }))
      const pc = createPeerConnection()
      transferPeersRef.current.set(requestId, pc)
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return
        sendSignal(fromUserId, requestId, { type: 'ice', candidate: JSON.stringify(ev.candidate) })
      }
      pc.ondatachannel = (ev) => {
        const dc = ev.channel
        transferDataChannelsRef.current.set(requestId, dc)
        dc.binaryType = 'arraybuffer'
        dc.onmessage = async (m) => {
          if (typeof m.data === 'string') {
            try {
              const control = JSON.parse(m.data) as { type?: string; file_name?: string; size_bytes?: number; sha256?: string }
              if (control.type === 'flow_pause' || control.type === 'flow_resume') {
                return
              }
              if (control.type === 'meta') {
                transferExpectedSizeRef.current.set(requestId, Number(control.size_bytes ?? 0))
                downloadStreamStateRef.current.set(requestId, {
                  expected: Number(control.size_bytes ?? 0),
                  receivedBytes: 0,
                  writtenBytes: 0,
                  pending: [],
                  pendingBytes: 0,
                  started: true,
                  doneReceived: false,
                  writerRunning: false,
                  flowPauseSent: false,
                })
                const fileName = control.file_name || (attachmentTransfersRef.current.find((t) => t.request_id === requestId)?.file_name ?? 'attachment.bin')
                beginDownloadStream(requestId, fileName, control.sha256 ?? null, downloadSettings.preferred_dir)
                  .then(() => {
                    startDownloadWriter(requestId)
                  })
                  .catch(() => {
                    upsertTransfer(requestId, (prev) => ({
                      ...(prev as AttachmentTransferState),
                      status: 'failed',
                      error: 'Failed to start download stream',
                    }))
                    cleanupTransferPeer(requestId)
                    tryStartNextQueuedDownload()
                  })
                upsertTransfer(requestId, (prev) => ({
                  ...(prev as AttachmentTransferState),
                  file_name: control.file_name || (prev?.file_name ?? 'attachment.bin'),
                  status: 'transferring',
                  progress: 0,
                }))
              }
              if (control.type === 'done') {
                const st = downloadStreamStateRef.current.get(requestId)
                if (!st?.started) {
                  upsertTransfer(requestId, (prev) => ({
                    ...(prev as AttachmentTransferState),
                    status: 'failed',
                    error: 'Download stream missing',
                  }))
                  cleanupTransferPeer(requestId)
                  tryStartNextQueuedDownload()
                  return
                }
                st.doneReceived = true
                downloadStreamStateRef.current.set(requestId, st)
                const wake = downloadWriterWakeRef.current.get(requestId)
                if (wake) {
                  downloadWriterWakeRef.current.delete(requestId)
                  wake()
                }
              }
            } catch {
              // ignore malformed control message
            }
            return
          }
          const chunk = new Uint8Array(m.data as ArrayBuffer)
          const st = downloadStreamStateRef.current.get(requestId)
          if (!st?.started) return
          st.pending.push(chunk)
          st.pendingBytes += chunk.byteLength
          st.receivedBytes += chunk.byteLength
          if (!st.flowPauseSent && st.pendingBytes >= MAX_PENDING_BYTES) {
            const flowDc = transferDataChannelsRef.current.get(requestId)
            if (flowDc && flowDc.readyState === 'open') {
              try {
                flowDc.send(JSON.stringify({ type: 'flow_pause' }))
                st.flowPauseSent = true
              } catch {
                // ignore transient channel send failures
              }
            }
          }
          downloadStreamStateRef.current.set(requestId, st)
          const wake = downloadWriterWakeRef.current.get(requestId)
          if (wake) {
            downloadWriterWakeRef.current.delete(requestId)
            wake()
          }
          startDownloadWriter(requestId)
          // UI progress/debug are updated from bytes written to disk in writer loop.
        }
      }
    }

    const onIncomingSignal = async (e: Event) => {
      const detail = (e as CustomEvent<{ from_user_id?: string; request_id?: string; signal?: string }>).detail
      const fromUserId = detail?.from_user_id?.trim()
      const requestId = detail?.request_id?.trim()
      const signalRaw = detail?.signal
      if (!fromUserId || !requestId || !signalRaw) return
      const signal = JSON.parse(signalRaw) as { type?: string; sdp?: string; candidate?: string }
      const pc = transferPeersRef.current.get(requestId)
      if (!pc) return
      if (signal.type === 'offer' && signal.sdp) {
        const answerSdp = await createAnswer(pc, signal.sdp)
        sendSignal(fromUserId, requestId, { type: 'answer', sdp: answerSdp })
        return
      }
      if (signal.type === 'answer' && signal.sdp) {
        await handleAnswer(pc, signal.sdp)
        return
      }
      if (signal.type === 'ice' && signal.candidate) {
        await addIceCandidate(pc, signal.candidate)
      }
    }

    window.addEventListener('cordia:attachment-transfer-request-incoming', onIncomingRequest as EventListener)
    window.addEventListener('cordia:attachment-transfer-response-incoming', onIncomingResponse as EventListener)
    window.addEventListener('cordia:attachment-transfer-signal-incoming', onIncomingSignal as EventListener)
    return () => {
      window.removeEventListener('cordia:attachment-transfer-request-incoming', onIncomingRequest as EventListener)
      window.removeEventListener('cordia:attachment-transfer-response-incoming', onIncomingResponse as EventListener)
      window.removeEventListener('cordia:attachment-transfer-signal-incoming', onIncomingSignal as EventListener)
    }
  }, [identity?.user_id, downloadSettings.preferred_dir])

  const getMessages = (signingPubkey: string, chatId: string): EphemeralChatMessage[] => {
    if (!signingPubkey || !chatId) return []
    const list = messagesByBucket[bucketKey(signingPubkey, chatId)] ?? []
    const timeKey = (s: string) => {
      const t = Date.parse(s)
      return Number.isFinite(t) ? t : 0
    }
    // Return sorted copy so late-delivered messages slot correctly.
    return [...list].sort((a, b) => {
      const ta = timeKey(a.sent_at)
      const tb = timeKey(b.sent_at)
      if (ta !== tb) return ta - tb
      return String(a.id).localeCompare(String(b.id))
    })
  }

  const openServerChat: EphemeralMessagesContextType['openServerChat'] = (serverId, signingPubkey, chatId) => {
    if (!serverId || !signingPubkey || !chatId) return
    ensureSettingsLoaded(signingPubkey)
    ensureBucketLoaded(signingPubkey, chatId)
    activeSigningPubkeyRef.current = signingPubkey
    setUnreadState((prev) => ({
      unread_count_by_server: { ...prev.unread_count_by_server, [serverId]: 0 },
      last_seen_at_by_server: { ...prev.last_seen_at_by_server, [serverId]: new Date().toISOString() },
    }))
  }

  const getUnreadCount: EphemeralMessagesContextType['getUnreadCount'] = (serverId) =>
    unreadState.unread_count_by_server[serverId] ?? 0

  const sendMessage: EphemeralMessagesContextType['sendMessage'] = async ({
    serverId,
    signingPubkey,
    chatId,
    fromUserId,
    text,
  }) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const sentAt = new Date().toISOString()
    const payload = JSON.stringify({ kind: 'text', text: trimmed, sent_at: sentAt } satisfies EphemeralPayload)
    const encrypted_payload = await encryptEphemeralChatMessage(serverId, payload)
    const messageId = `${fromUserId}:${Date.now()}:${Math.random().toString(36).slice(2)}`

    window.dispatchEvent(
      new CustomEvent('cordia:send-ephemeral-chat', {
        detail: {
          signing_pubkey: signingPubkey,
          chat_id: chatId,
          message_id: messageId,
          encrypted_payload,
        },
      })
    )

    // Sender is excluded from relay broadcast; add local echo.
    const localMessage: EphemeralChatMessage = {
      id: messageId,
      signing_pubkey: signingPubkey,
      chat_id: chatId,
      from_user_id: fromUserId,
      text: trimmed,
      kind: 'text',
      sent_at: sentAt,
      local_only: true,
      delivery_status: 'pending',
      delivered_by: [],
    }
    setMessagesByBucket((prev) => {
      return appendAndPruneBySigning(prev, signingPubkey, chatId, localMessage)
    })
    ensureBucketLoaded(signingPubkey, chatId)
  }

  const sendAttachmentMessage: EphemeralMessagesContextType['sendAttachmentMessage'] = async ({
    serverId,
    signingPubkey,
    chatId,
    fromUserId,
    attachment,
  }) => {
    if (!attachment?.attachment_id) return
    const sentAt = new Date().toISOString()
    const payload = JSON.stringify({ kind: 'attachment', attachment, sent_at: sentAt } satisfies EphemeralPayload)
    const encrypted_payload = await encryptEphemeralChatMessage(serverId, payload)
    const messageId = `${fromUserId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    window.dispatchEvent(
      new CustomEvent('cordia:send-ephemeral-chat', {
        detail: {
          signing_pubkey: signingPubkey,
          chat_id: chatId,
          message_id: messageId,
          encrypted_payload,
        },
      })
    )
    const localMessage: EphemeralChatMessage = {
      id: messageId,
      signing_pubkey: signingPubkey,
      chat_id: chatId,
      from_user_id: fromUserId,
      text: attachment.file_name,
      kind: 'attachment',
      attachment,
      sent_at: sentAt,
      local_only: true,
      delivery_status: 'pending',
      delivered_by: [],
    }
    setMessagesByBucket((prev) => {
      return appendAndPruneBySigning(prev, signingPubkey, chatId, localMessage)
    })
    ensureBucketLoaded(signingPubkey, chatId)
    listSharedAttachments()
      .then((list) => setSharedAttachments(list))
      .catch(() => {})
  }

  const sendMixedMessage: EphemeralMessagesContextType['sendMixedMessage'] = async ({
    serverId,
    signingPubkey,
    chatId,
    fromUserId,
    attachments,
    text,
  }) => {
    if (!attachments?.length) return
    const sentAt = new Date().toISOString()
    const payload = JSON.stringify({
      kind: 'mixed',
      attachments,
      text: text?.trim() || undefined,
      sent_at: sentAt,
    } satisfies EphemeralPayload)
    const encrypted_payload = await encryptEphemeralChatMessage(serverId, payload)
    const messageId = `${fromUserId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    window.dispatchEvent(
      new CustomEvent('cordia:send-ephemeral-chat', {
        detail: {
          signing_pubkey: signingPubkey,
          chat_id: chatId,
          message_id: messageId,
          encrypted_payload,
        },
      })
    )
    const localMessage: EphemeralChatMessage = {
      id: messageId,
      signing_pubkey: signingPubkey,
      chat_id: chatId,
      from_user_id: fromUserId,
      text: text?.trim() ?? '',
      kind: 'mixed',
      attachments,
      sent_at: sentAt,
      local_only: true,
      delivery_status: 'pending',
      delivered_by: [],
    }
    setMessagesByBucket((prev) => appendAndPruneBySigning(prev, signingPubkey, chatId, localMessage))
    ensureBucketLoaded(signingPubkey, chatId)
    listSharedAttachments()
      .then((list) => setSharedAttachments(list))
      .catch(() => {})
  }

  const requestAttachmentDownload: EphemeralMessagesContextType['requestAttachmentDownload'] = async (msg, attachment) => {
    const att = attachment ?? msg.attachment ?? (msg.attachments?.[0])
    if (!identity?.user_id || !att?.attachment_id || !msg.from_user_id || msg.from_user_id === identity.user_id) return
    const attachmentId = att.attachment_id
    if (hasAccessibleCompletedDownload(attachmentId)) return
    if (att.sha256 && getCachedPathForSha(att.sha256)) return
    setTransferHistory((prev) =>
      prev.filter(
        (h) =>
          !(
            h.direction === 'download' &&
            h.attachment_id === attachmentId &&
            h.status === 'completed' &&
            h.is_inaccessible === true
          )
      )
    )

    const duplicateActive = attachmentTransfersRef.current.some(
      (t) =>
        t.direction === 'download' &&
        (t.message_id === msg.id || t.attachment_id === att.attachment_id) &&
        t.status !== 'completed' &&
        t.status !== 'failed' &&
        t.status !== 'rejected'
    )
    if (duplicateActive) return
    const peerUserId = msg.from_user_id
    const queueInstead = activeDownloadCount() >= MAX_PARALLEL_DOWNLOADS
    const request_id = `${identity.user_id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    upsertTransfer(request_id, () => ({
      request_id,
      message_id: msg.id,
      attachment_id: attachmentId,
      from_user_id: msg.from_user_id,
      to_user_id: identity.user_id,
      file_name: att.file_name,
      direction: 'download',
      status: queueInstead ? 'queued' : 'requesting',
      progress: 0,
      sha256: att.sha256,
    }))
    const now = new Date().toISOString()
    upsertHistory(request_id, () => ({
      request_id,
      message_id: msg.id,
      attachment_id: attachmentId,
      file_name: att.file_name,
      size_bytes: att.size_bytes,
      from_user_id: msg.from_user_id,
      to_user_id: identity.user_id,
      direction: 'download',
      status: queueInstead ? 'queued' : 'requesting',
      progress: 0,
      created_at: now,
      updated_at: now,
    }))
    if (queueInstead) {
      enqueueDownload({
        request_id,
        message_id: msg.id,
        attachment_id: attachmentId,
        from_user_id: msg.from_user_id,
        to_user_id: identity.user_id,
        file_name: att.file_name,
        size_bytes: att.size_bytes,
      })
      return
    }
    dispatchDownloadRequest(peerUserId, request_id, attachmentId)
  }

  const refreshSharedAttachments: EphemeralMessagesContextType['refreshSharedAttachments'] = async (
    attachmentIdJustShared?: string
  ) => {
    try {
      const list = await listSharedAttachments()
      const finalList =
        attachmentIdJustShared != null
          ? list.map((s) =>
              s.attachment_id === attachmentIdJustShared ? { ...s, can_share_now: true } : s
            )
          : list
      setSharedAttachments(finalList)
    } catch {
      setSharedAttachments([])
    }
  }

  const unshareAttachmentById: EphemeralMessagesContextType['unshareAttachmentById'] = async (attachmentId) => {
    if (!attachmentId) return
    const shaToRemove = sharedAttachments.find((s) => s.attachment_id === attachmentId)?.sha256
    try {
      await unshareAttachment(attachmentId)
      await refreshSharedAttachments()
      if (shaToRemove) {
        setServerSharedSha((prev) => {
          const next = { ...prev }
          for (const serverKey of Object.keys(next)) {
            const arr = next[serverKey].filter((s) => s !== shaToRemove)
            if (arr.length === 0) delete next[serverKey]
            else next[serverKey] = arr
          }
          return next
        })
      }
    } catch {
      // ignore for now
    }
  }

  const markSharedInServer: EphemeralMessagesContextType['markSharedInServer'] = (serverSigningPubkey, sha256) => {
    if (!serverSigningPubkey || !sha256) return
    setServerSharedSha((prev) => {
      const list = prev[serverSigningPubkey] ?? []
      if (list.includes(sha256)) return prev
      return { ...prev, [serverSigningPubkey]: [...list, sha256] }
    })
  }

  const isSharedInServer: EphemeralMessagesContextType['isSharedInServer'] = (serverSigningPubkey, sha256) => {
    if (!serverSigningPubkey || !sha256) return false
    const list = serverSharedSha[serverSigningPubkey]
    return Array.isArray(list) && list.includes(sha256)
  }

  const getServersForSha: EphemeralMessagesContextType['getServersForSha'] = (sha256) => {
    if (!sha256) return []
    return Object.keys(serverSharedSha).filter((serverKey) =>
      Array.isArray(serverSharedSha[serverKey]) && serverSharedSha[serverKey].includes(sha256)
    )
  }

  const getCachedPathForSha: EphemeralMessagesContextType['getCachedPathForSha'] = (sha256) => {
    if (!sha256) return null
    const fromDownloadCache = contentCacheBySha[sha256]
    if (fromDownloadCache) return fromDownloadCache
    // Same content may exist from our own upload (e.g. we sent in Server 1, someone else sent same file in Server 2)
    const fromShared = sharedAttachments.find((s) => s.sha256 === sha256 && (s.file_path ?? '').length > 0)
    return fromShared?.file_path ?? null
  }

  const unshareFromServer: EphemeralMessagesContextType['unshareFromServer'] = (serverSigningPubkey, sha256) => {
    if (!serverSigningPubkey || !sha256) return
    setServerSharedSha((prev) => {
      const list = prev[serverSigningPubkey]
      if (!list) return prev
      const next = list.filter((s) => s !== sha256)
      if (next.length === 0) {
        const { [serverSigningPubkey]: _, ...rest } = prev
        return rest
      }
      return { ...prev, [serverSigningPubkey]: next }
    })
  }

  const notifyAttachmentReshared: EphemeralMessagesContextType['notifyAttachmentReshared'] = async (
    signingPubkey,
    chatId,
    attachmentId
  ) => {
    if (!signingPubkey?.trim() || !chatId?.trim() || !attachmentId?.trim()) return
    const payload: EphemeralPayload = {
      kind: 'attachment_reshared',
      attachment_id: attachmentId.trim(),
      sent_at: new Date().toISOString(),
    }
    const encrypted_payload = await encryptEphemeralChatMessageBySigningPubkey(signingPubkey, JSON.stringify(payload))
    const message_id = `reshared:${attachmentId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    window.dispatchEvent(
      new CustomEvent('cordia:send-ephemeral-chat', {
        detail: { signing_pubkey: signingPubkey.trim(), chat_id: chatId.trim(), message_id, encrypted_payload },
      })
    )
  }

  const value = useMemo(
    () => ({
      getMessages,
      openServerChat,
      getUnreadCount,
      sendMessage,
      sendAttachmentMessage,
      sendMixedMessage,
      requestAttachmentDownload,
      attachmentTransfers,
      transferHistory,
      hasAccessibleCompletedDownload,
      refreshTransferHistoryAccessibility,
      removeTransferHistoryEntry,
      cancelTransferRequest,
      sharedAttachments,
      refreshSharedAttachments,
      unshareAttachmentById,
      notifyAttachmentReshared,
      markSharedInServer,
      isSharedInServer,
      getServersForSha,
      unshareFromServer,
      getCachedPathForSha,
    }),
    [messagesByBucket, unreadState, identity?.user_id, attachmentTransfers, transferHistory, sharedAttachments, serverSharedSha, contentCacheBySha]
  )

  return <EphemeralMessagesContext.Provider value={value}>{children}</EphemeralMessagesContext.Provider>
}

export function useEphemeralMessages() {
  const ctx = useContext(EphemeralMessagesContext)
  if (!ctx) throw new Error('useEphemeralMessages must be used within an EphemeralMessagesProvider')
  return ctx
}
