/**
 * WebRTC utilities for peer-to-peer voice connections
 */

// RTCConfiguration for P2P-only voice (no TURN). Order matters: faster reflexive candidates first.
// TCP candidate gathering is implementation-defined; no standard config knob.
export const PEER_CONNECTION_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.sipgate.net:3478' },
    { urls: 'stun:stun.nextcloud.com:3478' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceTransportPolicy: 'all'
}

/**
 * Audio constraints for WebRTC transmission
 * Matches InputLevelMeter settings: 48kHz, mono, no AGC
 */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  autoGainControl: false,    // Manual gain via InputLevelMeter
  echoCancellation: true,    // Enable for WebRTC (prevents echo)
  noiseSuppression: false,   // Manual VAD/PTT gating
  sampleRate: 48000,
  channelCount: 1
}

/**
 * Create a new RTCPeerConnection with default configuration.
 * Overrides iceCandidatePoolSize to 20 for long calls and warmup: better candidate
 * selection before connect with minimal cost.
 */
export function createPeerConnection(): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    ...PEER_CONNECTION_CONFIG,
    iceCandidatePoolSize: 20
  })

  // Log connection state changes for debugging
  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Connection state: ${pc.connectionState}`)
  }

  pc.oniceconnectionstatechange = () => {
    console.log(`[WebRTC] ICE connection state: ${pc.iceConnectionState}`)
  }

  return pc
}

/**
 * True if the last/selected candidate pair was P2P (host/srflx only, no relay).
 * Used to trigger one immediate ICE restart on "failed" when we were on a direct path.
 */
export async function isLastPathP2P(pc: RTCPeerConnection): Promise<boolean> {
  try {
    const report = await pc.getStats()
    const candidateTypes = new Map<string, string>()
    report.forEach((stats) => {
      const s = stats as RTCStats & { type: string; id: string; candidateType?: string }
      if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
        if (s.candidateType) candidateTypes.set(s.id, s.candidateType)
      }
    })
    let foundP2PPair = false
    report.forEach((stats) => {
      const s = stats as RTCStats & { type: string; localCandidateId?: string; remoteCandidateId?: string; state?: string }
      if (s.type !== 'candidate-pair') return
      if (s.state !== 'succeeded' && s.state !== 'in-progress') return
      const localType = candidateTypes.get(s.localCandidateId ?? '')
      const remoteType = candidateTypes.get(s.remoteCandidateId ?? '')
      if (!localType || !remoteType) return
      const p2p =
        (localType === 'host' || localType === 'srflx' || localType === 'prflx') &&
        (remoteType === 'host' || remoteType === 'srflx' || remoteType === 'prflx')
      if (p2p) foundP2PPair = true
    })
    return foundP2PPair
  } catch {
    return false
  }
}

/**
 * Create an SDP offer
 *
 * Note: We don't wait for ICE gathering to complete - candidates are trickled
 * asynchronously via the onicecandidate handler for faster connection setup.
 */
export interface CreateOfferOptions {
  iceRestart?: boolean
}

export async function createOffer(pc: RTCPeerConnection, options?: CreateOfferOptions): Promise<string> {
  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: false,
    iceRestart: options?.iceRestart ?? false
  })

  await pc.setLocalDescription(offer)

  return JSON.stringify(pc.localDescription)
}

/**
 * Create an SDP answer for a remote offer
 */
export async function createAnswer(pc: RTCPeerConnection, offerSdp: string): Promise<string> {
  const offer = JSON.parse(offerSdp)
  await pc.setRemoteDescription(new RTCSessionDescription(offer))

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  return JSON.stringify(pc.localDescription)
}

/**
 * Handle a remote answer
 */
export async function handleAnswer(pc: RTCPeerConnection, answerSdp: string): Promise<void> {
  const answer = JSON.parse(answerSdp)
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
}

/**
 * Add an ICE candidate to the peer connection
 */
export async function addIceCandidate(pc: RTCPeerConnection, candidateJson: string): Promise<void> {
  try {
    const candidate = JSON.parse(candidateJson)
    if (candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate))
    }
  } catch (error) {
    console.error('[WebRTC] Failed to add ICE candidate:', error)
  }
}

/**
 * Attach audio track from MediaStream to peer connection
 */
export function attachAudioTrack(pc: RTCPeerConnection, stream: MediaStream): void {
  const audioTracks = stream.getAudioTracks()

  if (audioTracks.length === 0) {
    console.warn('[WebRTC] No audio tracks in stream')
    return
  }

  // Add the first audio track to the peer connection
  const audioTrack = audioTracks[0]
  pc.addTrack(audioTrack, stream)

  console.log('[WebRTC] Audio track attached:', audioTrack.label)
}

/**
 * Create an HTMLAudioElement for playing remote audio
 */
export function createRemoteAudioElement(stream: MediaStream, deviceId?: string): HTMLAudioElement {
  const audio = new Audio()
  audio.srcObject = stream
  audio.autoplay = true

  // Set output device if specified
  if (deviceId && 'setSinkId' in audio) {
    (audio as any).setSinkId(deviceId).catch((error: Error) => {
      console.warn('[WebRTC] Failed to set audio output device:', error)
    })
  }

  // Start playback
  audio.play().catch(error => {
    console.error('[WebRTC] Failed to play remote audio:', error)
  })

  return audio
}

/**
 * Close and cleanup a peer connection
 * 
 * NOTE: We do NOT stop the tracks here because the local audio track is SHARED
 * across all peer connections. Stopping it would silence all connections.
 * The track should only be stopped when completely leaving voice (in leaveVoiceInternal).
 */
export function closePeerConnection(pc: RTCPeerConnection): void {
  // Just close the connection - this removes tracks from the connection
  // but does NOT stop the underlying MediaStreamTrack
  pc.close()
}

/**
 * Stop and cleanup a remote audio element
 */
export function stopRemoteAudio(audio: HTMLAudioElement): void {
  audio.pause()
  audio.srcObject = null
}
