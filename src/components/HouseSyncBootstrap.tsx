import { useEffect, useRef } from 'react'
import { useAccount } from '../contexts/AccountContext'
import { useIdentity } from '../contexts/IdentityContext'
import { usePresence } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useSignaling } from '../contexts/SignalingContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { fetchAndImportHouseHintOpaque, listHouses } from '../lib/tauri'

/**
 * Pull latest house metadata (members/rooms) from the signaling server after login.
 *
 * This is a minimal “sync-on-login” step so creators see new members even if they
 * haven't opened the house yet. It intentionally only updates metadata (no secrets).
 */
export function HouseSyncBootstrap() {
  const { sessionLoaded, currentAccountId } = useAccount()
  const { identity } = useIdentity()
  const presence = usePresence()
  const voicePresence = useVoicePresence()
  const { status: signalingStatus, signalingUrl } = useSignaling()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const ranForSessionRef = useRef<string | null>(null)
  const isSyncingRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const subscribedSigningPubkeysRef = useRef<Set<string>>(new Set())
  const activeSigningPubkeyRef = useRef<string | null>(null)

  useEffect(() => {
    // Only run when logged in + signaling is reachable
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
        const houses = await listHouses()
        for (const h of houses) {
          if (cancelled) return
          try {
            await fetchAndImportHouseHintOpaque(signalingUrl, h.signing_pubkey)
          } catch (e) {
            console.warn('[HouseSyncBootstrap] Failed to sync house hint:', e)
          }
        }

        window.dispatchEvent(new Event('roommate:houses-updated'))
      } catch (e) {
        console.warn('[HouseSyncBootstrap] Failed to list houses for sync:', e)
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
          const houses = await listHouses()
          const signingPubkeys = houses.map(h => h.signing_pubkey)
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
          const houses = await listHouses()
          for (const h of houses) {
            const ids = Array.from(new Set(h.members.map(m => m.user_id).filter(Boolean)))
            if (ids.length === 0) continue
            ws.send(
              JSON.stringify({
                type: 'ProfileHello',
                signing_pubkey: h.signing_pubkey,
                user_ids: ids,
              })
            )
          }
        } catch {
          // ignore
        }
      }

      const sendPresenceHello = async () => {
        if (!identity?.user_id) return
        if (ws.readyState !== WebSocket.OPEN) return
        try {
          const houses = await listHouses()
          const signingPubkeys = houses.map(h => h.signing_pubkey)
          ws.send(
            JSON.stringify({
              type: 'PresenceHello',
              user_id: identity.user_id,
              signing_pubkeys: signingPubkeys,
              active_signing_pubkey: activeSigningPubkeyRef.current,
            })
          )
        } catch (e) {
          console.warn('[HouseSyncBootstrap] Failed to send presence hello:', e)
        }
      }

      const subscribeMissingHouses = async () => {
        if (ws.readyState !== WebSocket.OPEN) return
        try {
          const houses = await listHouses()
          const nextSet = new Set(subscribedSigningPubkeysRef.current)
          for (const h of houses) {
            if (nextSet.has(h.signing_pubkey)) continue
            nextSet.add(h.signing_pubkey)
            ws.send(
              JSON.stringify({
                type: 'Register',
                house_id: h.id,
                peer_id: `house-sync:${currentAccountId}:${h.id}`,
                signing_pubkey: h.signing_pubkey,
              })
            )
          }
          subscribedSigningPubkeysRef.current = nextSet
          // Presence set may have changed (new house joined/imported)
          sendPresenceHello()
          sendProfileAnnounce()
          sendProfileHello()
        } catch (e) {
          console.warn('[HouseSyncBootstrap] Failed to resubscribe after house list change:', e)
        }
      }

      ws.onopen = async () => {
        try {
          const houses = await listHouses()
          const nextSet = new Set<string>()
          for (const h of houses) {
            nextSet.add(h.signing_pubkey)
            // Register subscription for this signing_pubkey (server uses it for HouseHintUpdated broadcasts)
            ws.send(
              JSON.stringify({
                type: 'Register',
                house_id: h.id,
                peer_id: `house-sync:${currentAccountId}:${h.id}`,
                signing_pubkey: h.signing_pubkey,
              })
            )
          }
          subscribedSigningPubkeysRef.current = nextSet
          // Announce presence after subscriptions are set up
          await sendPresenceHello()
          await sendProfileAnnounce()
          await sendProfileHello()
        } catch (e) {
          console.warn('[HouseSyncBootstrap] Failed to subscribe houses over WS:', e)
        }
      }

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'HouseHintUpdated') {
            const signingPubkey: string = msg.signing_pubkey
            
            // Try to import the hint - this will only succeed if we have the house locally
            // (because we need the symmetric key to decrypt). If we don't have it, the import
            // will fail gracefully and we can ignore the update.
            try {
              const imported = await fetchAndImportHouseHintOpaque(signalingUrl, signingPubkey)
              
              // If we successfully imported, ensure we're subscribed for future updates
              if (imported && !subscribedSigningPubkeysRef.current.has(signingPubkey)) {
                subscribedSigningPubkeysRef.current.add(signingPubkey)
                if (ws.readyState === WebSocket.OPEN) {
                  // Find the house ID to register
                  const houses = await listHouses().catch(() => [])
                  const house = houses.find(h => h.signing_pubkey === signingPubkey)
                  if (house) {
                    ws.send(
                      JSON.stringify({
                        type: 'Register',
                        house_id: house.id,
                        peer_id: `house-sync:${currentAccountId}:${house.id}`,
                        signing_pubkey: signingPubkey,
                      })
                    )
                  }
                }
              }
              
              // Only dispatch event if we actually imported something
              if (imported) {
                window.dispatchEvent(new Event('roommate:houses-updated'))
              }
            } catch (e) {
              // House doesn't exist locally or can't decrypt - ignore silently
              // This is expected for houses we're not a member of
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
            presence.applyUpdate(spk, userId, online, active ?? null)
            return
          }

          if (msg.type === 'VoicePresenceUpdate') {
            const spk: string = msg.signing_pubkey
            const userId: string = msg.user_id
            const roomId: string = msg.room_id
            const inVoice: boolean = msg.in_voice
            voicePresence.applyUpdate(spk, userId, roomId, inVoice)
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
        console.warn('[HouseSyncBootstrap] WS error:', e)
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

      // If a house is removed locally, stop applying WS updates for it immediately (prevents re-import ghosts).
      const onHouseRemoved = (ev: Event) => {
        const detail = (ev as CustomEvent<{ signing_pubkey?: string }>).detail
        const spk = detail?.signing_pubkey
        if (!spk) return
        const next = new Set(subscribedSigningPubkeysRef.current)
        next.delete(spk)
        subscribedSigningPubkeysRef.current = next
      }

      // If houses are added (join/import), subscribe without reconnecting.
      const onHousesUpdated = () => {
        subscribeMissingHouses()
      }

      const onActiveHouseChanged = (ev: Event) => {
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

      window.addEventListener('roommate:house-removed', onHouseRemoved)
      window.addEventListener('roommate:houses-updated', onHousesUpdated)
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
      }
      window.addEventListener('roommate:profile-updated', onProfileUpdated as any)
      window.addEventListener('roommate:active-house-changed', onActiveHouseChanged as any)

      // Ensure listeners are cleaned up when the WS is replaced.
      const cleanupListeners = () => {
        window.removeEventListener('roommate:house-removed', onHouseRemoved)
        window.removeEventListener('roommate:houses-updated', onHousesUpdated)
        window.removeEventListener('roommate:profile-updated', onProfileUpdated as any)
        window.removeEventListener('roommate:active-house-changed', onActiveHouseChanged as any)
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

