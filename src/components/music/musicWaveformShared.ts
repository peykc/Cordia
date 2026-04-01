/** More segments = thinner stripes on canvas (SoundCloud-style density). */
export const WAVE_BARS = 100
/** Fraction of each cell width filled (rest = gap). */
export const BAR_FILL = 1

/** Seek slightly before the true end while dragging so we do not spuriously fire `ended` mid-scrub. */
export const SCRUB_END_EPSILON_SEC = 0.05

/** Release ratio at or past this counts as "scrub to completion" — pause at true end + replay UI (same as natural `ended`). */
export const SCRUB_COMPLETION_RATIO = 0.999

/** Tight no-op window confuses Chromium/WebView after repeated end-of-track scrubs — keep slightly loose. */
export const SEEK_NOOP_EPS_SEC = 0.08
export const SEEK_NUDGE_BACK_SEC = 0.14

/** Seconds for one full sweep: left edge → right edge → left edge (bounce). */
export const SKELETON_SWEEP_PERIOD_SEC = 5.5

/** Faint "empty" bars use a flat height so we don't stack a smooth wave silhouette under the bar highlight. */
export const SKELETON_GHOST_TOP_N = 0.25
export const SKELETON_GHOST_BOTTOM_N = 0.045
export const SKELETON_GHOST_ALPHA = 0.16
export const SKELETON_ACTIVE_TOP_N = 1
export const SKELETON_ACTIVE_BOTTOM_N = 0.75
export const SKELETON_BASE_FILL = 0.35
export const SKELETON_HIGHLIGHT_SIGMA = 10
export const SKELETON_HIGHLIGHT_SHARPNESS = 64
export const SKELETON_INVERSE_SWEEP = false

/**
 * Cap redraw rate for the animated loading skeleton (still smooth motion, not static).
 * Avoids 60fps × N cards during scroll; tune 20–30 for feel vs cost.
 */
export const LOADING_WAVEFORM_MAX_FPS = 24

/** While playing, sync React state (time labels, aria) at most this often; canvas uses refs + RAF in between. */
export const WAVEFORM_TRANSPORT_UI_SYNC_MS = 80

/** Start loading audio / client waveform only when near viewport (reduces N× decode when many tracks). */
export const LAZY_MEDIA_ROOT_MARGIN = '120px'

/** Music cover `img` + `ensure_music_cover_thumbnail`: tighter than waveform so fewer off-screen covers load at once. */
export const LAZY_CHAT_COVER_ROOT_MARGIN = '48px'

export type WaveformStatus = 'seed' | 'loading' | 'ready' | 'error'

export type SplitPeaks = { top: number[]; bottom: number[] }

export function computeSeekTimeSeconds(el: HTMLAudioElement, ratio: number): number | null {
  const d = el.duration
  if (!(Number.isFinite(d) && d > 0)) return null
  const r = Math.min(Math.max(0, ratio), 1)
  return Math.min(r * d, Math.max(0, d - SCRUB_END_EPSILON_SEC))
}

/**
 * Seek to the usual scrub-to-completion time (just before true duration).
 * If the playhead is already there, Chromium/WebView often treats another seek to the same
 * time as a no-op and playback stays broken — jump to 0 first so the seek always applies.
 */
export function seekNearEndOfScrubTrack(el: HTMLAudioElement, d: number): void {
  if (!Number.isFinite(d) || d <= 0) return
  const target = Math.max(0, d - SCRUB_END_EPSILON_SEC)
  const cur = el.currentTime
  if (Math.abs(cur - target) < SEEK_NOOP_EPS_SEC) {
    el.currentTime = 0
  }
  el.currentTime = target
}

export function barRect(i: number, w: number, n: number): { left: number; bw: number } {
  const cellL = Math.floor((i * w) / n)
  const cellR = Math.floor(((i + 1) * w) / n)
  const cw = Math.max(1, cellR - cellL)
  const bw = Math.max(1, Math.floor(cw * BAR_FILL))
  const left = cellL + Math.floor((cw - bw) / 2)
  return { left, bw }
}

export function scrubRatioFromClientX(clientX: number, target: HTMLElement): number {
  const rect = target.getBoundingClientRect()
  const x = Math.min(Math.max(0, clientX - rect.left), rect.width)
  return rect.width > 0 ? x / rect.width : 0
}

/** Deterministic bar heights — separate seeds; bottom capped lower like decoded `normalizeToBandHeight`. */
export function seededSplitPeaks(seed: string, bars: number): SplitPeaks {
  const top = seededWaveformHeights(`${seed}\0top`, bars)
  const bottomFull = seededWaveformHeights(`${seed}\0bottom`, bars)
  const bottom = bottomFull.map((v) => 0.04 + ((v - 0.06) / 0.94) * 0.44)
  return { top, bottom }
}

function seededWaveformHeights(seed: string, bars: number): number[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  const out: number[] = []
  for (let i = 0; i < bars; i++) {
    h = Math.imul(h ^ i, 11400714819323198485)
    h ^= h >>> 13
    const u = (h >>> 0) / 0xffffffff
    out.push(0.06 + u * 0.94)
  }
  return out
}

/** Bar index of the virtual "cursor"; triangle bounce so motion starts at the left end, not mid-waveform. */
export function skeletonHighlightCenter(n: number, tSec: number): number {
  if (n <= 1) return 0
  const u = (tSec * 2) / SKELETON_SWEEP_PERIOD_SEC
  const phase = ((u % 2) + 2) % 2
  const p = phase < 1 ? phase : 2 - phase
  return (n - 1) * p
}

/** Gaussian falloff like hover spill to neighbors (stronger at center bar). */
export function skeletonHighlightFalloff(i: number, center: number, sigma: number): number {
  const dist = i - center
  return Math.exp(-(dist * dist) / (2 * sigma * sigma))
}

function rmsSegment(channelData: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let j = start; j < end; j++) {
    const x = channelData[j]!
    sum += x * x
  }
  const n = Math.max(1, end - start)
  return Math.sqrt(sum / n)
}

/**
 * Top = early half of each window, bottom = late half (not mirrored).
 * Per-file max normalization: loudest segment in this track → full band height; everything else scales linearly.
 */
export function extractSplitPeaksFromChannelData(channelData: Float32Array, barCount: number): SplitPeaks {
  const len = channelData.length
  const block = Math.max(1, Math.floor(len / barCount))
  const rawTop: number[] = []
  const rawBottom: number[] = []
  for (let i = 0; i < barCount; i++) {
    const start = i * block
    const end = Math.min(start + block, len)
    const mid = start + Math.floor((end - start) / 2)
    rawTop.push(rmsSegment(channelData, start, mid))
    rawBottom.push(rmsSegment(channelData, mid, end))
  }
  return {
    top: normalizeToBandHeight(rawTop, { minH: 0.04, maxH: 0.98 }),
    bottom: normalizeToBandHeight(rawBottom, { minH: 0.04, maxH: 0.48 }),
  }
}

/** Linear scale: max(raw) in this file maps to maxH (loudest moment uses full stripe for that band). */
function normalizeToBandHeight(raw: number[], opts: { minH: number; maxH: number }): number[] {
  const { minH, maxH } = opts
  if (raw.length === 0) return raw
  const mx = Math.max(...raw, 1e-12)
  return raw.map((v) => {
    const n = v / mx
    return minH + n * (maxH - minH)
  })
}

/** Clock for current/total; uses `h:mm:ss` when the track is long or `seconds` is ≥ 1h. */
export function formatAudioClock(seconds: number, referenceTotalSec: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const ref = Number.isFinite(referenceTotalSec) && referenceTotalSec > 0 ? referenceTotalSec : 0
  const useHours = ref >= 3600 || s >= 3600
  if (useHours) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const r = s % 60
    return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
  }
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

export function hslFromVar(varName: string, alpha: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  if (!raw) return `hsl(0 0% 50% / ${alpha})`
  return `hsl(${raw} / ${alpha})`
}
