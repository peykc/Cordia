import type { WaveformPeaksPayload } from '../domain/content/types'
import { WAVE_BARS } from '../components/music/musicWaveformShared'

/** Same bar count as native prep / Web decode — use when attaching peaks to outgoing chat metadata. */
export function isValidWaveformPeaksPayload(w: unknown): w is WaveformPeaksPayload {
  if (!w || typeof w !== 'object') return false
  const o = w as { top?: unknown; bottom?: unknown }
  return (
    Array.isArray(o.top) &&
    Array.isArray(o.bottom) &&
    o.top.length === WAVE_BARS &&
    o.bottom.length === WAVE_BARS &&
    o.top.every((x) => typeof x === 'number') &&
    o.bottom.every((x) => typeof x === 'number')
  )
}
