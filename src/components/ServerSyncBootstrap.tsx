import { useEffect, useRef } from 'react'
import { useAccount } from '../contexts/AccountContext'
import { useIdentity } from '../contexts/IdentityContext'
import { usePresence } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useBeacon } from '../contexts/BeaconContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { fetchAndImportServerHintOpaque, listServers, listFriends } from '../lib/tauri'

const DEBUG_LOG = (_payload: Record<string, unknown>) => { /* no-op: debug ingest removed */ }

/**
 * Pull latest server metadata (members/chats) from the beacon after login.
 *
 * This is a minimal "sync-on-login" step so creators see new members even if they
 * haven't opened the server yet. It intentionally only updates metadata (no secrets).
 */
export function ServerSyncBootstrap() {
  const { sessionLoaded, currentAccountId, accountInfoMap } = useAccount()
  const { identity } = useIdentity()
  const presence = usePresence()
  const voicePresence = useVoicePresence()
  const { beaconUrl } = useBeacon()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const ranForSessionRef = useRef<string | null>(null)
  const isSyncingRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const lastPongAtRef = useRef<number>(Date.now())
  const lastMessageAtRef = useRef<number>(Date.now())
  const heartbeatTimerRef = useRef<number | null>(null)
  const watchdogTimerRef = useRef<number | null>(null)
  const lastConnectStartAtRef = useRef<number>(0)
  const subscribedSigningPubkeysRef = useRef<Set<string>>(new Set())
  const activeSigningPubkeyRef = useRef<string | null>(null)
  const pendingOutboundRef = useRef<string[]>([])
  const profilePushRef = useRef({ profile, identity, accountInfoMap, currentAccountId })
  profilePushRef.current = { profile, identity, accountInfoMap, currentAccountId }

  useEffect(() => {
    // Only run when logged in + beacon URL exists
    if (!sessionLoaded || !currentAccountId) return
    if (!beaconUrl) return

    // Run once per active account/session
    if (ranForSessionRef.current === currentAccountId) return
    ranForSessionRef.current = currentAccountId

    let cancelled = false

    const syncOnce = async () => {
      if (isSyncingRef.current) return
      isSyncingRef.current = true
      try {
        const servers = await listServers()
        for (const s of servers) {
          if (cancelled) return
          try {
            await fetchAndImportServerHintOpaque(beaconUrl, s.signing_pubkey)
          } catch (e) {
            console.warn('[ServerSyncBootstrap] Failed to sync server hint:', e)
          }
        }

        window.dispatchEvent(new Event('cordia:servers-updated'))
      } catch (e) {
        console.warn('[ServerSyncBootstrap] Failed to list servers for sync:', e)
      } finally {
        isSyncingRef.current = false
      }
    }

    // Initial sync right after login
    syncOnce()

    // WS subscription for real-time updates
    const connectWs = async () => {
      // Prevent tight loops if something is repeatedly failing instantly.
      const now = Date.now()
      if (now - lastConnectStartAtRef.current < 500) return
      lastConnectStartAtRef.current = now

      // Clean up any previous connection
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (heartbeatTimerRef.current != null) {
        window.clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
      if (watchdogTimerRef.current != null) {
        window.clearInterval(watchdogTimerRef.current)
        watchdogTimerRef.current = null
      }

      const base = beaconUrl.replace(/\/$/, '')
      const wsUrl = base.endsWith('/ws') ? base : base + '/ws'
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      lastPongAtRef.current = Date.now()
      lastMessageAtRef.current = Date.now()

      const sendOrQueue = (payload: unknown) => {
        const serialized = JSON.stringify(payload)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(serialized)
          return
        }
        pendingOutboundRef.current.push(serialized)
        if (pendingOutboundRef.current.length > 500) {
          pendingOutboundRef.current = pendingOutboundRef.current.slice(-500)
        }
        if (!cancelled && beaconUrl) connectWs()
      }

      const sendProfileAnnounce = async (override?: {
        display_name: string | null
        real_name: string | null
        show_real_name: boolean
        updated_at: string | null
      }) => {
        if (!identity?.user_id) return
        if (ws.readyState !== WebSocket.OPEN) return
        try {
          const servers = await listServers()
          const signingPubkeys = servers.map(s => s.signing_pubkey)
          const dn =
            (override?.display_name ?? profile.display_name) || identity.display_name
          const show = Boolean(override?.show_real_name ?? profile.show_real_name)
          const rn = show ? (override?.real_name ?? profile.real_name) : null
          const updatedAt = override?.updated_at ?? profile.updated_at
          ws.send(
            JSON.stringify({
              type: 'ProfileAnnounce',
              user_id: identity.user_id,
              display_name: dn,
              real_name: rn,
              show_real_name: show,
              rev: Number(updatedAt ? Date.parse(updatedAt) : 0),
              signing_pubkeys: signingPubkeys,
            })
          )
        } catch (e) {
          // ignore
        }
      }

      const sendProfileHello = async () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        try {
          const servers = await listServers()
          for (const s of servers) {
            const ids = Array.from(new Set(s.members.map(m => m.user_id).filter(Boolean)))
            if (ids.length === 0) continue
            ws.send(
              JSON.stringify({
                type: 'ProfileHello',
                signing_pubkey: s.signing_pubkey,
                user_ids: ids,
              })
            )
          }
        } catch {
          // ignore
        }
      }

      const FRIENDS_SIGNING_PUBKEY = '_friends'
      const MAX_FRIEND_IDS = 100

      const sendProfileHelloForFriends = async () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        try {
          const friends = await listFriends()
          const userIds = Array.from(new Set(friends)).slice(0, MAX_FRIEND_IDS)
          if (userIds.length === 0) return
          ws.send(
            JSON.stringify({
              type: 'ProfileHello',
              signing_pubkey: FRIENDS_SIGNING_PUBKEY,
              user_ids: userIds,
            })
          )
        } catch {
          // ignore
        }
      }

      /** Push profile (including PFP) to online peers we care about (friends + server members + optional extras) via signaling */
      const sendProfilePush = async (
        override?: {
          display_name?: string | null
          real_name?: string | null
          show_real_name?: boolean
          updated_at?: string | null
          avatar_data_url?: string | null
          avatar_rev?: number
        },
        extraToUserIds?: string[]
      ) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        const { profile: p, identity: id, accountInfoMap: am, currentAccountId: cid } = profilePushRef.current
        if (!id?.user_id) return
        try {
          const [friends, servers] = await Promise.all([listFriends(), listServers()])
          const serverMemberIds = servers.flatMap((s) => (s.members ?? []).map((m) => m.user_id).filter(Boolean))
          const baseRecipients = [...friends, ...serverMemberIds]
          const toUserIds = extraToUserIds?.length
            ? [...new Set([...baseRecipients, ...extraToUserIds])]
            : [...new Set(baseRecipients)]
          const filteredRecipients = toUserIds.filter((uid) => uid && uid !== id.user_id).slice(0, 1000)
          if (filteredRecipients.length === 0) return
          const rev = override?.updated_at != null ? Date.parse(override.updated_at) : (p?.updated_at ? Date.parse(p.updated_at) : 0)
          const accountCreatedAt = cid && am[cid]?.created_at ? am[cid].created_at : null
          ws.send(
            JSON.stringify({
              type: 'ProfilePush',
              to_user_ids: filteredRecipients,
              display_name: override?.display_name ?? p?.display_name ?? id?.display_name ?? null,
              real_name: override?.show_real_name ? (override?.real_name ?? p?.real_name ?? null) : (p?.show_real_name ? (p?.real_name ?? null) : null),
              show_real_name: override?.show_real_name ?? Boolean(p?.show_real_name),
              rev: Number.isFinite(rev) ? rev : 0,
              avatar_data_url: override?.avatar_data_url !== undefined ? override.avatar_data_url : (p?.avatar_data_url ?? null),
              avatar_rev: override?.avatar_rev !== undefined ? override.avatar_rev : (p?.avatar_rev ?? null),
              account_created_at: accountCreatedAt,
            })
          )
        } catch {
          // ignore
        }
      }

      const sendPresenceHello = async (fromLabel: string) => {
        if (!identity?.user_id) return
        if (ws.readyState !== WebSocket.OPEN) return
        // #region agent log
        DEBUG_LOG({ location: 'ServerSyncBootstrap.tsx:sendPresenceHello', message: 'sendPresenceHello invoked', data: { from: fromLabel, readyState: ws.readyState }, hypothesisId: 'H2a' })
        // #endregion
        try {
          const [servers, friends] = await Promise.all([listServers(), listFriends()])
          const signingPubkeys = servers.map(s => s.signing_pubkey)
          const friend_user_ids = Array.from(new Set(friends)).slice(0, MAX_FRIEND_IDS)
          ws.send(
            JSON.stringify({
              type: 'PresenceHello',
              user_id: identity.user_id,
              signing_pubkeys: signingPubkeys,
              active_signing_pubkey: activeSigningPubkeyRef.current,
              friend_user_ids,
            })
          )
          await sendProfileHelloForFriends()
        } catch (e) {
          console.warn('[ServerSyncBootstrap] Failed to send presence hello:', e)
        }
      }

      const subscribeMissingServers = async () => {
        if (ws.readyState !== WebSocket.OPEN) return
        try {
          const servers = await listServers()
          const nextSet = new Set(subscribedSigningPubkeysRef.current)
          for (const s of servers) {
            if (nextSet.has(s.signing_pubkey)) continue
            nextSet.add(s.signing_pubkey)
            ws.send(
              JSON.stringify({
                type: 'Register',
                server_id: s.id,
                peer_id: `server-sync:${currentAccountId}:${s.id}`,
                signing_pubkey: s.signing_pubkey,
              })
            )
          }
          subscribedSigningPubkeysRef.current = nextSet
          // Presence set may have changed (new server joined/imported)
          await sendPresenceHello('subscribeMissingServers')
          sendProfileAnnounce()
          sendProfileHello()
          sendProfilePush()
        } catch (e) {
          console.warn('[ServerSyncBootstrap] Failed to resubscribe after server list change:', e)
        }
      }

      ws.onopen = async () => {
        reconnectAttemptRef.current = 0
        try {
          const servers = await listServers()
          const nextSet = new Set<string>()
          for (const s of servers) {
            nextSet.add(s.signing_pubkey)
            // Register subscription for this signing_pubkey (beacon uses it for ServerHintUpdated broadcasts)
            ws.send(
              JSON.stringify({
                type: 'Register',
                server_id: s.id,
                peer_id: `server-sync:${currentAccountId}:${s.id}`,
                signing_pubkey: s.signing_pubkey,
              })
            )
          }
          subscribedSigningPubkeysRef.current = nextSet
          // Announce presence after subscriptions are set up
          await sendPresenceHello('ws.onopen')
          await sendProfileAnnounce()
          await sendProfileHello()
          await sendProfilePush()

          // Flush any messages queued while reconnecting.
          if (pendingOutboundRef.current.length > 0) {
            const queued = pendingOutboundRef.current
            pendingOutboundRef.current = []
            for (const payload of queued) {
              if (ws.readyState !== WebSocket.OPEN) break
              ws.send(payload)
            }
          }
        } catch (e) {
          console.warn('[ServerSyncBootstrap] Failed to subscribe servers over WS:', e)
        }

        // Heartbeat: keep idle WS alive and detect dead peers.
        if (heartbeatTimerRef.current != null) window.clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = window.setInterval(() => {
          try {
            if (ws.readyState !== WebSocket.OPEN) return
            ws.send(JSON.stringify({ type: 'Ping' }))
          } catch {
            // ignore
          }
        }, 25000)

        // Watchdog: if no pong/messages for a while, force reconnect.
        if (watchdogTimerRef.current != null) window.clearInterval(watchdogTimerRef.current)
        watchdogTimerRef.current = window.setInterval(() => {
          if (cancelled) return
          const now = Date.now()
          const sincePong = now - lastPongAtRef.current
          const sinceMsg = now - lastMessageAtRef.current
          const stale = sincePong > 70000 || sinceMsg > 120000
          if (!stale) return
          try {
            ws.close()
          } catch {
            // ignore
          }
        }, 5000)
      }

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data)
          lastMessageAtRef.current = Date.now()
          if (msg.type === 'Pong') {
            lastPongAtRef.current = Date.now()
            return
          }
          if (msg.type === 'ServerHintUpdated') {
            const signingPubkey: string = msg.signing_pubkey

            // Try to import the hint - this will only succeed if we have the server locally
            // (because we need the symmetric key to decrypt). If we don't have it, the import
            // will fail gracefully and we can ignore the update.
            try {
              const imported = await fetchAndImportServerHintOpaque(beaconUrl, signingPubkey)

              // If we successfully imported, ensure we're subscribed for future updates
              if (imported && !subscribedSigningPubkeysRef.current.has(signingPubkey)) {
                subscribedSigningPubkeysRef.current.add(signingPubkey)
                if (ws.readyState === WebSocket.OPEN) {
                  // Find the server ID to register
                  const servers = await listServers().catch(() => [])
                  const server = servers.find(s => s.signing_pubkey === signingPubkey)
                  if (server) {
                    ws.send(
                      JSON.stringify({
                        type: 'Register',
                        server_id: server.id,
                        peer_id: `server-sync:${currentAccountId}:${server.id}`,
                        signing_pubkey: signingPubkey,
                      })
                    )
                  }
                }
              }

              // Only dispatch event if we actually imported something
              if (imported) {
                window.dispatchEvent(new Event('cordia:servers-updated'))
              }
            } catch (e) {
              // Server doesn't exist locally or can't decrypt - ignore silently
              // This is expected for servers we're not a member of
            }
            return
          }

          if (msg.type === 'PresenceSnapshot') {
            const spk: string = msg.signing_pubkey
            const users = msg.users as Array<{ user_id: string; active_signing_pubkey?: string | null }>
            presence.applySnapshot(spk, users)
            return
          }

          if (msg.type === 'PresenceUpdate') {
            const spk: string = msg.signing_pubkey
            const userId: string = msg.user_id
            const online: boolean = msg.online
            const active: string | null | undefined = msg.active_signing_pubkey
            // #region agent log
            DEBUG_LOG({ location: 'ServerSyncBootstrap.tsx:PresenceUpdate', message: 'PresenceUpdate received', data: { userId, online, spk: spk.slice(0, 8) }, hypothesisId: 'H2c' })
            // #endregion
            presence.applyUpdate(spk, userId, online, active ?? null)
            return
          }

          if (msg.type === 'VoicePresenceUpdate') {
            const spk: string = msg.signing_pubkey
            const userId: string = msg.user_id
            const chatId: string = msg.chat_id
            const inVoice: boolean = msg.in_voice
            voicePresence.applyUpdate(spk, userId, chatId, inVoice)
            return
          }

          if (msg.type === 'EphemeralChatIncoming') {
            window.dispatchEvent(
              new CustomEvent('cordia:ephemeral-chat-incoming', {
                detail: {
                  signing_pubkey: String(msg.signing_pubkey),
                  chat_id: String(msg.chat_id),
                  message_id: String(msg.message_id),
                  from_user_id: String(msg.from_user_id),
                  encrypted_payload: String(msg.encrypted_payload),
                  sent_at: String(msg.sent_at ?? new Date().toISOString()),
                },
              })
            )
            return
          }

          if (msg.type === 'EphemeralReceiptIncoming') {
            if (String(msg.receipt_type) !== 'delivered') {
              return
            }
            window.dispatchEvent(
              new CustomEvent('cordia:ephemeral-receipt-incoming', {
                detail: {
                  signing_pubkey: String(msg.signing_pubkey),
                  chat_id: String(msg.chat_id),
                  message_id: String(msg.message_id),
                  from_user_id: String(msg.from_user_id),
                  receipt_type: String(msg.receipt_type),
                  sent_at: String(msg.sent_at ?? new Date().toISOString()),
                },
              })
            )
            return
          }

          if (msg.type === 'ProfilePushIncoming') {
            remoteProfiles.applyUpdate({
              user_id: String(msg.from_user_id),
              display_name: String(msg.display_name ?? ''),
              secondary_name: msg.show_real_name ? (msg.real_name ?? null) : null,
              show_secondary: Boolean(msg.show_real_name),
              rev: Number(msg.rev ?? 0),
              account_created_at: msg.account_created_at ?? undefined,
              avatar_data_url: msg.avatar_data_url ?? undefined,
              avatar_rev: msg.avatar_rev ?? undefined,
            })
            return
          }

          if (msg.type === 'ProfileUpdate') {
            remoteProfiles.applyUpdate({
              user_id: String(msg.user_id),
              display_name: String(msg.display_name || ''),
              secondary_name: msg.show_real_name ? (msg.real_name ?? null) : null,
              show_secondary: Boolean(msg.show_real_name),
              rev: Number(msg.rev || 0),
            })
            return
          }

          if (msg.type === 'ProfileSnapshot') {
            const profiles = (msg.profiles as Array<any>) || []
            for (const p of profiles) {
              remoteProfiles.applyUpdate({
                user_id: String(p.user_id),
                display_name: String(p.display_name || ''),
                secondary_name: p.show_real_name ? (p.real_name ?? null) : null,
                show_secondary: Boolean(p.show_real_name),
                rev: Number(p.rev || 0),
              })
            }
            return
          }

          // Friend-related messages: dispatch for FriendsContext
          if (msg.type === 'FriendPendingSnapshot') {
            const pendingCodeRedemptions = msg.pending_code_redemptions ?? []
            window.dispatchEvent(
              new CustomEvent('cordia:friend-pending-snapshot', {
                detail: {
                  pending_incoming: msg.pending_incoming ?? [],
                  pending_outgoing: msg.pending_outgoing ?? [],
                  pending_code_redemptions: pendingCodeRedemptions,
                },
              })
            )
            // So redeemers see our name/PFP on their "Pending" row instead of "Unknown"
            const redeemerIds = pendingCodeRedemptions.map((r: { redeemer_user_id: string }) => r.redeemer_user_id).filter(Boolean)
            if (redeemerIds.length) sendProfilePush(undefined, redeemerIds)
            return
          }
          if (msg.type === 'FriendRequestIncoming') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-request-incoming', {
                detail: {
                  from_user_id: msg.from_user_id,
                  from_display_name: msg.from_display_name ?? null,
                  from_account_created_at: msg.from_account_created_at ?? null,
                },
              })
            )
            return
          }
          if (msg.type === 'FriendRequestAccepted') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-request-accepted', {
                detail: {
                  from_user_id: msg.from_user_id,
                  to_user_id: msg.to_user_id,
                  from_display_name: msg.from_display_name ?? null,
                  from_account_created_at: msg.from_account_created_at ?? null,
                },
              })
            )
            return
          }
          if (msg.type === 'FriendRequestDeclined') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-request-declined', {
                detail: { from_user_id: msg.from_user_id, to_user_id: msg.to_user_id },
              })
            )
            return
          }
          if (msg.type === 'FriendRequestCancelled') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-request-cancelled', {
                detail: { from_user_id: msg.from_user_id, to_user_id: msg.to_user_id },
              })
            )
            return
          }
          if (msg.type === 'FriendCodeRedemptionIncoming') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-code-redemption-incoming', {
                detail: {
                  redeemer_user_id: msg.redeemer_user_id,
                  redeemer_display_name: msg.redeemer_display_name ?? '',
                  redeemer_account_created_at: msg.redeemer_account_created_at ?? null,
                },
              })
            )
            // So redeemer sees our name/PFP on their "Pending" row instead of "Unknown"
            if (msg.redeemer_user_id) sendProfilePush(undefined, [msg.redeemer_user_id])
            return
          }
          if (msg.type === 'FriendCodeRedemptionAccepted') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-code-redemption-accepted', {
                detail: {
                  code_owner_id: msg.code_owner_id,
                  redeemer_user_id: msg.redeemer_user_id,
                  code_owner_display_name: msg.code_owner_display_name ?? null,
                  code_owner_account_created_at: msg.code_owner_account_created_at ?? null,
                },
              })
            )
            return
          }
          if (msg.type === 'FriendCodeRedemptionDeclined') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-code-redemption-declined', {
                detail: { code_owner_id: msg.code_owner_id, redeemer_user_id: msg.redeemer_user_id },
              })
            )
            return
          }
          if (msg.type === 'FriendCodeRedemptionCancelled') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-code-redemption-cancelled', {
                detail: { code_owner_id: msg.code_owner_id, redeemer_user_id: msg.redeemer_user_id },
              })
            )
            return
          }
          if (msg.type === 'FriendRemoved') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-removed', {
                detail: { from_user_id: msg.from_user_id },
              })
            )
            return
          }
          if (msg.type === 'FriendMutualCheckIncoming') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-mutual-check-incoming', {
                detail: { from_user_id: msg.from_user_id },
              })
            )
            return
          }
          if (msg.type === 'FriendMutualCheckReplyIncoming') {
            window.dispatchEvent(
              new CustomEvent('cordia:friend-mutual-check-reply-incoming', {
                detail: { from_user_id: msg.from_user_id, accepted: Boolean(msg.accepted) },
              })
            )
            return
          }
          if (msg.type === 'AttachmentTransferRequestIncoming') {
            window.dispatchEvent(
              new CustomEvent('cordia:attachment-transfer-request-incoming', {
                detail: {
                  from_user_id: String(msg.from_user_id),
                  request_id: String(msg.request_id),
                  attachment_id: String(msg.attachment_id),
                },
              })
            )
            return
          }
          if (msg.type === 'AttachmentTransferResponseIncoming') {
            window.dispatchEvent(
              new CustomEvent('cordia:attachment-transfer-response-incoming', {
                detail: {
                  from_user_id: String(msg.from_user_id),
                  request_id: String(msg.request_id),
                  accepted: Boolean(msg.accepted),
                },
              })
            )
            return
          }
          if (msg.type === 'AttachmentTransferSignalIncoming') {
            window.dispatchEvent(
              new CustomEvent('cordia:attachment-transfer-signal-incoming', {
                detail: {
                  from_user_id: String(msg.from_user_id),
                  request_id: String(msg.request_id),
                  signal: String(msg.signal),
                },
              })
            )
            return
          }
        } catch (e) {
          // Ignore malformed/unrelated messages
        }
      }

      ws.onerror = (e) => {
        console.warn('[ServerSyncBootstrap] WS error:', e)
        // Force close so onclose reconnect path always runs.
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close()
          }
        } catch {
          // ignore
        }
      }

      ws.onclose = () => {
        if (heartbeatTimerRef.current != null) {
          window.clearInterval(heartbeatTimerRef.current)
          heartbeatTimerRef.current = null
        }
        if (watchdogTimerRef.current != null) {
          window.clearInterval(watchdogTimerRef.current)
          watchdogTimerRef.current = null
        }

        // Best-effort reconnect while logged in
        if (!cancelled) {
          const attempt = reconnectAttemptRef.current
          reconnectAttemptRef.current = attempt + 1
          const baseDelay = Math.min(30000, 1000 * Math.pow(2, attempt))
          const jitter = Math.floor(Math.random() * 250)
          const delay = Math.max(1000, baseDelay + jitter)
          reconnectTimerRef.current = window.setTimeout(() => {
            if (!cancelled && beaconUrl) connectWs()
          }, delay)
        }
      }

      // If a server is removed locally, stop applying WS updates for it immediately (prevents re-import ghosts).
      const onServerRemoved = (ev: Event) => {
        const detail = (ev as CustomEvent<{ signing_pubkey?: string }>).detail
        const spk = detail?.signing_pubkey
        if (!spk) return
        const next = new Set(subscribedSigningPubkeysRef.current)
        next.delete(spk)
        subscribedSigningPubkeysRef.current = next
      }

      // If servers are added (join/import), subscribe without reconnecting.
      const onServersUpdated = () => {
        subscribeMissingServers()
      }

      const onActiveServerChanged = (ev: Event) => {
        const detail = (ev as CustomEvent<{ signing_pubkey?: string | null }>).detail
        const next = detail?.signing_pubkey ?? null
        activeSigningPubkeyRef.current = next
        if (!identity?.user_id) return
        sendOrQueue({
          type: 'PresenceActive',
          user_id: identity.user_id,
          active_signing_pubkey: next,
        })
      }

      const onSendEphemeralChat = (ev: Event) => {
        const detail = (ev as CustomEvent<{
          signing_pubkey?: string
          chat_id?: string
          message_id?: string
          encrypted_payload?: string
        }>).detail
        const signing_pubkey = detail?.signing_pubkey?.trim()
        const chat_id = detail?.chat_id?.trim()
        const message_id = detail?.message_id?.trim()
        const encrypted_payload = detail?.encrypted_payload?.trim()
        if (!signing_pubkey || !chat_id || !message_id || !encrypted_payload) return
        sendOrQueue({
          type: 'EphemeralChatSend',
          signing_pubkey,
          chat_id,
          message_id,
          encrypted_payload,
        })
      }

      const onSendEphemeralReceipt = (ev: Event) => {
        const detail = (ev as CustomEvent<{
          signing_pubkey?: string
          chat_id?: string
          message_id?: string
          receipt_type?: string
        }>).detail
        const signing_pubkey = detail?.signing_pubkey?.trim()
        const chat_id = detail?.chat_id?.trim()
        const message_id = detail?.message_id?.trim()
        const receipt_type = detail?.receipt_type?.trim()
        if (!signing_pubkey || !chat_id || !message_id || !receipt_type) return
        if (receipt_type !== 'delivered') return
        sendOrQueue({
          type: 'EphemeralReceiptSend',
          signing_pubkey,
          chat_id,
          message_id,
          receipt_type,
        })
      }

      const onSendFriendMutualCheck = (ev: Event) => {
        const detail = (ev as CustomEvent<{ to_user_id?: string }>).detail
        const to_user_id = detail?.to_user_id?.trim()
        if (!to_user_id) return
        sendOrQueue({
          type: 'FriendMutualCheck',
          to_user_id,
        })
      }

      const onSendFriendMutualReply = (ev: Event) => {
        const detail = (ev as CustomEvent<{ to_user_id?: string; accepted?: boolean }>).detail
        const to_user_id = detail?.to_user_id?.trim()
        if (!to_user_id) return
        sendOrQueue({
          type: 'FriendMutualCheckReply',
          to_user_id,
          accepted: Boolean(detail?.accepted),
        })
      }

      const onSendAttachmentTransferRequest = (ev: Event) => {
        const detail = (ev as CustomEvent<{ to_user_id?: string; request_id?: string; attachment_id?: string }>).detail
        const to_user_id = detail?.to_user_id?.trim()
        const request_id = detail?.request_id?.trim()
        const attachment_id = detail?.attachment_id?.trim()
        if (!to_user_id || !request_id || !attachment_id) return
        sendOrQueue({
          type: 'AttachmentTransferRequest',
          to_user_id,
          request_id,
          attachment_id,
        })
      }

      const onSendAttachmentTransferResponse = (ev: Event) => {
        const detail = (ev as CustomEvent<{ to_user_id?: string; request_id?: string; accepted?: boolean }>).detail
        const to_user_id = detail?.to_user_id?.trim()
        const request_id = detail?.request_id?.trim()
        if (!to_user_id || !request_id) return
        sendOrQueue({
          type: 'AttachmentTransferResponse',
          to_user_id,
          request_id,
          accepted: Boolean(detail?.accepted),
        })
      }

      const onSendAttachmentTransferSignal = (ev: Event) => {
        const detail = (ev as CustomEvent<{ to_user_id?: string; request_id?: string; signal?: string }>).detail
        const to_user_id = detail?.to_user_id?.trim()
        const request_id = detail?.request_id?.trim()
        const signal = detail?.signal?.trim()
        if (!to_user_id || !request_id || !signal) return
        sendOrQueue({
          type: 'AttachmentTransferSignal',
          to_user_id,
          request_id,
          signal,
        })
      }

      window.addEventListener('cordia:server-removed', onServerRemoved)
      window.addEventListener('cordia:servers-updated', onServersUpdated)
      const onFriendsUpdated = () => {
        sendPresenceHello('friends-updated').catch(() => {})
        // New friends (e.g. after accept) get our profile/PFP immediately
        sendProfilePush().catch(() => {})
      }
      window.addEventListener('cordia:friends-updated', onFriendsUpdated)
      const onProfileUpdated = (ev: Event) => {
        const detail = (ev as CustomEvent<any>).detail
        if (detail && typeof detail === 'object') {
          sendProfileAnnounce({
            display_name: detail.display_name ?? null,
            real_name: detail.real_name ?? null,
            show_real_name: Boolean(detail.show_real_name),
            updated_at: detail.updated_at ?? null,
          })
          sendProfilePush({
            display_name: detail.display_name,
            real_name: detail.real_name,
            show_real_name: detail.show_real_name,
            updated_at: detail.updated_at,
            avatar_data_url: detail.avatar_data_url,
            avatar_rev: detail.avatar_rev,
          })
        } else {
          // Fallback: send whatever the current context has (may be slightly delayed)
          setTimeout(() => sendProfileAnnounce(), 0)
          setTimeout(() => sendProfilePush(), 0)
        }
        // Re-announce presence so other clients see us (fixes gray dot after reconnect; also on settings save)
        sendPresenceHello('profile-updated')
      }
      window.addEventListener('cordia:profile-updated', onProfileUpdated as any)
      window.addEventListener('cordia:active-server-changed', onActiveServerChanged as any)
      window.addEventListener('cordia:send-ephemeral-chat', onSendEphemeralChat as EventListener)
      window.addEventListener('cordia:send-ephemeral-receipt', onSendEphemeralReceipt as EventListener)
      window.addEventListener('cordia:send-friend-mutual-check', onSendFriendMutualCheck as EventListener)
      window.addEventListener('cordia:send-friend-mutual-reply', onSendFriendMutualReply as EventListener)
      window.addEventListener('cordia:send-attachment-transfer-request', onSendAttachmentTransferRequest as EventListener)
      window.addEventListener('cordia:send-attachment-transfer-response', onSendAttachmentTransferResponse as EventListener)
      window.addEventListener('cordia:send-attachment-transfer-signal', onSendAttachmentTransferSignal as EventListener)

      // Ensure listeners are cleaned up when the WS is replaced.
      const cleanupListeners = () => {
        window.removeEventListener('cordia:server-removed', onServerRemoved)
        window.removeEventListener('cordia:servers-updated', onServersUpdated)
        window.removeEventListener('cordia:friends-updated', onFriendsUpdated)
        window.removeEventListener('cordia:profile-updated', onProfileUpdated as any)
        window.removeEventListener('cordia:active-server-changed', onActiveServerChanged as any)
        window.removeEventListener('cordia:send-ephemeral-chat', onSendEphemeralChat as EventListener)
        window.removeEventListener('cordia:send-ephemeral-receipt', onSendEphemeralReceipt as EventListener)
        window.removeEventListener('cordia:send-friend-mutual-check', onSendFriendMutualCheck as EventListener)
        window.removeEventListener('cordia:send-friend-mutual-reply', onSendFriendMutualReply as EventListener)
        window.removeEventListener('cordia:send-attachment-transfer-request', onSendAttachmentTransferRequest as EventListener)
        window.removeEventListener('cordia:send-attachment-transfer-response', onSendAttachmentTransferResponse as EventListener)
        window.removeEventListener('cordia:send-attachment-transfer-signal', onSendAttachmentTransferSignal as EventListener)
      }
      ws.addEventListener('close', cleanupListeners, { once: true })
      ws.addEventListener('error', cleanupListeners, { once: true })
    }

    connectWs()

    return () => {
      cancelled = true
      pendingOutboundRef.current = []
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (heartbeatTimerRef.current != null) {
        window.clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
      if (watchdogTimerRef.current != null) {
        window.clearInterval(watchdogTimerRef.current)
        watchdogTimerRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [sessionLoaded, currentAccountId, beaconUrl])

  return null
}
