import type { SplitPeaks } from './musicWaveformShared'

/** One context for all Web Audio decodes — avoids create/close churn per chat row. */
let sharedDecodeCtx: AudioContext | null = null

export function getSharedDecodeAudioContext(): AudioContext {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!sharedDecodeCtx || sharedDecodeCtx.state === 'closed') {
    sharedDecodeCtx = new AC()
  }
  return sharedDecodeCtx
}

const MAX_ENTRIES = 48
/** Same file URL → reuse peaks (scroll back in chat, multiple mounts). */
const peaksCache = new Map<string, SplitPeaks>()
/** Deduplicate concurrent decodes for the same `audioSrc`. */
const decodeInFlight = new Map<string, Promise<SplitPeaks>>()

function clonePeaks(p: SplitPeaks): SplitPeaks {
  return { top: [...p.top], bottom: [...p.bottom] }
}

export function getCachedWaveformPeaks(audioSrc: string): SplitPeaks | null {
  const hit = peaksCache.get(audioSrc)
  return hit ? clonePeaks(hit) : null
}

export function setCachedWaveformPeaks(audioSrc: string, peaks: SplitPeaks): void {
  if (peaksCache.size >= MAX_ENTRIES && !peaksCache.has(audioSrc)) {
    const first = peaksCache.keys().next().value as string | undefined
    if (first) peaksCache.delete(first)
  }
  peaksCache.set(audioSrc, clonePeaks(peaks))
}

export function getDecodeInFlight(audioSrc: string): Promise<SplitPeaks> | undefined {
  return decodeInFlight.get(audioSrc)
}

export function setDecodeInFlight(audioSrc: string, p: Promise<SplitPeaks>): void {
  decodeInFlight.set(audioSrc, p)
}

export function clearDecodeInFlight(audioSrc: string): void {
  decodeInFlight.delete(audioSrc)
}
