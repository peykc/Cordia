/**
 * Receiver-side per-user volume and local mute.
 * Keyed by remote user identity (userId). Persisted per user; survives reconnects.
 * One RX AudioContext; per-remote-user graph: stream → source → gain → destination.
 */

const STORAGE_KEY = 'cordia:receiver_audio_prefs'

export interface PerUserAudioPrefs {
  volume: number   // 0.0 – 2.0 (default 1.0)
  muted: boolean
}

export type AudioPrefsByUser = Record<string, PerUserAudioPrefs>

const DEFAULT_PREFS: PerUserAudioPrefs = { volume: 1.0, muted: false }

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1.0
  return Math.max(0, Math.min(2, v))
}

interface RemoteAudioNode {
  source: MediaStreamAudioSourceNode
  gain: GainNode
}

let rxAudioContext: AudioContext | null = null
const remoteAudioNodes: Record<string, RemoteAudioNode> = {}
let audioPrefs: AudioPrefsByUser = {}

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, { volume?: number; muted?: boolean }>
      audioPrefs = {}
      for (const [userId, p] of Object.entries(parsed)) {
        audioPrefs[userId] = {
          volume: clampVolume(p.volume ?? DEFAULT_PREFS.volume),
          muted: Boolean(p.muted),
        }
      }
    } else {
      audioPrefs = {}
    }
  } catch {
    audioPrefs = {}
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(audioPrefs))
  } catch (e) {
    console.warn('[ReceiverAudio] Failed to persist prefs:', e)
  }
}

function ensureContext(): AudioContext {
  if (rxAudioContext) return rxAudioContext
  rxAudioContext = new AudioContext()
  return rxAudioContext
}

/**
 * Resume the single RX AudioContext (call on first user interaction, e.g. join call).
 */
export function resumeRxAudioContext(): void {
  const ctx = ensureContext()
  if (ctx.state === 'suspended') {
    ctx.resume().catch((e) => console.warn('[ReceiverAudio] Resume failed:', e))
  }
}

/**
 * Get the single RX AudioContext (for sharing with RemoteAudioAnalyzer so it runs without a second suspended context).
 */
export function getRxAudioContext(): AudioContext {
  return ensureContext()
}

/**
 * Attach remote user audio: create source → gain → destination. Apply saved prefs.
 * Call when we receive a remote track (ontrack). Key by remote userId.
 */
export function attachRemoteUserAudio(userId: string, stream: MediaStream): void {
  const ctx = ensureContext()
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }

  const prefs = audioPrefs[userId] ?? { ...DEFAULT_PREFS }
  const source = ctx.createMediaStreamSource(stream)
  const gain = ctx.createGain()
  gain.gain.value = prefs.muted ? 0 : prefs.volume

  source.connect(gain)
  gain.connect(ctx.destination)

  remoteAudioNodes[userId] = { source, gain }
}

/**
 * Update volume for a user (0–2). Mute does not overwrite stored volume.
 */
export function setUserVolume(userId: string, volume: number): void {
  const node = remoteAudioNodes[userId]
  const v = clampVolume(volume)
  if (!audioPrefs[userId]) audioPrefs[userId] = { ...DEFAULT_PREFS }
  audioPrefs[userId].volume = v
  if (node && !audioPrefs[userId].muted) {
    node.gain.gain.value = v
  }
  savePrefs()
}

/**
 * Local mute: gain = 0 when muted; on unmute restore stored volume.
 * Do not touch tracks; do not overwrite stored volume.
 */
export function setUserMuted(userId: string, muted: boolean): void {
  const node = remoteAudioNodes[userId]
  if (!audioPrefs[userId]) audioPrefs[userId] = { ...DEFAULT_PREFS }
  audioPrefs[userId].muted = muted
  if (node) {
    node.gain.gain.value = muted ? 0 : audioPrefs[userId].volume
  }
  savePrefs()
}

/**
 * Get prefs for a user (for UI). Returns default if never set.
 */
export function getPrefs(userId: string): PerUserAudioPrefs {
  return audioPrefs[userId] ?? { ...DEFAULT_PREFS }
}

/**
 * Detach and destroy audio nodes when remote user leaves. Do NOT delete prefs.
 */
export function detachRemoteUserAudio(userId: string): void {
  const node = remoteAudioNodes[userId]
  if (!node) return
  try {
    node.source.disconnect()
    node.gain.disconnect()
  } catch (_) {
    // ignore if already disconnected
  }
  delete remoteAudioNodes[userId]
}

/**
 * Set output device (sink) for the RX context when supported.
 */
export function setOutputDevice(sinkId: string): void {
  if (!rxAudioContext) return
  if ('setSinkId' in rxAudioContext) {
    (rxAudioContext as AudioContext & { setSinkId(id: string): Promise<void> })
      .setSinkId(sinkId)
      .catch((e) => console.warn('[ReceiverAudio] setSinkId failed:', e))
  }
}

/**
 * Load persisted prefs at app init (call once from provider).
 */
export function initReceiverAudio(): void {
  loadPrefs()
}
