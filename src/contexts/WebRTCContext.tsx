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
  closePeerConnection
} from '../lib/webrtc'
import { useSignaling } from './SignalingContext'
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

export type PeerConnectionState = RTCPeerConnectionState

export interface PeerConnectionInfo {
  peerId: string               // Ephemeral, for WebRTC routing
  userId: string               // Stable, for identity display
  connection: RTCPeerConnection
  remoteStream: MediaStream | null
  audioElement: HTMLAudioElement | null
  connectionState: PeerConnectionState
}

interface WebRTCContextType {
  // Connection management
  joinVoice(roomId: string, houseId: string, userId: string): Promise<void>
  leaveVoice(): void

  // Local controls
  toggleMute(): void
  setOutputDevice(deviceId: string): void

  // State
  isInVoice: boolean
  isLocalMuted: boolean
  peers: Map<string, PeerConnectionInfo>  // Keyed by peerId
  currentRoomId: string | null

  // Voice presence (house-wide)
  voicePresence: Map<string, Set<string>>  // Map of roomId -> Set of userIds in that room

  // Audio system
  inputLevelMeter: InputLevelMeter | null  // Shared meter for audio settings
  ensureAudioInitialized(onLevelUpdate: (level: number) => void): Promise<void>
  reinitializeAudio(deviceId: string | null, onLevelUpdate: (level: number) => void): Promise<void>
  hotSwapInputDevice(deviceId: string): Promise<void>
  stopAudio(): void
}

const WebRTCContext = createContext<WebRTCContextType | null>(null)

export function WebRTCProvider({ children }: { children: ReactNode }) {
  const { signalingUrl } = useSignaling()

  // State
  const [isInVoice, setIsInVoice] = useState(false)
  const [isLocalMuted, setIsLocalMuted] = useState(false)
  const [peers, setPeers] = useState<Map<string, PeerConnectionInfo>>(new Map())
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null)
  const [inputLevelMeter, setInputLevelMeter] = useState<InputLevelMeter | null>(null)
  const [voicePresence, setVoicePresence] = useState<Map<string, Set<string>>>(new Map())

  // Refs
  const inputLevelMeterRef = useRef<InputLevelMeter | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const currentRoomRef = useRef<string | null>(null)
  const currentHouseRef = useRef<string | null>(null)
  const currentPeerIdRef = useRef<string | null>(null)   // Ephemeral session ID
  const currentUserIdRef = useRef<string | null>(null)   // Stable identity
  const outputDeviceRef = useRef<string | null>(null)
  const isInVoiceRef = useRef<boolean>(false)            // For reconnect logic
  const peersRef = useRef<Map<string, PeerConnectionInfo>>(new Map())  // For message handlers
  const isRebuildingAudioRef = useRef<boolean>(false)    // Guard against concurrent rebuilds
  const keepaliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)  // Signaling keepalive
  const signalingConnectedRef = useRef<boolean>(false)   // Track signaling state separately from media

  // Keep peersRef in sync with state
  useEffect(() => {
    peersRef.current = peers
  }, [peers])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      leaveVoiceInternal()
    }
  }, [])

  // Ensure audio is initialized (safe during calls - only creates if missing)
  const ensureAudioInitialized = useCallback(async (onLevelUpdate: (level: number) => void): Promise<void> => {
    if (inputLevelMeterRef.current) {
      console.log('[Audio] Meter already exists, skipping initialization')
      return
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

    console.log('[Audio] Reinitializing audio system with device:', deviceId || 'default')

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
  const hotSwapInputDevice = useCallback(async (newDeviceId: string): Promise<void> => {
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

    // Update all existing remote audio elements
    peers.forEach((peerInfo) => {
      if (peerInfo.audioElement && 'setSinkId' in peerInfo.audioElement) {
        (peerInfo.audioElement as any).setSinkId(deviceId).catch((error: Error) => {
          console.warn('[WebRTC] Failed to update output device for peer:', error)
        })
      }
    })
  }, [peers])

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
    console.log(`[WebRTC] Cleaning up peer ${peerId} (user ${peerInfo.userId})`)

    // Stop remote audio
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
  }, [])

  // Find peer by user_id (for handling reconnects)
  const findPeerByUserId = useCallback((userId: string): PeerConnectionInfo | undefined => {
    for (const [_, info] of peersRef.current) {
      if (info.userId === userId) return info
    }
    return undefined
  }, [])

  const createPeerConnectionForPeer = useCallback(async (remotePeerId: string, _remoteUserId: string): Promise<RTCPeerConnection> => {
    const pc = createPeerConnection()
    const roomId = currentRoomRef.current

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        const message = {
          type: 'VoiceIceCandidate',
          from_peer: currentPeerIdRef.current,
          to_peer: remotePeerId,
          room_id: roomId,
          candidate: JSON.stringify(event.candidate)
        }
        wsRef.current.send(JSON.stringify(message))
        // Don't log every ICE candidate - too noisy
      }
    }

    // Handle ICE connection state changes
    // NOTE: This is MEDIA plane - separate from signaling
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      console.log(`[Media] ICE state for peer=${remotePeerId}: ${state}`)

      if (state === 'failed') {
        console.error(`[Media] ICE FAILED for peer ${remotePeerId} - media connection lost`)
        // ICE failure is a real media failure - clean up this peer
        handlePeerDisconnect(remotePeerId)
      }

      if (state === 'disconnected') {
        console.warn(`[Media] ICE disconnected for peer ${remotePeerId} - may recover automatically`)
        // ICE disconnected often recovers on its own. Don't act yet.
      }

      if (state === 'connected' || state === 'completed') {
        console.log(`[Media] ICE connected for peer ${remotePeerId} - media flowing`)
      }
    }

    // Handle connection state changes
    // NOTE: This is MEDIA plane - separate from signaling
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

      // Clean up only on actual media failure
      if (state === 'failed') {
        console.error(`[Media] Connection FAILED for peer ${remotePeerId} - cleaning up`)
        handlePeerDisconnect(remotePeerId)
      }
      // Note: 'closed' is expected when we clean up, don't double-cleanup
    }

    // Handle remote audio track
    // NOTE: This is MEDIA plane - receiving audio from peer
    pc.ontrack = (event) => {
      console.log(`[Media] Received remote track from peer=${remotePeerId}`)
      console.log(`[Media] Track: kind=${event.track.kind}, enabled=${event.track.enabled}, readyState=${event.track.readyState}`)
      const remoteStream = event.streams[0]

      if (remoteStream) {
        const audioElement = createRemoteAudioElement(remoteStream, outputDeviceRef.current || undefined)
        console.log(`[Media] Created audio element for peer=${remotePeerId}`)

        // Listen for track unmute events
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
              audioElement
            })
          }
          return updated
        })
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

  const handleSignalingMessage = useCallback(async (data: string) => {
    const msg = JSON.parse(data)
    console.log('[WebRTC] Received signaling message:', msg.type)

    switch (msg.type) {
      case 'VoiceRegistered': {
        const { peers: serverPeers, room_id } = msg
        console.log(`[Signal] Registered in room ${room_id}. Existing peers:`, serverPeers.length)

        // Update voice presence: add ourselves and all existing peers to this room
        setVoicePresence(prev => {
          const updated = new Map(prev)
          const roomUsers = new Set<string>()

          // Add ourselves
          if (currentUserIdRef.current) {
            roomUsers.add(currentUserIdRef.current)
          }

          // Add all existing peers
          for (const peerInfo of serverPeers) {
            roomUsers.add(peerInfo.user_id)
          }

          updated.set(room_id, roomUsers)
          return updated
        })

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

            setPeers(prev => {
              const updated = new Map(prev)
              updated.set(remotePeerId, {
                peerId: remotePeerId,
                userId: remoteUserId,
                connection: pc,
                remoteStream: null,
                audioElement: null,
                connectionState: pc.connectionState
              })
              return updated
            })

            // Create and send offer
            const offerSdp = await createOffer(pc)
            const offerMessage = {
              type: 'VoiceOffer',
              from_peer: currentPeerIdRef.current,
              from_user: currentUserIdRef.current,
              to_peer: remotePeerId,
              room_id: currentRoomRef.current,
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
        const { peer_id: remotePeerId, user_id: remoteUserId, room_id: roomId } = msg
        console.log(`[Signal] Peer joined room: peer=${remotePeerId} user=${remoteUserId} room=${roomId}`)

        // Update voice presence for this room
        setVoicePresence(prev => {
          const updated = new Map(prev)
          const roomUsers = updated.get(roomId) || new Set()
          roomUsers.add(remoteUserId)
          updated.set(roomId, roomUsers)
          return updated
        })

        // Don't clean up existing connections here - let VoiceOffer handle it
        // The new peer will send us an offer, and we'll handle any duplicate
        // user connections at that point when we have the new peer_id to connect to.
        //
        // Cleaning up here causes a race condition where we disconnect before
        // establishing the new connection.
        break
      }

      case 'VoicePeerLeft': {
        const { peer_id: remotePeerId, user_id: remoteUserId, room_id: roomId } = msg
        console.log(`[Signal] Peer left room: peer=${remotePeerId} user=${remoteUserId} room=${roomId}`)

        // Update voice presence for this room
        setVoicePresence(prev => {
          const updated = new Map(prev)
          const roomUsers = updated.get(roomId)
          if (roomUsers) {
            roomUsers.delete(remoteUserId)
            if (roomUsers.size === 0) {
              updated.delete(roomId)
            } else {
              updated.set(roomId, roomUsers)
            }
          }
          return updated
        })

        handlePeerDisconnect(remotePeerId)
        break
      }

      case 'VoiceOffer': {
        const { from_peer, from_user, sdp } = msg
        console.log(`[Signal] Received VoiceOffer from peer=${from_peer}`)

        try {
          // Check if we already have a connection to this user
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
              connectionState: pc.connectionState
            })
            return updated
          })

          // Create and send answer
          const answerSdp = await createAnswer(pc, sdp)
          const answerMessage = {
            type: 'VoiceAnswer',
            from_peer: currentPeerIdRef.current,
            from_user: currentUserIdRef.current,
            to_peer: from_peer,
            room_id: currentRoomRef.current,
            sdp: answerSdp
          }
          wsRef.current?.send(JSON.stringify(answerMessage))
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
    if (!signalingUrl) {
      console.error('[Signal] Cannot connect: no signalingUrl')
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
    const ws = new WebSocket(signalingUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[Signal] Connected to signaling server')
      signalingConnectedRef.current = true

      // Start keepalive to prevent idle disconnect
      startKeepalive()

      // Register for voice in the room (re-register with same peer_id)
      const registerMessage = {
        type: 'VoiceRegister',
        house_id: currentHouseRef.current,
        room_id: currentRoomRef.current,
        peer_id: currentPeerIdRef.current,
        user_id: currentUserIdRef.current
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
  }, [signalingUrl, handleSignalingMessage, startKeepalive, stopKeepalive])

  const joinVoice = useCallback(async (roomId: string, houseId: string, userId: string) => {
    if (isInVoice) {
      console.warn('[WebRTC] Already in voice, leaving first')
      leaveVoiceInternal()
    }

    if (!signalingUrl) {
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

    // Generate EPHEMERAL peer_id for this session
    const peerId = crypto.randomUUID()

    console.log(`[Voice] Joining voice: room=${roomId} peer=${peerId}`)

    // Store refs
    localStreamRef.current = transmissionStream
    currentRoomRef.current = roomId
    currentHouseRef.current = houseId
    currentPeerIdRef.current = peerId
    currentUserIdRef.current = userId

    // Update state
    setIsInVoice(true)
    setCurrentRoomId(roomId)
    isInVoiceRef.current = true

    // Connect to signaling
    connectToSignaling()
  }, [isInVoice, signalingUrl, connectToSignaling])

  // Internal leave function that doesn't check isInVoice state
  // NOTE: This is an EXPLICIT leave - tear down both signaling AND media
  const leaveVoiceInternal = useCallback(() => {
    console.log('[Voice] Leaving voice - tearing down signaling and media')

    // 1. Stop keepalive
    stopKeepalive()

    // 2. Notify server (best effort)
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const unregisterMessage = {
        type: 'VoiceUnregister',
        peer_id: currentPeerIdRef.current,
        room_id: currentRoomRef.current
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
    currentRoomRef.current = null
    currentHouseRef.current = null

    // 7. Clear voice presence for the room we're leaving
    const leavingRoomId = currentRoomRef.current
    if (leavingRoomId && currentUserIdRef.current) {
      setVoicePresence(prev => {
        const updated = new Map(prev)
        const roomUsers = updated.get(leavingRoomId)
        if (roomUsers) {
          roomUsers.delete(currentUserIdRef.current!)
          if (roomUsers.size === 0) {
            updated.delete(leavingRoomId)
          } else {
            updated.set(leavingRoomId, roomUsers)
          }
        }
        return updated
      })
    }

    // 8. Update state
    setIsInVoice(false)
    setCurrentRoomId(null)
    setIsLocalMuted(false)
    isInVoiceRef.current = false

    console.log('[Voice] Leave complete')
  }, [cleanupPeerConnection, stopKeepalive])

  const leaveVoice = useCallback(() => {
    if (!isInVoice) {
      return
    }
    leaveVoiceInternal()
  }, [isInVoice, leaveVoiceInternal])

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
        voicePresence,
        inputLevelMeter,
        ensureAudioInitialized,
        reinitializeAudio,
        hotSwapInputDevice,
        stopAudio
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
