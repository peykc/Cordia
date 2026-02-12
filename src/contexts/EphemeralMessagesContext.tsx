import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  getAttachmentRecord,
  readAttachmentBytes,
  saveDownloadedAttachment,
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
import { addIceCandidate, createAnswer, createOffer, createPeerConnection, handleAnswer } from '../lib/webrtc'
import { confirm as confirmDialog } from '@tauri-apps/api/dialog'

export interface EphemeralAttachmentMeta {
  attachment_id: string
  file_name: string
  extension: string
  size_bytes: number
  sha256: string
}

export interface EphemeralChatMessage {
  id: string
  signing_pubkey: string
  chat_id: string
  from_user_id: string
  text: string
  kind?: 'text' | 'attachment'
  attachment?: EphemeralAttachmentMeta
  sent_at: string
  local_only?: boolean
  delivery_status?: 'pending' | 'delivered' | 'read'
  delivered_by?: string[]
  read_by?: string[]
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
  receipt_type: 'delivered' | 'read'
  sent_at: string
}

interface EphemeralMessagesContextType {
  getMessages: (signingPubkey: string, chatId: string) => EphemeralChatMessage[]
  sendMessage: (input: SendEphemeralChatInput) => Promise<void>
  sendAttachmentMessage: (input: SendEphemeralAttachmentInput) => Promise<void>
  requestAttachmentDownload: (msg: EphemeralChatMessage) => Promise<void>
  attachmentTransfers: AttachmentTransferState[]
  markMessagesRead: (signingPubkey: string, chatId: string, messageIds: string[]) => void
}

export interface AttachmentTransferState {
  request_id: string
  message_id: string
  attachment_id: string
  from_user_id: string
  to_user_id: string
  file_name: string
  direction: 'upload' | 'download'
  status: 'requesting' | 'connecting' | 'transferring' | 'completed' | 'rejected' | 'failed'
  progress: number
  saved_path?: string
  error?: string
}

const EphemeralMessagesContext = createContext<EphemeralMessagesContextType | null>(null)

type MessageBuckets = Record<string, EphemeralChatMessage[]>
const PERSIST_KEY_PREFIX = 'cordia:ephemeral-messages'

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

function storageBytes(input: string): number {
  return new TextEncoder().encode(input).length
}

function pruneBuckets(
  buckets: MessageBuckets,
  settings: MessageStorageSettings,
  nowMs: number
): MessageBuckets {
  const cutoffMs = nowMs - settings.retention_hours * 60 * 60 * 1000
  const perChatPruned: MessageBuckets = {}

  for (const [key, list] of Object.entries(buckets)) {
    const filtered = list
      .filter((m) => {
        const ts = Date.parse(m.sent_at)
        return Number.isFinite(ts) && ts >= cutoffMs
      })
      .slice(-settings.max_messages_per_chat)
    if (filtered.length > 0) perChatPruned[key] = filtered
  }

  // Global count cap: keep newest messages across all chats.
  const all = Object.entries(perChatPruned).flatMap(([k, arr]) => arr.map((m) => ({ k, m })))
  all.sort((a, b) => Date.parse(a.m.sent_at) - Date.parse(b.m.sent_at))
  const keptByCount = all.slice(-settings.max_total_messages)

  const rebuiltByCount: MessageBuckets = {}
  for (const { k, m } of keptByCount) {
    if (!rebuiltByCount[k]) rebuiltByCount[k] = []
    rebuiltByCount[k].push(m)
  }

  // Approx storage cap in bytes of serialized cache.
  const maxBytes = settings.max_storage_mb * 1024 * 1024
  let compact = rebuiltByCount
  let serialized = JSON.stringify(compact)
  if (storageBytes(serialized) <= maxBytes) return compact

  // Drop oldest globally until under cap.
  let flat = Object.entries(compact).flatMap(([k, arr]) => arr.map((m) => ({ k, m })))
  flat.sort((a, b) => Date.parse(a.m.sent_at) - Date.parse(b.m.sent_at))
  while (flat.length > 0) {
    flat = flat.slice(1)
    const next: MessageBuckets = {}
    for (const { k, m } of flat) {
      if (!next[k]) next[k] = []
      next[k].push(m)
    }
    serialized = JSON.stringify(next)
    if (storageBytes(serialized) <= maxBytes) return next
  }
  return {}
}

export function EphemeralMessagesProvider({ children }: { children: ReactNode }) {
  const { currentAccountId } = useAccount()
  const { identity } = useIdentity()
  const [settings, setSettings] = useState<MessageStorageSettings>(DEFAULT_MESSAGE_STORAGE_SETTINGS)
  const [messagesByBucket, setMessagesByBucket] = useState<MessageBuckets>({})
  const [attachmentTransfers, setAttachmentTransfers] = useState<AttachmentTransferState[]>([])
  const [hydrated, setHydrated] = useState(false)
  const transferPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const transferBuffersRef = useRef<Map<string, Uint8Array[]>>(new Map())
  const transferExpectedSizeRef = useRef<Map<string, number>>(new Map())
  const attachmentTransfersRef = useRef<AttachmentTransferState[]>([])
  const messagesByBucketRef = useRef<MessageBuckets>({})

  const upsertTransfer = (requestId: string, updater: (prev?: AttachmentTransferState) => AttachmentTransferState) => {
    setAttachmentTransfers((prev) => {
      const idx = prev.findIndex((t) => t.request_id === requestId)
      if (idx < 0) return [...prev, updater(undefined)]
      const next = [...prev]
      next[idx] = updater(prev[idx])
      return next
    })
  }

  const cleanupTransferPeer = (requestId: string) => {
    const pc = transferPeersRef.current.get(requestId)
    if (pc) {
      try { pc.close() } catch {}
      transferPeersRef.current.delete(requestId)
    }
    transferBuffersRef.current.delete(requestId)
    transferExpectedSizeRef.current.delete(requestId)
  }

  useEffect(() => {
    attachmentTransfersRef.current = attachmentTransfers
  }, [attachmentTransfers])

  useEffect(() => {
    messagesByBucketRef.current = messagesByBucket
  }, [messagesByBucket])

  // Hydrate cache + settings on account change.
  useEffect(() => {
    setHydrated(false)
    const nextSettings = getMessageStorageSettings(currentAccountId)
    setSettings(nextSettings)

    if (!currentAccountId) {
      setMessagesByBucket({})
      setHydrated(true)
      return
    }

    try {
      const raw = window.localStorage.getItem(persistKeyForAccount(currentAccountId))
      if (!raw) {
        setMessagesByBucket({})
        setHydrated(true)
        return
      }
      const parsed = JSON.parse(raw) as MessageBuckets
      const pruned = pruneBuckets(parsed, nextSettings, Date.now())
      setMessagesByBucket(pruned)
    } catch {
      setMessagesByBucket({})
    } finally {
      setHydrated(true)
    }
  }, [currentAccountId])

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<MessageStorageSettings>).detail
      if (!detail) return
      const next = detail
      setSettings(next)
      setMessagesByBucket((prev) => pruneBuckets(prev, next, Date.now()))
    }
    window.addEventListener('cordia:message-storage-settings-changed', onChanged as EventListener)
    return () => {
      window.removeEventListener('cordia:message-storage-settings-changed', onChanged as EventListener)
    }
  }, [])

  useEffect(() => {
    if (!hydrated || !currentAccountId) return
    const pruned = pruneBuckets(messagesByBucket, settings, Date.now())
    const json = JSON.stringify(pruned)
    try {
      window.localStorage.setItem(persistKeyForAccount(currentAccountId), json)
    } catch {
      // ignore local storage write failures
    }
    // If pruning changed contents, converge state.
    if (JSON.stringify(messagesByBucket) !== json) {
      setMessagesByBucket(pruned)
    }
  }, [messagesByBucket, settings, hydrated, currentAccountId])

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
        const parsed = JSON.parse(plaintext) as {
          kind?: 'text' | 'attachment'
          text?: string
          attachment?: EphemeralAttachmentMeta
        }
        const kind = parsed.kind === 'attachment' ? 'attachment' : 'text'
        const text = kind === 'attachment'
          ? (parsed.attachment?.file_name ?? '').trim()
          : (parsed.text ?? '').trim()
        if (!text) return

        const msg: EphemeralChatMessage = {
          id: detail.message_id,
          signing_pubkey: detail.signing_pubkey,
          chat_id: detail.chat_id,
          from_user_id: detail.from_user_id,
          text,
          kind,
          attachment: kind === 'attachment' ? parsed.attachment : undefined,
          sent_at: detail.sent_at || new Date().toISOString(),
          delivery_status: 'delivered',
          delivered_by: [],
          read_by: [],
        }
        setMessagesByBucket((prev) => {
          const key = bucketKey(detail.signing_pubkey, detail.chat_id)
          const existing = prev[key] ?? []
          if (existing.some((m) => m.id === detail.message_id)) {
            return prev
          }
          const next = appendMessage(prev, detail.signing_pubkey, detail.chat_id, msg)
          return pruneBuckets(next, settings, Date.now())
        })

        if (identity?.user_id && detail.from_user_id !== identity.user_id) {
          window.dispatchEvent(
            new CustomEvent('cordia:send-ephemeral-receipt', {
              detail: {
                signing_pubkey: detail.signing_pubkey,
                chat_id: detail.chat_id,
                message_id: detail.message_id,
                receipt_type: 'delivered',
              },
            })
          )
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
  }, [settings, identity?.user_id])

  // Retry pending outbox messages while we're online, bounded by max_sync_kb.
  useEffect(() => {
    if (!identity?.user_id) return
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const maxBudgetBytes = Math.max(32, settings.max_sync_kb) * 1024
        let usedBytes = 0
        const pending = Object.values(messagesByBucket)
          .flat()
          .filter((m) => m.from_user_id === identity.user_id && m.delivery_status === 'pending')
          .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))
        for (const m of pending) {
          const payload = m.kind === 'attachment' && m.attachment
            ? JSON.stringify({ kind: 'attachment', attachment: m.attachment })
            : JSON.stringify({ kind: 'text', text: m.text })
          const estimate = storageBytes(payload) + 128
          if (usedBytes + estimate > maxBudgetBytes) break
          usedBytes += estimate
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
  }, [messagesByBucket, settings.max_sync_kb, identity?.user_id])

  useEffect(() => {
    const onReceipt = (e: Event) => {
      const detail = (e as CustomEvent<IncomingEphemeralReceiptDetail>).detail
      if (!detail?.signing_pubkey || !detail?.chat_id || !detail?.message_id || !detail?.from_user_id) return
      if (detail.receipt_type !== 'delivered' && detail.receipt_type !== 'read') return
      setMessagesByBucket((prev) => {
        const key = bucketKey(detail.signing_pubkey, detail.chat_id)
        const list = prev[key]
        if (!list || list.length === 0) return prev
        let changed = false
        const nextList: EphemeralChatMessage[] = list.map((m) => {
          if (m.id !== detail.message_id) return m
          const deliveredBy = m.delivered_by ?? []
          const readBy = m.read_by ?? []
          if (detail.receipt_type === 'delivered') {
            if (deliveredBy.includes(detail.from_user_id)) return m
            changed = true
            const nextDelivered = [...deliveredBy, detail.from_user_id]
            const nextStatus: 'read' | 'delivered' =
              m.delivery_status === 'read' ? 'read' : 'delivered'
            return {
              ...m,
              delivered_by: nextDelivered,
              delivery_status: nextStatus,
            }
          }
          // read
          if (readBy.includes(detail.from_user_id)) return m
          changed = true
          const nextDelivered = deliveredBy.includes(detail.from_user_id)
            ? deliveredBy
            : [...deliveredBy, detail.from_user_id]
          return {
            ...m,
            delivered_by: nextDelivered,
            read_by: [...readBy, detail.from_user_id],
            delivery_status: 'read',
          }
        })
        if (!changed) return prev
        const next = { ...prev, [key]: nextList }
        return pruneBuckets(next, settings, Date.now())
      })
    }

    window.addEventListener('cordia:ephemeral-receipt-incoming', onReceipt as EventListener)
    return () => {
      window.removeEventListener('cordia:ephemeral-receipt-incoming', onReceipt as EventListener)
    }
  }, [settings])

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

      const attachment = await getAttachmentRecord(attachmentId).catch(() => null)
      if (!attachment) {
        window.dispatchEvent(new CustomEvent('cordia:send-attachment-transfer-response', {
          detail: { to_user_id: fromUserId, request_id: requestId, accepted: false },
        }))
        return
      }
      const approved = await confirmDialog(
        `${fromUserId} wants to download "${attachment.file_name}". Allow transfer now?`,
        {
          title: 'Attachment Transfer',
          type: 'info',
          okLabel: 'Allow',
          cancelLabel: 'Deny',
        }
      )
      if (!approved) {
        window.dispatchEvent(new CustomEvent('cordia:send-attachment-transfer-response', {
          detail: { to_user_id: fromUserId, request_id: requestId, accepted: false },
        }))
        return
      }

      const relatedMessage = Object.values(messagesByBucketRef.current)
        .flat()
        .find((m) => m.kind === 'attachment' && m.attachment?.attachment_id === attachmentId)
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
      const dc = pc.createDataChannel('cordia-attachment')
      dc.binaryType = 'arraybuffer'
      dc.onopen = async () => {
        try {
          upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), status: 'transferring' }))
          const bytes = await readAttachmentBytes(attachmentId)
          const total = bytes.byteLength
          dc.send(JSON.stringify({ type: 'meta', file_name: attachment.file_name, size_bytes: total, sha256: attachment.sha256 }))
          let sent = 0
          const chunkSize = 64 * 1024
          while (sent < total) {
            while (dc.bufferedAmount > 512 * 1024) {
              await new Promise((r) => setTimeout(r, 20))
            }
            const next = Math.min(total, sent + chunkSize)
            dc.send(bytes.slice(sent, next))
            sent = next
            const progress = total > 0 ? Math.min(1, sent / total) : 1
            upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), progress }))
          }
          dc.send(JSON.stringify({ type: 'done' }))
          upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), status: 'completed', progress: 1 }))
          cleanupTransferPeer(requestId)
        } catch (err) {
          upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), status: 'failed', error: String(err) }))
          cleanupTransferPeer(requestId)
        }
      }

      const offerSdp = await createOffer(pc)
      sendSignal(fromUserId, requestId, { type: 'offer', sdp: offerSdp })
    }

    const onIncomingResponse = async (e: Event) => {
      const detail = (e as CustomEvent<{ from_user_id?: string; request_id?: string; accepted?: boolean }>).detail
      const fromUserId = detail?.from_user_id?.trim()
      const requestId = detail?.request_id?.trim()
      if (!fromUserId || !requestId) return
      if (!detail?.accepted) {
        upsertTransfer(requestId, (prev) => ({ ...(prev as AttachmentTransferState), status: 'rejected' }))
        cleanupTransferPeer(requestId)
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
        dc.binaryType = 'arraybuffer'
        dc.onmessage = async (m) => {
          if (typeof m.data === 'string') {
            try {
              const control = JSON.parse(m.data) as { type?: string; file_name?: string; size_bytes?: number; sha256?: string }
              if (control.type === 'meta') {
                transferBuffersRef.current.set(requestId, [])
                transferExpectedSizeRef.current.set(requestId, Number(control.size_bytes ?? 0))
                upsertTransfer(requestId, (prev) => ({
                  ...(prev as AttachmentTransferState),
                  file_name: control.file_name || (prev?.file_name ?? 'attachment.bin'),
                  status: 'transferring',
                  progress: 0,
                }))
              }
              if (control.type === 'done') {
                const chunks = transferBuffersRef.current.get(requestId) ?? []
                const total = chunks.reduce((acc, c) => acc + c.byteLength, 0)
                const merged = new Uint8Array(total)
                let offset = 0
                for (const c of chunks) {
                  merged.set(c, offset)
                  offset += c.byteLength
                }
                const transfer = attachmentTransfersRef.current.find((t) => t.request_id === requestId)
                const savePath = await saveDownloadedAttachment(transfer?.file_name ?? 'attachment.bin', merged, undefined)
                upsertTransfer(requestId, (prev) => ({
                  ...(prev as AttachmentTransferState),
                  status: 'completed',
                  progress: 1,
                  saved_path: savePath,
                }))
                cleanupTransferPeer(requestId)
              }
            } catch {
              // ignore malformed control message
            }
            return
          }
          const chunk = new Uint8Array(m.data as ArrayBuffer)
          const current = transferBuffersRef.current.get(requestId) ?? []
          current.push(chunk)
          transferBuffersRef.current.set(requestId, current)
          const expected = transferExpectedSizeRef.current.get(requestId) ?? 0
          const got = current.reduce((acc, c) => acc + c.byteLength, 0)
          upsertTransfer(requestId, (prev) => ({
            ...(prev as AttachmentTransferState),
            progress: expected > 0 ? Math.min(1, got / expected) : 0,
          }))
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
  }, [identity?.user_id])

  const getMessages = (signingPubkey: string, chatId: string): EphemeralChatMessage[] => {
    if (!signingPubkey || !chatId) return []
    return messagesByBucket[bucketKey(signingPubkey, chatId)] ?? []
  }

  const sendMessage: EphemeralMessagesContextType['sendMessage'] = async ({
    serverId,
    signingPubkey,
    chatId,
    fromUserId,
    text,
  }) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const payload = JSON.stringify({ kind: 'text', text: trimmed })
    const encrypted_payload = await encryptEphemeralChatMessage(serverId, payload)
    const sentAt = new Date().toISOString()
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
      read_by: [],
    }
    setMessagesByBucket((prev) => {
      const next = appendMessage(prev, signingPubkey, chatId, localMessage)
      return pruneBuckets(next, settings, Date.now())
    })
  }

  const sendAttachmentMessage: EphemeralMessagesContextType['sendAttachmentMessage'] = async ({
    serverId,
    signingPubkey,
    chatId,
    fromUserId,
    attachment,
  }) => {
    if (!attachment?.attachment_id) return
    const payload = JSON.stringify({ kind: 'attachment', attachment })
    const encrypted_payload = await encryptEphemeralChatMessage(serverId, payload)
    const sentAt = new Date().toISOString()
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
      read_by: [],
    }
    setMessagesByBucket((prev) => {
      const next = appendMessage(prev, signingPubkey, chatId, localMessage)
      return pruneBuckets(next, settings, Date.now())
    })
  }

  const requestAttachmentDownload: EphemeralMessagesContextType['requestAttachmentDownload'] = async (msg) => {
    if (!identity?.user_id || !msg.attachment?.attachment_id || !msg.from_user_id || msg.from_user_id === identity.user_id) return
    const request_id = `${identity.user_id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    upsertTransfer(request_id, () => ({
      request_id,
      message_id: msg.id,
      attachment_id: msg.attachment!.attachment_id,
      from_user_id: msg.from_user_id,
      to_user_id: identity.user_id,
      file_name: msg.attachment!.file_name,
      direction: 'download',
      status: 'requesting',
      progress: 0,
    }))
    window.dispatchEvent(
      new CustomEvent('cordia:send-attachment-transfer-request', {
        detail: {
          to_user_id: msg.from_user_id,
          request_id,
          attachment_id: msg.attachment.attachment_id,
        },
      })
    )
  }

  const markMessagesRead: EphemeralMessagesContextType['markMessagesRead'] = (signingPubkey, chatId, messageIds) => {
    if (!identity?.user_id || messageIds.length === 0) return
    const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)))
    if (uniqueIds.length === 0) return
    setMessagesByBucket((prev) => {
      const key = bucketKey(signingPubkey, chatId)
      const list = prev[key]
      if (!list || list.length === 0) return prev
      let changed = false
      const nextList: EphemeralChatMessage[] = list.map((m) => {
        if (!uniqueIds.includes(m.id)) return m
        if (m.from_user_id === identity.user_id) return m
        const readBy = m.read_by ?? []
        const deliveredBy = m.delivered_by ?? []
        if (readBy.includes(identity.user_id)) return m
        changed = true
        const nextDelivered = deliveredBy.includes(identity.user_id)
          ? deliveredBy
          : [...deliveredBy, identity.user_id]
        return {
          ...m,
          delivered_by: nextDelivered,
          read_by: [...readBy, identity.user_id],
          delivery_status: m.delivery_status,
        }
      })
      if (!changed) return prev
      return { ...prev, [key]: nextList }
    })

    for (const message_id of uniqueIds) {
      window.dispatchEvent(
        new CustomEvent('cordia:send-ephemeral-receipt', {
          detail: {
            signing_pubkey: signingPubkey,
            chat_id: chatId,
            message_id,
            receipt_type: 'read',
          },
        })
      )
    }
  }

  const value = useMemo(
    () => ({
      getMessages,
      sendMessage,
      sendAttachmentMessage,
      requestAttachmentDownload,
      attachmentTransfers,
      markMessagesRead,
    }),
    [messagesByBucket, identity?.user_id, attachmentTransfers]
  )

  return <EphemeralMessagesContext.Provider value={value}>{children}</EphemeralMessagesContext.Provider>
}

export function useEphemeralMessages() {
  const ctx = useContext(EphemeralMessagesContext)
  if (!ctx) throw new Error('useEphemeralMessages must be used within an EphemeralMessagesProvider')
  return ctx
}
