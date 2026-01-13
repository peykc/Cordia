import { useEffect, useRef } from 'react'
import { useAccount } from '../contexts/AccountContext'
import { useSignaling } from '../contexts/SignalingContext'
import { fetchAndImportHouseHintOpaque, listHouses } from '../lib/tauri'

/**
 * Pull latest house metadata (members/rooms) from the signaling server after login.
 *
 * This is a minimal “sync-on-login” step so creators see new members even if they
 * haven't opened the house yet. It intentionally only updates metadata (no secrets).
 */
export function HouseSyncBootstrap() {
  const { sessionLoaded, currentAccountId } = useAccount()
  const { status: signalingStatus, signalingUrl } = useSignaling()
  const ranForSessionRef = useRef<string | null>(null)
  const isSyncingRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const subscribedSigningPubkeysRef = useRef<Set<string>>(new Set())

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
        } catch (e) {
          console.warn('[HouseSyncBootstrap] Failed to subscribe houses over WS:', e)
        }
      }

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'HouseHintUpdated') {
            const signingPubkey: string = msg.signing_pubkey
            // Only apply updates for houses we currently track
            if (!subscribedSigningPubkeysRef.current.has(signingPubkey)) return

            await fetchAndImportHouseHintOpaque(signalingUrl, signingPubkey)
            window.dispatchEvent(new Event('roommate:houses-updated'))
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

      window.addEventListener('roommate:house-removed', onHouseRemoved)
      window.addEventListener('roommate:houses-updated', onHousesUpdated)

      // Ensure listeners are cleaned up when the WS is replaced.
      const cleanupListeners = () => {
        window.removeEventListener('roommate:house-removed', onHouseRemoved)
        window.removeEventListener('roommate:houses-updated', onHousesUpdated)
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

