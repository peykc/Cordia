import { createContext, useContext, useState, useCallback, useRef, ReactNode, useEffect } from 'react'
import { InputLevelMeter } from '../lib/audio'
import {
  createPeerConnection,
  createOffer,
  createAnswer,
  handleAnswer,
  addIceCandidate,
  attachAudioTrack,
  createRemoteAudioElement,
  closePeerConnection,
  isLastPathP2P
} from '../lib/webrtc'
import {
  initReceiverAudio,
  getPrefs as getReceiverPrefs,
  setUserVolume as setReceiverUserVolume,
  setUserMuted as setReceiverUserMuted,
  type PerUserAudioPrefs
} from '../lib/receiverAudio'
import { useBeacon } from './BeaconContext'
import { useVoicePresence } from './VoicePresenceContext'
import { useSpeaking } from './SpeakingContext'
import { useIdentity } from './IdentityContext'
import { useProfile } from './ProfileContext'
import { useAccount } from './AccountContext'
import { useRemoteProfiles } from './RemoteProfilesContext'
import { RemoteAudioAnalyzer } from '../lib/remoteAudioAnalyzer'
import { loadAudioSettings } from '../lib/tauri'

/**
 * WebRTC Context for peer-to-peer voice communication.
 *
 * Architecture: Signaling and Media are SEPARATE planes.
 * - Signaling (WebSocket): Control plane for peer discovery and SDP/ICE exchange
 * - Media (RTCPeerConnection): Data plane for actual audio
 *
 * Key invariant: Signaling disconnects do NOT tear down media.
 * - WebSocket can drop and reconnect without affecting active calls
 * - Media teardown only happens on actual ICE failure or explicit leave
 * - Audio stack rebuild only happens when track is dead, not on signaling events
 */

// Keepalive interval for signaling WebSocket (prevents idle disconnects)
const SIGNALING_KEEPALIVE_INTERVAL_MS = 25000
// Let ICE pool warm before first offer (improves candidate selection; 100–200ms typical)
const ICE_OFFER_WARMUP_MS = 100

export type PeerConnectionState = RTCPeerConnectionState

export interface PeerConnectionInfo {
  peerId: string               // Ephemeral, for WebRTC routing
  userId: string               // Stable, for identity display
  connection: RTCPeerConnection
  remoteStream: MediaStream | null
  audioElement: HTMLAudioElement | null
  audioAnalyzer: RemoteAudioAnalyzer | null  // For voice activity detection
  connectionState: PeerConnectionState
}

interface WebRTCContextType {
  // Connection management
  joinVoice(roomId: string, houseId: string, userId: string, signingPubkey: string): Promise<void>
  leaveVoice(): void

  // Local controls
  toggleMute(): void
  setOutputDevice(deviceId: string): void

  // State
  isInVoice: boolean
  isLocalMuted: boolean
  peers: Map<string, PeerConnectionInfo>  // Keyed by peerId
  currentRoomId: string | null

  // Audio system
  inputLevelMeter: InputLevelMeter | null  // Shared meter for audio settings
  ensureAudioInitialized(onLevelUpdate: (level: number) => void): Promise<void>
  reinitializeAudio(deviceId: string | null, onLevelUpdate: (level: number) => void): Promise<void>
  hotSwapInputDevice(deviceId: string | null): Promise<void>
  stopAudio(): void

  // Receiver-side per-user volume & local mute (keyed by remote userId)
  remoteAudioPrefs: Record<string, PerUserAudioPrefs>
  setRemoteUserVolume(userId: string, volume: number): void
  setRemoteUserMuted(userId: string, muted: boolean): void
  getRemoteUserPrefs(userId: string): PerUserAudioPrefs
}

const WebRTCContext = createContext<WebRTCContextType | null>(null)

const PROFILE_P2P_CHANNEL = 'cordia-profile'

export function WebRTCProvider({ children }: { children: ReactNode }) {
  const { beaconUrl } = useBeacon()
  const voicePresence = useVoicePresence()
  const { setUserSpeaking } = useSpeaking()
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const { currentAccountId, accountInfoMap } = useAccount()
  const { applyUpdate: applyRemoteProfile } = useRemoteProfiles()

  // State
  const [isInVoice, setIsInVoice] = useState(false)
  const [isLocalMuted, setIsLocalMuted] = useState(false)
  const [peers, setPeers] = useState<Map<string, PeerConnectionInfo>>(new Map())
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null)
  const [inputLevelMeter, setInputLevelMeter] = useState<InputLevelMeter | null>(null)
  const [remoteAudioPrefs, setRemoteAudioPrefs] = useState<Record<string, PerUserAudioPrefs>>({})

  // Refs
  const inputLevelMeterRef = useRef<InputLevelMeter | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const currentRoomRef = useRef<string | null>(null)
  const currentHouseRef = useRef<string | null>(null)
  const currentPeerIdRef = useRef<string | null>(null)   // Ephemeral session ID
  const currentUserIdRef = useRef<string | null>(null)   // Stable identity
  const currentSigningPubkeyRef = useRef<string | null>(null)  // House signing pubkey
  const outputDeviceRef = useRef<string | null>(null)
  const isInVoiceRef = useRef<boolean>(false)            // For reconnect logic
  const peersRef = useRef<Map<string, PeerConnectionInfo>>(new Map())  // For message handlers
  const isRebuildingAudioRef = useRef<boolean>(false)    // Guard against concurrent rebuilds
  const keepaliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)  // Signaling keepalive
  const signalingConnectedRef = useRef<boolean>(false)   // Track signaling state separately from media
  const localAudioAnalyzerRef = useRef<RemoteAudioAnalyzer | null>(null)  // For self-speaking detection
  const cleanedPeersRef = useRef<Set<string>>(new Set())  // Track cleaned peers to prevent double cleanup
  const profileP2PRef = useRef<{ user_id: string; display_name: string; real_name: string | null; show_real_name: boolean; rev: number; account_created_at: string | null } | null>(null)
  // Per-peer recovery: ICE disconnected → try restart after delay; failed → delayed cleanup so restart can recover
  const peerRecoveryRef = useRef<Map<string, { disconnectTimer: ReturnType<typeof setTimeout> | null; failedTimer: ReturnType<typeof setTimeout> | null }>>(new Map())
  // One ICE restart per failure when path was P2P (avoid restart loop)
  const peerRestartedOnFailureRef = useRef<Set<string>>(new Set())

  // Keep profile payload for P2P send (avoid stale closure when data channel opens)
  useEffect(() => {
    if (!identity?.user_id) {
      profileP2PRef.current = null
      return
    }
    const dn = profile?.display_name ?? identity.display_name ?? ''
    const show = Boolean(profile?.show_real_name)
    const rn = show ? (profile?.real_name ?? null) : null
    const rev = profile?.updated_at ? Date.parse(profile.updated_at) : 0
    const accountCreatedAt = currentAccountId && accountInfoMap[currentAccountId]?.created_at ? accountInfoMap[currentAccountId].created_at : null
    profileP2PRef.current = {
      user_id: identity.user_id,
      display_name: dn,
      real_name: rn,
      show_real_name: show,
      rev: Number.isFinite(rev) ? rev : 0,
      account_created_at: accountCreatedAt ?? null,
    }
  }, [identity?.user_id, identity?.display_name, profile?.display_name, profile?.show_real_name, profile?.real_name, profile?.updated_at, currentAccountId, accountInfoMap])

  // Keep peersRef in sync with state
  useEffect(() => {
    peersRef.current = peers
  }, [peers])

  // Init receiver-side per-user audio prefs from storage
  useEffect(() => {
    initReceiverAudio()
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      leaveVoiceInternal()
    }
  }, [])

  // Ensure audio is initialized (safe during calls - only creates if missing)
  const ensureAudioInitialized = useCallback(async (onLevelUpdate: (level: number) => void): Promise<void> => {
    // Check if meter exists AND its stream is still live
    if (inputLevelMeterRef.current) {
      const transmissionStream = inputLevelMeterRef.current.getTransmissionStream()
      const audioTracks = transmissionStream?.getAudioTracks() || []
      const isStreamLive = audioTracks.length > 0 && audioTracks[0].readyState === 'live'
      
      if (isStreamLive) {
        console.log('[Audio] Meter already exists with live stream, skipping initialization')
        return
      } else {
        console.log('[Audio] Meter exists but stream is not live, reinitializing...')
        // Stream is dead, stop and recreate
        inputLevelMeterRef.current.stop()
        inputLevelMeterRef.current = null
        setInputLevelMeter(null)
      }
    }

    console.log('[Audio] Creating new audio meter')

    // Load current audio settings
    const audioSettings = await loadAudioSettings()

    // Create new meter
    const newMeter = new InputLevelMeter()
    await newMeter.start(
      audioSettings.input_device_id || null,
      onLevelUpdate
    )

    // Apply saved settings
    newMeter.setGain(audioSettings.input_volume)
    newMeter.setThreshold(audioSettings.input_sensitivity)
    newMeter.setInputMode(audioSettings.input_mode)

    inputLevelMeterRef.current = newMeter
    setInputLevelMeter(newMeter)  // Update state so context consumers get notified
    console.log('[Audio] Audio meter created and ready')
  }, [])

  // Reinitialize audio (DANGEROUS during calls - only use when NOT in voice)
  const reinitializeAudio = useCallback(async (deviceId: string | null, onLevelUpdate: (level: number) => void): Promise<void> => {
    if (isInVoiceRef.current) {
      console.error('[Audio] Cannot reinitialize audio during active call - device changes require hot-swap')
      throw new Error('Cannot change audio device during active call')
    }

    console.log('[Audio] Reinitializing audio system with device:', deviceId || 'OS default')

    // Stop existing meter if any
    if (inputLevelMeterRef.current) {
      console.log('[Audio] Stopping existing meter')
      inputLevelMeterRef.current.stop()
      inputLevelMeterRef.current = null
      setInputLevelMeter(null)
    }

    // Load current audio settings
    const audioSettings = await loadAudioSettings()

    // Create new meter
    const newMeter = new InputLevelMeter()
    await newMeter.start(
      deviceId || audioSettings.input_device_id || null,
      onLevelUpdate
    )

    // Apply saved settings
    newMeter.setGain(audioSettings.input_volume)
    newMeter.setThreshold(audioSettings.input_sensitivity)
    newMeter.setInputMode(audioSettings.input_mode)

    inputLevelMeterRef.current = newMeter
    setInputLevelMeter(newMeter)  // Update state so context consumers get notified
    console.log('[Audio] Audio system reinitialized - meter ready')
  }, [])

  const stopAudio = useCallback(() => {
    if (inputLevelMeterRef.current) {
      console.log('[Audio] Stopping audio system')
      inputLevelMeterRef.current.stop()
      inputLevelMeterRef.current = null
      setInputLevelMeter(null)  // Update state
    }
  }, [])

  /**
   * Hot-swap input device during active call.
   * Uses RTCRtpSender.replaceTrack() to change device without disconnecting.
   *
   * @throws Error if swap fails - safe to retry or fallback to manual rejoin
   */
  const hotSwapInputDevice = useCallback(async (newDeviceId: string | null): Promise<void> => {
    if (!isInVoiceRef.current) {
      // Not in call - use normal reinitialize path
      await reinitializeAudio(newDeviceId, () => {})
      return
    }

    console.log('[Audio] Hot-swapping input device during call:', newDeviceId)

    // Step 1: Validate preconditions
    const oldMeter = inputLevelMeterRef.current
    if (!oldMeter) throw new Error('No existing meter')

    const oldStream = localStreamRef.current
    if (!oldStream) throw new Error('No local stream')

    const oldTrack = oldStream.getAudioTracks()[0]
    if (!oldTrack || oldTrack.readyState !== 'live') {
      throw new Error('Old track not live')
    }

    // Step 2: Collect all RTCRtpSenders that need track swap
    const senders: Array<{ peerId: string; sender: RTCRtpSender }> = []

    for (const [peerId, peerInfo] of peersRef.current) {
      const pc = peerInfo.connection
      const audioSenders = pc.getSenders().filter(s => s.track?.kind === 'audio')

      if (audioSenders.length === 0) {
        console.warn(`[Audio] Peer ${peerId} has no audio sender (may still be connecting)`)
        continue
      }

      if (audioSenders.length > 1) {
        console.warn(`[Audio] Peer ${peerId} has multiple audio senders - using first`)
      }

      senders.push({ peerId, sender: audioSenders[0] })
    }

    if (senders.length === 0) {
      console.log('[Audio] No active peer connections, using normal reinit')
      await reinitializeAudio(newDeviceId, () => {})
      return
    }

    console.log(`[Audio] Found ${senders.length} peer(s) to update`)

    // Step 3: Create new meter with new device
    const audioSettings = await loadAudioSettings()
    const newMeter = new InputLevelMeter()

    try {
      await newMeter.start(newDeviceId, () => {})

      // Apply current settings to new meter
      newMeter.setGain(audioSettings.input_volume)
      newMeter.setThreshold(audioSettings.input_sensitivity)
      newMeter.setInputMode(audioSettings.input_mode)

      console.log('[Audio] New meter created with device:', newDeviceId)
    } catch (error) {
      console.error('[Audio] Failed to create new meter:', error)
      newMeter.stop()
      throw new Error(`Failed to initialize device: ${error}`)
    }

    // Step 4: Get new track and verify it's live
    const newStream = newMeter.getTransmissionStream()
    if (!newStream) {
      console.error('[Audio] New meter has no transmission stream')
      newMeter.stop()
      throw new Error('New meter has no transmission stream')
    }

    const newTrack = newStream.getAudioTracks()[0]
    if (!newTrack) {
      console.error('[Audio] New stream has no audio track')
      newMeter.stop()
      throw new Error('New stream has no audio track')
    }

    if (newTrack.readyState !== 'live') {
      console.error('[Audio] New track not live:', newTrack.readyState)
      newMeter.stop()
      throw new Error(`New track not live: ${newTrack.readyState}`)
    }

    console.log('[Audio] New track verified live:', {
      id: newTrack.id,
      label: newTrack.label,
      readyState: newTrack.readyState,
      enabled: newTrack.enabled
    })

    // Step 5: Replace track on all senders (CRITICAL SECTION)
    const successfulPeers: string[] = []
    const failedPeers: Array<{ peerId: string; error: any }> = []

    for (const { peerId, sender } of senders) {
      try {
        console.log(`[Audio] Swapping track for peer ${peerId}...`)
        await sender.replaceTrack(newTrack)
        successfulPeers.push(peerId)
        console.log(`[Audio] ✓ Track swapped for peer ${peerId}`)
      } catch (error) {
        console.error(`[Audio] ✗ Failed to swap track for peer ${peerId}:`, error)
        failedPeers.push({ peerId, error })
      }
    }

    // Step 6: Handle partial failures - rollback ALL if ANY failed
    if (failedPeers.length > 0) {
      console.error(`[Audio] Track swap failed for ${failedPeers.length}/${senders.length} peer(s)`)
      console.log('[Audio] Rolling back successful swaps...')

      // Attempt rollback
      for (const peerId of successfulPeers) {
        const sender = senders.find(s => s.peerId === peerId)?.sender
        if (sender) {
          try {
            await sender.replaceTrack(oldTrack)
            console.log(`[Audio] ✓ Rolled back peer ${peerId}`)
          } catch (rollbackError) {
            console.error(`[Audio] ✗ Rollback failed for peer ${peerId}:`, rollbackError)
            // Can't recover - this peer is now in inconsistent state
          }
        }
      }

      // Clean up new meter
      newMeter.stop()

      // Throw error with details
      const errorMsg = `Failed to swap device for ${failedPeers.length} peer(s): ${
        failedPeers.map(f => `${f.peerId} (${f.error.message})`).join(', ')
      }`
      throw new Error(errorMsg)
    }

    // Step 7: Success! Update refs and stop old meter
    console.log('[Audio] ✓ All tracks swapped successfully')

    // Update context refs
    inputLevelMeterRef.current = newMeter
    setInputLevelMeter(newMeter)
    localStreamRef.current = newStream

    // Stop old meter LAST (only after all swaps confirmed)
    console.log('[Audio] Stopping old meter')
    oldMeter.stop()

    console.log('[Audio] ✓ Device hot-swap complete')
  }, [reinitializeAudio])

  const setOutputDevice = useCallback((deviceId: string) => {
    outputDeviceRef.current = deviceId
    peersRef.current.forEach((peerInfo) => {
      if (peerInfo.audioElement && 'setSinkId' in peerInfo.audioElement) {
        (peerInfo.audioElement as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
          .setSinkId(deviceId)
          .catch((e: Error) => console.warn('[WebRTC] setSinkId failed:', e))
      }
    })
  }, [])

  const toggleMute = useCallback(() => {
    const meter = inputLevelMeterRef.current
    if (!meter) return

    const newMutedState = !isLocalMuted
    setIsLocalMuted(newMutedState)

    // Update InputLevelMeter to gate transmission (overrides VAD/PTT)
    meter.setTransmissionMuted(newMutedState)

    console.log(`[WebRTC] ${newMutedState ? 'Muted' : 'Unmuted'} local audio`)
  }, [isLocalMuted])

  // Complete cleanup of a single peer connection
  const cleanupPeerConnection = useCallback((peerId: string, peerInfo: PeerConnectionInfo) => {
    // Prevent double cleanup
    if (cleanedPeersRef.current.has(peerId)) {
      console.log(`[WebRTC] Peer ${peerId} already cleaned up, skipping`)
      return
    }
    cleanedPeersRef.current.add(peerId)

    // Clear any ICE recovery timers so we don't fire after cleanup
    const entry = peerRecoveryRef.current.get(peerId)
    if (entry) {
      if (entry.disconnectTimer !== null) clearTimeout(entry.disconnectTimer)
      if (entry.failedTimer !== null) clearTimeout(entry.failedTimer)
      peerRecoveryRef.current.delete(peerId)
    }
    peerRestartedOnFailureRef.current.delete(peerId)

    console.log(`[WebRTC] Cleaning up peer ${peerId} (user ${peerInfo.userId})`)

    // Stop audio analyzer
    if (peerInfo.audioAnalyzer) {
      peerInfo.audioAnalyzer.stop()
      // Clear speaking state for this user (defer to avoid updating during render)
      setTimeout(() => {
        setUserSpeaking(peerInfo.userId, false)
      }, 0)
    }

    // Stop remote playback (prefs are kept for next time they join)
    if (peerInfo.audioElement) {
      peerInfo.audioElement.pause()
      peerInfo.audioElement.srcObject = null
      peerInfo.audioElement.remove()
    }

    // Close connection - remove all event handlers first
    if (peerInfo.connection) {
      peerInfo.connection.ontrack = null
      peerInfo.connection.onicecandidate = null
      peerInfo.connection.onconnectionstatechange = null
      peerInfo.connection.oniceconnectionstatechange = null
      closePeerConnection(peerInfo.connection)
    }
  }, [setUserSpeaking])

  // Find peer by user_id (for handling reconnects)
  const findPeerByUserId = useCallback((userId: string): PeerConnectionInfo | undefined => {
    for (const [_, info] of peersRef.current) {
      if (info.userId === userId) return info
    }
    return undefined
  }, [])

  const clearRecoveryTimers = useCallback((peerId: string) => {
    const entry = peerRecoveryRef.current.get(peerId)
    if (entry) {
      if (entry.disconnectTimer !== null) clearTimeout(entry.disconnectTimer)
      if (entry.failedTimer !== null) clearTimeout(entry.failedTimer)
      peerRecoveryRef.current.delete(peerId)
    }
  }, [])

  const tryIceRestart = useCallback(async (peerId: string) => {
    const peerInfo = peersRef.current.get(peerId)
    if (!peerInfo || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const roomId = currentRoomRef.current
    if (!roomId) return
    try {
      await new Promise(r => setTimeout(r, ICE_OFFER_WARMUP_MS))
      const pc = peerInfo.connection
      const offerSdp = await (
        typeof (pc as RTCPeerConnection & { restartIce?: () => void }).restartIce === 'function'
          ? (async () => {
              ;(pc as RTCPeerConnection & { restartIce: () => void }).restartIce()
              return createOffer(pc)
            })()
          : createOffer(pc, { iceRestart: true })
      )
      wsRef.current.send(JSON.stringify({
        type: 'VoiceOffer',
        from_peer: currentPeerIdRef.current,
        from_user: currentUserIdRef.current,
        to_peer: peerId,
        chat_id: roomId,
        sdp: offerSdp
      }))
      console.log('[Media] Sent ICE restart offer to peer=', peerId)
    } catch (e) {
      console.warn('[Media] ICE restart offer failed:', e)
    }
  }, [])

  const handlePeerDisconnect = useCallback((remotePeerId: string) => {
    console.log(`[Media] Peer ${remotePeerId} disconnected - cleaning up connection`)
    setPeers(prev => {
      const updated = new Map(prev)
      const peerInfo = updated.get(remotePeerId)
      if (peerInfo) {
        cleanupPeerConnection(remotePeerId, peerInfo)
        updated.delete(remotePeerId)
      }
      return updated
    })
  }, [cleanupPeerConnection])

  const createPeerConnectionForPeer = useCallback(async (remotePeerId: string, remoteUserId: string): Promise<RTCPeerConnection> => {
    const pc = createPeerConnection()
    const roomId = currentRoomRef.current

    // P2P profile channel: receive peer profile (account_created_at, etc.) without using signaling server
    pc.ondatachannel = (e) => {
      const channel = e.channel
      if (channel.label !== PROFILE_P2P_CHANNEL) return
      channel.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string)
          if (msg.type !== 'ProfileP2P' || !msg.user_id) return
          applyRemoteProfile({
            user_id: String(msg.user_id),
            display_name: String(msg.display_name ?? ''),
            secondary_name: msg.show_real_name ? (msg.real_name ?? null) : null,
            show_secondary: Boolean(msg.show_real_name),
            rev: Number(msg.rev ?? 0),
            account_created_at: msg.account_created_at ?? null,
          })
        } catch (_) {
          // ignore parse errors
        }
      }
      // Answerer also sends our profile when channel opens so peer gets account_created_at etc.
      channel.onopen = () => {
        const payload = profileP2PRef.current
        if (payload) {
          try {
            channel.send(JSON.stringify({
              type: 'ProfileP2P',
              user_id: payload.user_id,
              display_name: payload.display_name,
              real_name: payload.real_name,
              show_real_name: payload.show_real_name,
              rev: payload.rev,
              account_created_at: payload.account_created_at,
            }))
          } catch (_) {
            // ignore
          }
        }
      }
    }

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        const message = {
          type: 'VoiceIceCandidate',
          from_peer: currentPeerIdRef.current,
          to_peer: remotePeerId,
          chat_id: roomId,
          candidate: JSON.stringify(event.candidate)
        }
        wsRef.current.send(JSON.stringify(message))
        // Don't log every ICE candidate - too noisy
      }
    }

    // Handle ICE connection state changes: try recovery before giving up (long calls / flaky networks)
    const DISCONNECT_RECOVERY_MS = 6_000   // After 6s disconnected, try ICE restart (fast recovery attempt)
    const FAILED_CLEANUP_MS = 30_000       // After 30s failed, give up and cleanup (longer tolerance before drop)
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      console.log(`[Media] ICE state for peer=${remotePeerId}: ${state}`)

      if (state === 'connected' || state === 'completed') {
        clearRecoveryTimers(remotePeerId)
        peerRestartedOnFailureRef.current.delete(remotePeerId)
        console.log(`[Media] ICE connected for peer ${remotePeerId} - media flowing`)
        return
      }

      if (state === 'checking') {
        // ICE is re-checking (e.g. disconnected → checking → connected). Cancel disconnect timer so we
        // don't trigger an unnecessary restart while it may self-recover; avoids extra renegotiations and glitches.
        const entry = peerRecoveryRef.current.get(remotePeerId)
        if (entry && entry.disconnectTimer !== null) {
          clearTimeout(entry.disconnectTimer)
          peerRecoveryRef.current.set(remotePeerId, { disconnectTimer: null, failedTimer: entry.failedTimer })
        }
        return
      }

      if (state === 'disconnected') {
        console.warn(`[Media] ICE disconnected for peer ${remotePeerId} - will try ICE restart if still down after 6s`)
        let entry = peerRecoveryRef.current.get(remotePeerId)
        if (!entry) {
          entry = { disconnectTimer: null, failedTimer: null }
          peerRecoveryRef.current.set(remotePeerId, entry)
        }
        if (entry.disconnectTimer !== null) clearTimeout(entry.disconnectTimer)
        entry.disconnectTimer = setTimeout(() => {
          entry = peerRecoveryRef.current.get(remotePeerId)
          if (entry) entry.disconnectTimer = null
          const info = peersRef.current.get(remotePeerId)
          const iceState = info?.connection.iceConnectionState
          // Only restart if still disconnected/failed; skip if 'checking' (self-recovery in progress)
          if (info && iceState !== 'connected' && iceState !== 'completed' && iceState !== 'checking') {
            console.log(`[Media] Trying ICE restart for peer ${remotePeerId}`)
            tryIceRestart(remotePeerId)
          }
        }, DISCONNECT_RECOVERY_MS)
        return
      }

      if (state === 'failed') {
        console.error(`[Media] ICE FAILED for peer ${remotePeerId} - will cleanup in 30s unless recovered`)
        let entry = peerRecoveryRef.current.get(remotePeerId)
        if (!entry) {
          entry = { disconnectTimer: null, failedTimer: null }
          peerRecoveryRef.current.set(remotePeerId, entry)
        }
        if (entry.failedTimer !== null) clearTimeout(entry.failedTimer)
        entry.failedTimer = setTimeout(() => {
          entry = peerRecoveryRef.current.get(remotePeerId)
          if (entry) entry.failedTimer = null
          if (peersRef.current.has(remotePeerId)) {
            console.error(`[Media] Peer ${remotePeerId} still failed after recovery window - cleaning up`)
            handlePeerDisconnect(remotePeerId)
          }
        }, FAILED_CLEANUP_MS)
        if (!peerRestartedOnFailureRef.current.has(remotePeerId)) {
          isLastPathP2P(pc).then((p2p) => {
            if (p2p && peersRef.current.has(remotePeerId)) {
              peerRestartedOnFailureRef.current.add(remotePeerId)
              console.log(`[Media] Last path was P2P - trying immediate ICE restart for peer ${remotePeerId}`)
              tryIceRestart(remotePeerId)
            }
          }).catch(() => {})
        }
      }
    }

    // Handle connection state changes (update UI; cleanup is driven by ICE failed timer above)
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      console.log(`[Media] Connection state for peer=${remotePeerId}: ${state}`)

      setPeers(prev => {
        const updated = new Map(prev)
        const peerInfo = updated.get(remotePeerId)
        if (peerInfo) {
          updated.set(remotePeerId, { ...peerInfo, connectionState: state })
        }
        return updated
      })
      // Do not cleanup here - ICE failed timer handles delayed cleanup so ICE restart can recover first
    }

    // Handle remote audio track: play via HTMLAudioElement (reliable in Tauri/WebView2). Per-user volume/mute via element.volume.
    pc.ontrack = (event) => {
      console.log(`[Media] Received remote track from peer=${remotePeerId}`)
      console.log(`[Media] Track: kind=${event.track.kind}, enabled=${event.track.enabled}, readyState=${event.track.readyState}`)
      const remoteStream = event.streams[0]

      if (remoteStream) {
        const prefs = getReceiverPrefs(remoteUserId)
        const audioElement = createRemoteAudioElement(remoteStream, outputDeviceRef.current || undefined)
        audioElement.volume = prefs.muted ? 0 : Math.max(0, Math.min(2, prefs.volume))
        console.log(`[Media] Created audio element for peer=${remotePeerId}`)

        let audioAnalyzer: RemoteAudioAnalyzer | null = null
        try {
          audioAnalyzer = new RemoteAudioAnalyzer(
            remoteStream,
            (isSpeaking: boolean) => setUserSpeaking(remoteUserId, isSpeaking)
          )
          console.log(`[Media] Created audio analyzer for peer=${remotePeerId}`)
        } catch (error) {
          console.warn(`[Media] Failed to create audio analyzer for peer=${remotePeerId}:`, error)
        }

        event.track.onunmute = () => {
          console.log(`[Media] Remote track unmuted for peer=${remotePeerId}`)
        }

        setPeers(prev => {
          const updated = new Map(prev)
          const peerInfo = updated.get(remotePeerId)
          if (peerInfo) {
            updated.set(remotePeerId, {
              ...peerInfo,
              remoteStream,
              audioElement,
              audioAnalyzer
            })
          }
          return updated
        })
        setRemoteAudioPrefs((prev) => ({ ...prev, [remoteUserId]: getReceiverPrefs(remoteUserId) }))
      } else {
        console.error('[Media] No stream in ontrack event!')
      }
    }

    // Attach local audio track - rebuild audio stack ONLY if track is dead
    // NOTE: This is the ONLY place audio rebuild should happen during a call
    let localStream = localStreamRef.current
    let needsRebuild = false

    if (localStream) {
      const audioTracks = localStream.getAudioTracks()
      if (audioTracks.length > 0) {
        const track = audioTracks[0]
        console.log(`[Media] Local track: readyState=${track.readyState}, enabled=${track.enabled}`)
        if (track.readyState === 'ended') {
          console.warn('[Media] Local audio track is ENDED - need to rebuild audio stack')
          needsRebuild = true
        }
      } else {
        console.warn('[Media] No audio tracks in local stream')
        needsRebuild = true
      }
    } else {
      console.error('[Media] No local stream available!')
      needsRebuild = true
    }

    if (needsRebuild) {
      // Guard against concurrent rebuilds
      if (isRebuildingAudioRef.current) {
        console.log('[Media] Audio rebuild already in progress, waiting...')
        // Wait for existing rebuild to complete
        await new Promise<void>(resolve => {
          const checkInterval = setInterval(() => {
            if (!isRebuildingAudioRef.current) {
              clearInterval(checkInterval)
              resolve()
            }
          }, 50)
        })
        // After waiting, check if the stream is now valid
        localStream = localStreamRef.current
        if (localStream) {
          const tracks = localStream.getAudioTracks()
          if (tracks.length > 0 && tracks[0].readyState === 'live') {
            console.log('[Media] Audio stack was rebuilt by another call, using it')
            needsRebuild = false
          }
        }
      }

      if (needsRebuild) {
        isRebuildingAudioRef.current = true
        // This is a recovery path - the shared meter's track died mid-call
        // We must rebuild, but settings changes won't apply live after this
        console.warn('[Media] Track died mid-call, rebuilding audio stack (live settings updates disabled)')
        try {
          // Don't stop the old meter - it may be shared and AudioSettings still needs the reference
          // Just create a new meter that shadows it for WebRTC purposes

          // Load audio settings and create fresh meter
          const audioSettings = await loadAudioSettings()
          const newMeter = new InputLevelMeter()
          await newMeter.start(
            audioSettings.input_device_id || null,
            () => {} // No level callback needed for WebRTC
          )
          newMeter.setGain(audioSettings.input_volume)
          newMeter.setThreshold(audioSettings.input_sensitivity)
          newMeter.setInputMode(audioSettings.input_mode)

          console.warn('[Media] ⚠️ Replacing shared meter with fallback - live settings disabled')
          inputLevelMeterRef.current = newMeter

          // Get fresh stream
          const freshStream = newMeter.getTransmissionStream()
          if (freshStream) {
            const freshTracks = freshStream.getAudioTracks()
            if (freshTracks.length > 0 && freshTracks[0].readyState === 'live') {
              console.log('[Media] Audio stack rebuilt successfully, track is live')
              localStream = freshStream
              localStreamRef.current = freshStream
            } else {
              console.error('[Media] Rebuilt audio stack but track is still not live!')
            }
          } else {
            console.error('[Media] Rebuilt audio stack but no stream available!')
          }
        } catch (error) {
          console.error('[Media] Failed to rebuild audio stack:', error)
        } finally {
          isRebuildingAudioRef.current = false
        }
      }
    }

    if (localStream) {
      const tracks = localStream.getAudioTracks()
      if (tracks.length > 0) {
        console.log('[Media] Attaching track to peer connection:', {
          trackId: tracks[0].id,
          readyState: tracks[0].readyState,
          enabled: tracks[0].enabled,
          label: tracks[0].label
        })
      }
      attachAudioTrack(pc, localStream)
      console.log('[Media] ✓ Local audio track attached to peer connection')
    } else {
      console.error('[Media] Cannot attach audio - no valid local stream!')
    }

    return pc
  }, [applyRemoteProfile, handlePeerDisconnect, clearRecoveryTimers, tryIceRestart])

  const handleSignalingMessage = useCallback(async (data: string) => {
    const msg = JSON.parse(data)
    console.log('[WebRTC] Received signaling message:', msg.type)

    switch (msg.type) {
      case 'VoiceRegistered': {
        const { peers: serverPeers, chat_id } = msg
        console.log(`[Signal] Registered in chat ${chat_id}. Existing peers:`, serverPeers.length)

        // Create connections to all existing peers in the room
        for (const peerInfo of serverPeers) {
          const { peer_id: remotePeerId, user_id: remoteUserId } = peerInfo

          // Check if we already have a connection to this USER (by user_id)
          const existingByUserId = findPeerByUserId(remoteUserId)
          if (existingByUserId) {
            // Same user, different peer_id (reconnect case)
            console.log(`[Signal] User ${remoteUserId} reconnected with new peer_id, replacing old connection`)
            handlePeerDisconnect(existingByUserId.peerId)
          }

            try {
            const pc = await createPeerConnectionForPeer(remotePeerId, remoteUserId)

            // P2P profile channel: we're the offerer, so we create the channel and send our profile when open
            const profileDc = pc.createDataChannel(PROFILE_P2P_CHANNEL)
            profileDc.onopen = () => {
              const payload = profileP2PRef.current
              if (payload) {
                try {
                  profileDc.send(JSON.stringify({
                    type: 'ProfileP2P',
                    user_id: payload.user_id,
                    display_name: payload.display_name,
                    real_name: payload.real_name,
                    show_real_name: payload.show_real_name,
                    rev: payload.rev,
                    account_created_at: payload.account_created_at,
                  }))
                } catch (_) {
                  // ignore
                }
              }
            }

            setPeers(prev => {
              const updated = new Map(prev)
              updated.set(remotePeerId, {
                peerId: remotePeerId,
                userId: remoteUserId,
                connection: pc,
                remoteStream: null,
                audioElement: null,
                audioAnalyzer: null,
                connectionState: pc.connectionState
              })
              return updated
            })

            await new Promise(r => setTimeout(r, ICE_OFFER_WARMUP_MS))
            const offerSdp = await createOffer(pc)
            const offerMessage = {
              type: 'VoiceOffer',
              from_peer: currentPeerIdRef.current,
              from_user: currentUserIdRef.current,
              to_peer: remotePeerId,
              chat_id: currentRoomRef.current,
              sdp: offerSdp
            }
            wsRef.current?.send(JSON.stringify(offerMessage))
            console.log(`[Signal] Sent VoiceOffer to peer=${remotePeerId}`)
          } catch (error) {
            console.error(`[Signal] Failed to create offer for ${remotePeerId}:`, error)
          }
        }
        break
      }

      case 'VoicePeerJoined': {
        const { peer_id: remotePeerId } = msg
        console.log(`[Signal] Peer joined room: peer=${remotePeerId}`)

        // Don't clean up existing connections here - let VoiceOffer handle it
        // The new peer will send us an offer, and we'll handle any duplicate
        // user connections at that point when we have the new peer_id to connect to.
        //
        // Cleaning up here causes a race condition where we disconnect before
        // establishing the new connection.
        break
      }

      case 'VoicePeerLeft': {
        const { peer_id: remotePeerId } = msg
        console.log(`[Signal] Peer left room: peer=${remotePeerId}`)

        handlePeerDisconnect(remotePeerId)
        break
      }

      case 'VoiceOffer': {
        const { from_peer, from_user, sdp } = msg
        console.log(`[Signal] Received VoiceOffer from peer=${from_peer}`)

        try {
          // Same peer_id: renegotiation (e.g. ICE restart from their side) – reuse existing PC
          const existingSamePeer = peersRef.current.get(from_peer)
          if (existingSamePeer) {
            console.log(`[Signal] Renegotiation (ICE restart?) for existing peer=${from_peer}`)
            const answerSdp = await createAnswer(existingSamePeer.connection, sdp)
            wsRef.current?.send(JSON.stringify({
              type: 'VoiceAnswer',
              from_peer: currentPeerIdRef.current,
              from_user: currentUserIdRef.current,
              to_peer: from_peer,
              chat_id: currentRoomRef.current,
              sdp: answerSdp
            }))
            console.log(`[Signal] Sent VoiceAnswer (renegotiation) to peer=${from_peer}`)
            break
          }

          // Different peer_id for same user: replace old connection
          const existingByUserId = findPeerByUserId(from_user)
          if (existingByUserId && existingByUserId.peerId !== from_peer) {
            console.log(`[Signal] User reconnected with new peer_id, replacing old connection`)
            handlePeerDisconnect(existingByUserId.peerId)
          }

          const pc = await createPeerConnectionForPeer(from_peer, from_user)

          setPeers(prev => {
            const updated = new Map(prev)
            updated.set(from_peer, {
              peerId: from_peer,
              userId: from_user,
              connection: pc,
              remoteStream: null,
              audioElement: null,
              audioAnalyzer: null,
              connectionState: pc.connectionState
            })
            return updated
          })

          const answerSdp = await createAnswer(pc, sdp)
          wsRef.current?.send(JSON.stringify({
            type: 'VoiceAnswer',
            from_peer: currentPeerIdRef.current,
            from_user: currentUserIdRef.current,
            to_peer: from_peer,
            chat_id: currentRoomRef.current,
            sdp: answerSdp
          }))
          console.log(`[Signal] Sent VoiceAnswer to peer=${from_peer}`)
        } catch (error) {
          console.error(`[Signal] Failed to handle VoiceOffer from ${from_peer}:`, error)
        }
        break
      }

      case 'VoiceAnswer': {
        const { from_peer, sdp } = msg
        console.log(`[Signal] Received VoiceAnswer from peer=${from_peer}`)

        const peerInfo = peersRef.current.get(from_peer)
        if (peerInfo) {
          try {
            await handleAnswer(peerInfo.connection, sdp)
            console.log(`[Signal] Applied VoiceAnswer from peer=${from_peer}`)
          } catch (error) {
            console.error(`[Signal] Failed to apply VoiceAnswer:`, error)
          }
        } else {
          console.warn(`[Signal] Received VoiceAnswer from unknown peer ${from_peer}`)
        }
        break
      }

      case 'VoiceIceCandidate': {
        const { from_peer, candidate } = msg
        // Don't log every ICE candidate - too noisy

        const peerInfo = peersRef.current.get(from_peer)
        if (peerInfo) {
          try {
            await addIceCandidate(peerInfo.connection, candidate)
          } catch (error) {
            // ICE candidate errors are common and often recoverable
            console.warn(`[Signal] Failed to add ICE candidate:`, error)
          }
        }
        break
      }

      case 'Error': {
        console.error('[Signal] Signaling error:', msg.message)
        break
      }

      case 'Pong': {
        // Keepalive response - no action needed
        break
      }

      default:
        // Ignore other message types (presence, profile, etc.)
        break
    }
  }, [createPeerConnectionForPeer, handlePeerDisconnect, findPeerByUserId])

  // Start keepalive timer for signaling WebSocket
  const startKeepalive = useCallback(() => {
    // Clear any existing keepalive
    if (keepaliveIntervalRef.current) {
      clearInterval(keepaliveIntervalRef.current)
    }

    keepaliveIntervalRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Send application-level ping to prevent idle timeout
        wsRef.current.send(JSON.stringify({ type: 'Ping' }))
        // Don't log every ping - too noisy
      }
    }, SIGNALING_KEEPALIVE_INTERVAL_MS)
  }, [])

  const stopKeepalive = useCallback(() => {
    if (keepaliveIntervalRef.current) {
      clearInterval(keepaliveIntervalRef.current)
      keepaliveIntervalRef.current = null
    }
  }, [])

  // Connect to signaling server (used for initial connect and reconnect)
  // NOTE: This is CONTROL PLANE only - does not touch media
  const connectToSignaling = useCallback(() => {
    if (!beaconUrl) {
      console.error('[Signal] Cannot connect: no beaconUrl')
      return
    }

    if (!currentRoomRef.current || !currentHouseRef.current) {
      console.error('[Signal] Cannot connect: missing room or house')
      return
    }

    // Don't reconnect if already connected
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[Signal] Already connected, skipping reconnect')
      return
    }

    console.log('[Signal] Connecting to signaling server...')
    const base = beaconUrl.replace(/\/$/, '')
    const wsUrl = base.endsWith('/ws') ? base : base + '/ws'
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[Signal] Connected to signaling server')
      signalingConnectedRef.current = true

      // Start keepalive to prevent idle disconnect
      startKeepalive()

      // Register for voice in the chat (beacon expects server_id and chat_id)
      const registerMessage = {
        type: 'VoiceRegister',
        server_id: currentHouseRef.current,
        chat_id: currentRoomRef.current,
        peer_id: currentPeerIdRef.current,
        user_id: currentUserIdRef.current,
        signing_pubkey: currentSigningPubkeyRef.current
      }
      ws.send(JSON.stringify(registerMessage))
      console.log(`[Signal] Sent VoiceRegister: peer=${currentPeerIdRef.current}`)
    }

    ws.onmessage = (event) => {
      handleSignalingMessage(event.data)
    }

    ws.onerror = (error) => {
      console.error('[Signal] WebSocket error:', error)
    }

    ws.onclose = (event) => {
      console.log(`[Signal] WebSocket closed: code=${event.code} reason=${event.reason}`)
      wsRef.current = null
      signalingConnectedRef.current = false
      stopKeepalive()

      // IMPORTANT: Do NOT tear down media here!
      // Existing RTCPeerConnections continue to work without signaling.
      // Only new peer connections require signaling.

      // Attempt to reconnect signaling only (no media teardown)
      if (isInVoiceRef.current && currentRoomRef.current) {
        console.log('[Signal] Attempting signaling reconnect in 2 seconds...')
        console.log('[Signal] Note: Existing media connections are unaffected')
        setTimeout(() => {
          if (isInVoiceRef.current && currentRoomRef.current) {
            // Keep the same peer_id - we're just reconnecting signaling
            // Only generate new peer_id if we explicitly leave and rejoin
            connectToSignaling()
          }
        }, 2000)
      }
    }
  }, [beaconUrl, handleSignalingMessage, startKeepalive, stopKeepalive])

  const joinVoice = useCallback(async (roomId: string, houseId: string, userId: string, signingPubkey: string) => {
    if (isInVoice) {
      console.warn('[WebRTC] Already in voice, leaving first')
      // Clean up stale presence data before leaving
      if (currentSigningPubkeyRef.current && currentUserIdRef.current) {
        voicePresence.removeUserFromAllRooms(currentSigningPubkeyRef.current, currentUserIdRef.current)
      }
      leaveVoiceInternal()
    }

    if (!beaconUrl) {
      console.error('[WebRTC] No signaling server URL configured')
      throw new Error('No signaling server configured')
    }

    // Ensure audio is initialized before joining
    await ensureAudioInitialized(() => {})  // Safe - only creates if missing

    const meter = inputLevelMeterRef.current
    if (!meter) {
      throw new Error('Failed to initialize audio meter')
    }

    // Get transmission stream from InputLevelMeter
    const transmissionStream = meter.getTransmissionStream()
    if (!transmissionStream) {
      console.error('[Media] Failed to get transmission stream')
      throw new Error('Failed to get audio stream')
    }

    // Verify the transmission stream is healthy
    const audioTracks = transmissionStream.getAudioTracks()
    if (audioTracks.length === 0 || audioTracks[0].readyState === 'ended') {
      throw new Error('Audio meter stream is not live')
    }

    console.log('[Voice] ✓ Using audio meter for voice transmission')
    console.log('[Voice] ✓ Live settings updates ENABLED (gain, threshold, VAD/PTT mode)')
    console.log('[Voice] ✓ Stream track ID:', audioTracks[0].id)
    console.log(`[Media] Transmission track ready: readyState=${audioTracks[0].readyState}`)

    // Create analyzer for local voice activity detection (self-speaking indicator)
    try {
      localAudioAnalyzerRef.current = new RemoteAudioAnalyzer(
        transmissionStream,
        (isSpeaking: boolean) => {
          // Update speaking state for self
          setUserSpeaking(userId, isSpeaking)
        }
      )
      console.log('[Media] Created local audio analyzer for self-speaking detection')
    } catch (error) {
      console.warn('[Media] Failed to create local audio analyzer:', error)
    }

    // Generate EPHEMERAL peer_id for this session
    const peerId = crypto.randomUUID()

    console.log(`[Voice] Joining voice: room=${roomId} peer=${peerId}`)

    // Store refs
    localStreamRef.current = transmissionStream
    currentRoomRef.current = roomId
    currentHouseRef.current = houseId
    currentPeerIdRef.current = peerId
    currentUserIdRef.current = userId
    currentSigningPubkeyRef.current = signingPubkey

    // Update state
    setIsInVoice(true)
    setCurrentRoomId(roomId)
    isInVoiceRef.current = true

    // Clean up any stale presence data for this user in this house before joining
    // This ensures we don't have duplicate entries if the user was in a different room
    voicePresence.removeUserFromAllRooms(signingPubkey, userId)

    // Connect to signaling
    connectToSignaling()
  }, [isInVoice, beaconUrl, connectToSignaling, voicePresence, setUserSpeaking])

  // Internal leave function that doesn't check isInVoice state
  // NOTE: This is an EXPLICIT leave - tear down both signaling AND media
  const leaveVoiceInternal = useCallback(() => {
    console.log('[Voice] Leaving voice - tearing down signaling and media')

    // Stop local audio analyzer
    if (localAudioAnalyzerRef.current) {
      localAudioAnalyzerRef.current.stop()
      localAudioAnalyzerRef.current = null
      // Clear self-speaking state
      if (currentUserIdRef.current) {
        setUserSpeaking(currentUserIdRef.current, false)
      }
    }

    // 1. Stop keepalive
    stopKeepalive()

    // 2. Notify server (best effort)
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const unregisterMessage = {
        type: 'VoiceUnregister',
        peer_id: currentPeerIdRef.current,
        chat_id: currentRoomRef.current
      }
      wsRef.current.send(JSON.stringify(unregisterMessage))
      console.log('[Signal] Sent VoiceUnregister')
    }

    // 3. Close all peer connections (MEDIA teardown)
    console.log(`[Media] Closing ${peersRef.current.size} peer connections`)
    peersRef.current.forEach((peerInfo, peerId) => {
      cleanupPeerConnection(peerId, peerInfo)
    })
    setPeers(new Map())
    peersRef.current = new Map()
    cleanedPeersRef.current.clear()  // Reset cleaned peers tracking

    // 4. Close WebSocket (SIGNALING teardown)
    if (wsRef.current) {
      wsRef.current.onclose = null  // Prevent reconnect handler from firing
      wsRef.current.close()
      wsRef.current = null
    }
    signalingConnectedRef.current = false

    // 5. Clear local stream reference
    // NOTE: We keep the InputLevelMeter running for AudioSettings to use
    // Only stop it if explicitly requested or on app shutdown
    console.log('[Media] Clearing local stream reference (meter kept running)')
    localStreamRef.current = null

    // 6. Clear refs
    currentPeerIdRef.current = null
    currentUserIdRef.current = null
    currentSigningPubkeyRef.current = null
    currentRoomRef.current = null
    currentHouseRef.current = null

    // 7. Update state
    setIsInVoice(false)
    setCurrentRoomId(null)
    setIsLocalMuted(false)
    isInVoiceRef.current = false

    console.log('[Voice] Leave complete')
  }, [cleanupPeerConnection, stopKeepalive, setUserSpeaking])

  const leaveVoice = useCallback(() => {
    if (!isInVoice) {
      return
    }
    leaveVoiceInternal()
  }, [isInVoice, leaveVoiceInternal])

  const setRemoteUserVolume = useCallback((userId: string, volume: number) => {
    setReceiverUserVolume(userId, volume)
    const prefs = getReceiverPrefs(userId)
    peersRef.current.forEach((info) => {
      if (info.userId === userId && info.audioElement) {
        info.audioElement.volume = prefs.muted ? 0 : Math.max(0, Math.min(2, prefs.volume))
      }
    })
    setRemoteAudioPrefs((prev) => ({ ...prev, [userId]: prefs }))
  }, [])

  const setRemoteUserMuted = useCallback((userId: string, muted: boolean) => {
    setReceiverUserMuted(userId, muted)
    const prefs = getReceiverPrefs(userId)
    peersRef.current.forEach((info) => {
      if (info.userId === userId && info.audioElement) {
        info.audioElement.volume = prefs.muted ? 0 : Math.max(0, Math.min(2, prefs.volume))
      }
    })
    setRemoteAudioPrefs((prev) => ({ ...prev, [userId]: prefs }))
  }, [])

  const getRemoteUserPrefs = useCallback((userId: string) => getReceiverPrefs(userId), [])

  return (
    <WebRTCContext.Provider
      value={{
        joinVoice,
        leaveVoice,
        toggleMute,
        setOutputDevice,
        isInVoice,
        isLocalMuted,
        peers,
        currentRoomId,
        inputLevelMeter,
        ensureAudioInitialized,
        reinitializeAudio,
        hotSwapInputDevice,
        stopAudio,
        remoteAudioPrefs,
        setRemoteUserVolume,
        setRemoteUserMuted,
        getRemoteUserPrefs
      }}
    >
      {children}
    </WebRTCContext.Provider>
  )
}

export function useWebRTC() {
  const context = useContext(WebRTCContext)
  if (!context) {
    throw new Error('useWebRTC must be used within a WebRTCProvider')
  }
  return context
}
