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
 * Layer A Implementation: Core correctness with minimal UX.
 * - Room-scoped voice isolation
 * - Ephemeral peer_id / stable user_id separation
 * - Clean join/leave lifecycle
 * - Barebones reconnect (no exponential backoff)
 * - ICE state monitoring (logging only, no auto-restart)
 */

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

  // Integration
  setInputLevelMeter(meter: InputLevelMeter | null): void
}

const WebRTCContext = createContext<WebRTCContextType | null>(null)

export function WebRTCProvider({ children }: { children: ReactNode }) {
  const { signalingUrl } = useSignaling()

  // State
  const [isInVoice, setIsInVoice] = useState(false)
  const [isLocalMuted, setIsLocalMuted] = useState(false)
  const [peers, setPeers] = useState<Map<string, PeerConnectionInfo>>(new Map())
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null)

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

  const setInputLevelMeter = useCallback((meter: InputLevelMeter | null) => {
    inputLevelMeterRef.current = meter
  }, [])

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

  const createPeerConnectionForPeer = useCallback(async (remotePeerId: string, remoteUserId: string): Promise<RTCPeerConnection> => {
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

    // Handle ICE connection state changes (Layer A: logging only)
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      console.log(`[WebRTC] ICE state for peer=${remotePeerId} user=${remoteUserId}: ${state}`)

      if (state === 'failed') {
        console.error(`[WebRTC] ICE FAILED for peer ${remotePeerId} - no automatic restart in Layer A`)
        // Layer A: No automatic ICE restart. Log clearly and let it fail.
      }

      if (state === 'disconnected') {
        console.warn(`[WebRTC] ICE disconnected for peer ${remotePeerId} - may recover automatically`)
        // May recover automatically. Log but don't act.
      }
    }

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      console.log(`[WebRTC] Connection state for peer=${remotePeerId} user=${remoteUserId}: ${state}`)

      setPeers(prev => {
        const updated = new Map(prev)
        const peerInfo = updated.get(remotePeerId)
        if (peerInfo) {
          updated.set(remotePeerId, { ...peerInfo, connectionState: state })
        }
        return updated
      })

      // Clean up if connection fails or closes
      if (state === 'failed' || state === 'closed') {
        console.log(`[WebRTC] Connection ${state} for peer ${remotePeerId}, cleaning up`)
        handlePeerDisconnect(remotePeerId)
      }
    }

    // Handle remote audio track
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received remote track from peer=${remotePeerId} user=${remoteUserId}`)
      console.log(`[WebRTC] Track kind: ${event.track.kind}, enabled: ${event.track.enabled}, muted: ${event.track.muted}, readyState: ${event.track.readyState}`)
      console.log(`[WebRTC] Streams in event: ${event.streams.length}`)
      const remoteStream = event.streams[0]

      if (remoteStream) {
        const audioTracks = remoteStream.getAudioTracks()
        console.log(`[WebRTC] Remote stream has ${audioTracks.length} audio tracks`)
        if (audioTracks.length > 0) {
          console.log(`[WebRTC] Remote track readyState: ${audioTracks[0].readyState}`)
        }

        const audioElement = createRemoteAudioElement(remoteStream, outputDeviceRef.current || undefined)
        console.log(`[WebRTC] Created audio element, paused: ${audioElement.paused}, volume: ${audioElement.volume}, muted: ${audioElement.muted}`)

        // Listen for track unmute events
        event.track.onunmute = () => {
          console.log(`[WebRTC] Remote track unmuted for peer=${remotePeerId}`)
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
        console.error('[WebRTC] No stream in ontrack event!')
      }
    }

    // Attach local audio track
    let localStream = localStreamRef.current
    if (localStream) {
      const audioTracks = localStream.getAudioTracks()
      console.log(`[WebRTC] Attaching local audio track. Stream has ${audioTracks.length} audio tracks`)
      if (audioTracks.length > 0) {
        const track = audioTracks[0]
        console.log(`[WebRTC] Track label: ${track.label}, enabled: ${track.enabled}, muted: ${track.muted}, readyState: ${track.readyState}`)

        // Check if track is dead and needs reinitialization
        if (track.readyState === 'ended') {
          console.warn('[WebRTC] Local audio track is ended, reinitializing audio...')
          // Try to get a fresh stream from the meter
          const meter = inputLevelMeterRef.current
          if (meter) {
            const freshStream = meter.getTransmissionStream()
            if (freshStream) {
              const freshTracks = freshStream.getAudioTracks()
              if (freshTracks.length > 0 && freshTracks[0].readyState === 'live') {
                console.log('[WebRTC] Got fresh stream from meter')
                localStream = freshStream
                localStreamRef.current = freshStream
              } else {
                console.error('[WebRTC] Fresh stream from meter also has dead tracks')
              }
            }
          }
        }
      }
      attachAudioTrack(pc, localStream)
    } else {
      console.error('[WebRTC] No local stream available when creating peer connection!')
    }

    return pc
  }, [])

  const handlePeerDisconnect = useCallback((remotePeerId: string) => {
    console.log(`[WebRTC] Peer ${remotePeerId} disconnected`)

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
        console.log(`[WebRTC] Registered in room ${room_id}. Peers:`, serverPeers)

        // Create connections to all existing peers in the room
        for (const peerInfo of serverPeers) {
          const { peer_id: remotePeerId, user_id: remoteUserId } = peerInfo

          // Check if we already have a connection to this USER (by user_id)
          const existingByUserId = findPeerByUserId(remoteUserId)
          if (existingByUserId) {
            // Same user, different peer_id (reconnect case)
            console.log(`[WebRTC] User ${remoteUserId} reconnected with new peer_id, replacing old connection`)
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
            console.log(`[WebRTC] Sent VoiceOffer to peer=${remotePeerId} user=${remoteUserId}`)
          } catch (error) {
            console.error(`[WebRTC] Failed to create offer for ${remotePeerId}:`, error)
          }
        }
        break
      }

      case 'VoicePeerJoined': {
        const { peer_id: remotePeerId, user_id: remoteUserId, room_id } = msg
        console.log(`[WebRTC] Peer joined: peer=${remotePeerId} user=${remoteUserId} room=${room_id}`)

        // Don't clean up existing connections here - let VoiceOffer handle it
        // The new peer will send us an offer, and we'll handle any duplicate
        // user connections at that point when we have the new peer_id to connect to.
        //
        // Cleaning up here causes a race condition where we disconnect before
        // establishing the new connection.
        break
      }

      case 'VoicePeerLeft': {
        const { peer_id: remotePeerId, user_id: remoteUserId, room_id } = msg
        console.log(`[WebRTC] Peer left: peer=${remotePeerId} user=${remoteUserId} room=${room_id}`)

        handlePeerDisconnect(remotePeerId)
        break
      }

      case 'VoiceOffer': {
        const { from_peer, from_user, sdp } = msg
        console.log(`[WebRTC] Received VoiceOffer from peer=${from_peer} user=${from_user}`)

        try {
          // Check if we already have a connection to this user
          const existingByUserId = findPeerByUserId(from_user)
          if (existingByUserId && existingByUserId.peerId !== from_peer) {
            console.log(`[WebRTC] User ${from_user} reconnected with new peer_id, replacing old connection`)
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
          console.log(`[WebRTC] Sent VoiceAnswer to peer=${from_peer}`)
        } catch (error) {
          console.error(`[WebRTC] Failed to handle VoiceOffer from ${from_peer}:`, error)
        }
        break
      }

      case 'VoiceAnswer': {
        const { from_peer, from_user, sdp } = msg
        console.log(`[WebRTC] Received VoiceAnswer from peer=${from_peer} user=${from_user}`)

        const peerInfo = peersRef.current.get(from_peer)
        if (peerInfo) {
          try {
            await handleAnswer(peerInfo.connection, sdp)
            console.log(`[WebRTC] Applied VoiceAnswer from peer=${from_peer}`)
          } catch (error) {
            console.error(`[WebRTC] Failed to apply VoiceAnswer from ${from_peer}:`, error)
          }
        } else {
          console.warn(`[WebRTC] Received VoiceAnswer from unknown peer ${from_peer}`)
        }
        break
      }

      case 'VoiceIceCandidate': {
        const { from_peer, candidate } = msg
        // Don't log every ICE candidate

        const peerInfo = peersRef.current.get(from_peer)
        if (peerInfo) {
          try {
            await addIceCandidate(peerInfo.connection, candidate)
          } catch (error) {
            console.error(`[WebRTC] Failed to add ICE candidate from ${from_peer}:`, error)
          }
        }
        break
      }

      case 'Error': {
        console.error('[WebRTC] Signaling error:', msg.message)
        break
      }

      default:
        // Ignore other message types (presence, profile, etc.)
        break
    }
  }, [createPeerConnectionForPeer, handlePeerDisconnect, findPeerByUserId])

  // Connect to signaling server (used for initial connect and reconnect)
  const connectToSignaling = useCallback(() => {
    if (!signalingUrl) {
      console.error('[WebRTC] Cannot connect: no signalingUrl')
      return
    }

    if (!currentRoomRef.current || !currentHouseRef.current) {
      console.error('[WebRTC] Cannot connect: missing room or house')
      return
    }

    console.log('[WebRTC] Connecting to signaling server...')
    const ws = new WebSocket(signalingUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[WebRTC] Connected to signaling server')

      // Register for voice in the room
      const registerMessage = {
        type: 'VoiceRegister',
        house_id: currentHouseRef.current,
        room_id: currentRoomRef.current,
        peer_id: currentPeerIdRef.current,
        user_id: currentUserIdRef.current
      }
      ws.send(JSON.stringify(registerMessage))
      console.log(`[WebRTC] Sent VoiceRegister: peer=${currentPeerIdRef.current} user=${currentUserIdRef.current}`)
    }

    ws.onmessage = (event) => {
      handleSignalingMessage(event.data)
    }

    ws.onerror = (error) => {
      console.error('[WebRTC] WebSocket error:', error)
    }

    ws.onclose = (event) => {
      console.log(`[WebRTC] WebSocket closed: code=${event.code} reason=${event.reason}`)
      wsRef.current = null

      // Clean up all peer connections - they'll be stale after reconnect
      // because the signaling state is lost
      console.log('[WebRTC] Cleaning up peer connections due to WebSocket disconnect')
      peersRef.current.forEach((peerInfo, peerId) => {
        cleanupPeerConnection(peerId, peerInfo)
      })
      setPeers(new Map())
      peersRef.current = new Map()

      // Layer A: Simple reconnect with fixed 2-second delay
      if (isInVoiceRef.current && currentRoomRef.current) {
        console.log('[WebRTC] Attempting reconnect in 2 seconds...')
        setTimeout(() => {
          if (isInVoiceRef.current && currentRoomRef.current) {
            // Generate a new peer_id for the reconnect session
            currentPeerIdRef.current = crypto.randomUUID()
            console.log(`[WebRTC] Reconnecting with new peer_id: ${currentPeerIdRef.current}`)
            connectToSignaling()
          }
        }, 2000)
      }
    }
  }, [signalingUrl, handleSignalingMessage, cleanupPeerConnection])

  const joinVoice = useCallback(async (roomId: string, houseId: string, userId: string) => {
    if (isInVoice) {
      console.warn('[WebRTC] Already in voice, leaving first')
      leaveVoiceInternal()
    }

    if (!signalingUrl) {
      console.error('[WebRTC] No signaling server URL configured')
      throw new Error('No signaling server configured')
    }

    // Initialize InputLevelMeter on-demand if not already set or if existing one is dead
    let meter = inputLevelMeterRef.current

    // Check if existing meter has a live stream
    let needsInit = !meter
    if (meter) {
      const existingStream = meter.getTransmissionStream()
      if (!existingStream) {
        console.log('[WebRTC] Existing meter has no stream, reinitializing...')
        needsInit = true
      } else {
        const tracks = existingStream.getAudioTracks()
        if (tracks.length === 0 || tracks[0].readyState === 'ended') {
          console.log('[WebRTC] Existing meter stream is dead (readyState=ended), reinitializing...')
          needsInit = true
        }
      }
    }

    if (needsInit) {
      console.log('[WebRTC] Initializing audio on-demand...')
      try {
        // Load saved audio settings
        const audioSettings = await loadAudioSettings()

        // Create and start InputLevelMeter
        const newMeter = new InputLevelMeter()
        await newMeter.start(
          audioSettings.input_device_id || null,
          () => {} // No level callback needed for WebRTC
        )

        // Apply saved settings
        newMeter.setGain(audioSettings.input_volume)
        newMeter.setThreshold(audioSettings.input_sensitivity)
        newMeter.setInputMode(audioSettings.input_mode)

        inputLevelMeterRef.current = newMeter
        meter = newMeter
        console.log('[WebRTC] Audio initialized successfully')
      } catch (error) {
        console.error('[WebRTC] Failed to initialize audio:', error)
        throw new Error('Failed to initialize audio. Please check microphone permissions.')
      }
    }

    // At this point meter should be valid
    if (!meter) {
      throw new Error('Failed to initialize audio meter')
    }

    // Generate EPHEMERAL peer_id for this session
    const peerId = crypto.randomUUID()

    console.log(`[WebRTC] Joining voice: room=${roomId} house=${houseId} peer=${peerId} user=${userId}`)

    // Get transmission stream from InputLevelMeter
    const stream = meter.getTransmissionStream()
    if (!stream) {
      console.error('[WebRTC] Failed to get transmission stream')
      throw new Error('Failed to get audio stream')
    }

    // Debug: check the transmission stream
    const audioTracks = stream.getAudioTracks()
    console.log(`[WebRTC] Transmission stream has ${audioTracks.length} audio tracks`)
    if (audioTracks.length > 0) {
      console.log(`[WebRTC] Transmission track: label="${audioTracks[0].label}", enabled=${audioTracks[0].enabled}, muted=${audioTracks[0].muted}, readyState=${audioTracks[0].readyState}`)
    }

    // Store refs
    localStreamRef.current = stream
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
  const leaveVoiceInternal = useCallback(() => {
    console.log('[WebRTC] Leaving voice - beginning cleanup')

    // 1. Notify server (best effort)
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const unregisterMessage = {
        type: 'VoiceUnregister',
        peer_id: currentPeerIdRef.current,
        room_id: currentRoomRef.current
      }
      wsRef.current.send(JSON.stringify(unregisterMessage))
      console.log('[WebRTC] Sent VoiceUnregister')
    }

    // 2. Close all peer connections
    peersRef.current.forEach((peerInfo, peerId) => {
      cleanupPeerConnection(peerId, peerInfo)
    })
    setPeers(new Map())
    peersRef.current = new Map()

    // 3. Close WebSocket
    if (wsRef.current) {
      wsRef.current.onclose = null  // Prevent reconnect handler from firing
      wsRef.current.close()
      wsRef.current = null
    }

    // 4. Clear local stream reference (don't stop tracks - owned by InputLevelMeter)
    localStreamRef.current = null

    // 5. Clear refs
    currentPeerIdRef.current = null
    currentUserIdRef.current = null
    currentRoomRef.current = null
    currentHouseRef.current = null

    // 6. Update state
    setIsInVoice(false)
    setCurrentRoomId(null)
    setIsLocalMuted(false)
    isInVoiceRef.current = false

    console.log('[WebRTC] Cleanup complete')
  }, [cleanupPeerConnection])

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
        setInputLevelMeter
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
