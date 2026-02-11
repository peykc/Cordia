import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
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

export interface EphemeralChatMessage {
  id: string
  signing_pubkey: string
  chat_id: string
  from_user_id: string
  text: string
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
  markMessagesRead: (signingPubkey: string, chatId: string, messageIds: string[]) => void
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
  const [hydrated, setHydrated] = useState(false)

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
        const parsed = JSON.parse(plaintext) as { text?: string }
        const text = (parsed.text ?? '').trim()
        if (!text) return

        const msg: EphemeralChatMessage = {
          id: detail.message_id,
          signing_pubkey: detail.signing_pubkey,
          chat_id: detail.chat_id,
          from_user_id: detail.from_user_id,
          text,
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
          const payload = JSON.stringify({ text: m.text })
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

    const payload = JSON.stringify({ text: trimmed })
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
      markMessagesRead,
    }),
    [messagesByBucket, identity?.user_id]
  )

  return <EphemeralMessagesContext.Provider value={value}>{children}</EphemeralMessagesContext.Provider>
}

export function useEphemeralMessages() {
  const ctx = useContext(EphemeralMessagesContext)
  if (!ctx) throw new Error('useEphemeralMessages must be used within an EphemeralMessagesProvider')
  return ctx
}
