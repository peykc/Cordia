/**
 * WebRTC utilities for peer-to-peer voice connections
 */

// RTCConfiguration with STUN servers for NAT traversal (multiple providers improve connection success and recovery)
export const PEER_CONNECTION_CONFIG: RTCConfiguration = {
  iceServers: [
    // Google (already good)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Cloudflare (excellent global reach)
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Twilio public STUN (no account needed)
    { urls: 'stun:global.stun.twilio.com:3478' },
    // Fallback generic
    { urls: 'stun:stun.sipgate.net:3478' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
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
 * Create a new RTCPeerConnection with default configuration
 */
export function createPeerConnection(): RTCPeerConnection {
  const pc = new RTCPeerConnection(PEER_CONNECTION_CONFIG)

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
