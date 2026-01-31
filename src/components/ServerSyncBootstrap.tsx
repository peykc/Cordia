import { useEffect, useRef } from 'react'
import { useAccount } from '../contexts/AccountContext'
import { useIdentity } from '../contexts/IdentityContext'
import { usePresence } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useSignaling } from '../contexts/SignalingContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { fetchAndImportServerHintOpaque, listServers } from '../lib/tauri'
import { requestMicrophonePermission } from '../lib/audio'

const DEBUG_LOG = (_payload: Record<string, unknown>) => { /* no-op: debug ingest removed */ }

/**
 * Pull latest server metadata (members/chats) from the beacon after login.
 *
 * This is a minimal "sync-on-login" step so creators see new members even if they
 * haven't opened the server yet. It intentionally only updates metadata (no secrets).
 */
export function ServerSyncBootstrap() {
  const { sessionLoaded, currentAccountId } = useAccount()
  const { identity } = useIdentity()
  const presence = usePresence()
  const voicePresence = useVoicePresence()
  const { status: signalingStatus, signalingUrl } = useSignaling()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const ranForSessionRef = useRef<string | null>(null)
  const micPermissionRequestedRef = useRef(false)
  const isSyncingRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const subscribedSigningPubkeysRef = useRef<Set<string>>(new Set())
  const activeSigningPubkeyRef = useRef<string | null>(null)

  // Request microphone permission once when user is logged in so the prompt appears in one place
  useEffect(() => {
    if (!currentAccountId || micPermissionRequestedRef.current) return
    micPermissionRequestedRef.current = true
    requestMicrophonePermission()
  }, [currentAccountId])

  useEffect(() => {
    // Only run when logged in + beacon is reachable
    if (!sessionLoaded || !currentAccountId) return
    if (signalingStatus !== 'connected' || !signalingUrl) return

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
            await fetchAndImportServerHintOpaque(signalingUrl, s.signing_pubkey)
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
      // Clean up any previous connection
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }

      const ws = new WebSocket(signalingUrl)
      wsRef.current = ws

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

      const sendPresenceHello = async (fromLabel: string) => {
        if (!identity?.user_id) return
        if (ws.readyState !== WebSocket.OPEN) return
        // #region agent log
        DEBUG_LOG({ location: 'ServerSyncBootstrap.tsx:sendPresenceHello', message: 'sendPresenceHello invoked', data: { from: fromLabel, readyState: ws.readyState }, hypothesisId: 'H2a' })
        // #endregion
        try {
          const servers = await listServers()
          const signingPubkeys = servers.map(s => s.signing_pubkey)
          ws.send(
            JSON.stringify({
              type: 'PresenceHello',
              user_id: identity.user_id,
              signing_pubkeys: signingPubkeys,
              active_signing_pubkey: activeSigningPubkeyRef.current,
            })
          )
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
          sendPresenceHello('subscribeMissingServers')
          sendProfileAnnounce()
          sendProfileHello()
        } catch (e) {
          console.warn('[ServerSyncBootstrap] Failed to resubscribe after server list change:', e)
        }
      }

      ws.onopen = async () => {
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
        } catch (e) {
          console.warn('[ServerSyncBootstrap] Failed to subscribe servers over WS:', e)
        }
      }

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'ServerHintUpdated') {
            const signingPubkey: string = msg.signing_pubkey

            // Try to import the hint - this will only succeed if we have the server locally
            // (because we need the symmetric key to decrypt). If we don't have it, the import
            // will fail gracefully and we can ignore the update.
            try {
              const imported = await fetchAndImportServerHintOpaque(signalingUrl, signingPubkey)

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
        } catch (e) {
          // Ignore malformed/unrelated messages
        }
      }

      ws.onerror = (e) => {
        console.warn('[ServerSyncBootstrap] WS error:', e)
      }

      ws.onclose = () => {
        // Best-effort reconnect while logged in
        if (!cancelled) {
          setTimeout(() => {
            if (!cancelled && signalingStatus === 'connected' && signalingUrl) {
              connectWs()
            }
          }, 2000)
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
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(
          JSON.stringify({
            type: 'PresenceActive',
            user_id: identity.user_id,
            active_signing_pubkey: next,
          })
        )
      }

      window.addEventListener('cordia:server-removed', onServerRemoved)
      window.addEventListener('cordia:servers-updated', onServersUpdated)
      const onProfileUpdated = (ev: Event) => {
        const detail = (ev as CustomEvent<any>).detail
        if (detail && typeof detail === 'object') {
          sendProfileAnnounce({
            display_name: detail.display_name ?? null,
            real_name: detail.real_name ?? null,
            show_real_name: Boolean(detail.show_real_name),
            updated_at: detail.updated_at ?? null,
          })
        } else {
          // Fallback: send whatever the current context has (may be slightly delayed)
          setTimeout(() => sendProfileAnnounce(), 0)
        }
        // Re-announce presence so other clients see us (fixes gray dot after reconnect; also on settings save)
        sendPresenceHello('profile-updated')
      }
      window.addEventListener('roommate:profile-updated', onProfileUpdated as any)
      window.addEventListener('cordia:active-server-changed', onActiveServerChanged as any)

      // Ensure listeners are cleaned up when the WS is replaced.
      const cleanupListeners = () => {
        window.removeEventListener('cordia:server-removed', onServerRemoved)
        window.removeEventListener('cordia:servers-updated', onServersUpdated)
        window.removeEventListener('roommate:profile-updated', onProfileUpdated as any)
        window.removeEventListener('cordia:active-server-changed', onActiveServerChanged as any)
      }
      ws.addEventListener('close', cleanupListeners, { once: true })
      ws.addEventListener('error', cleanupListeners, { once: true })
    }

    connectWs()

    return () => {
      cancelled = true
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [sessionLoaded, currentAccountId, signalingStatus, signalingUrl])

  return null
}
