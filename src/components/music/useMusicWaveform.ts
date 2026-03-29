import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAttachmentRecord } from '../../lib/tauri'
import type { WaveformPeaksPayload } from '../../contexts/EphemeralMessagesContext'
import {
  LAZY_MEDIA_ROOT_MARGIN,
  SCRUB_COMPLETION_RATIO,
  SCRUB_END_EPSILON_SEC,
  SEEK_NUDGE_BACK_SEC,
  SEEK_NOOP_EPS_SEC,
  SKELETON_ACTIVE_BOTTOM_N,
  SKELETON_ACTIVE_TOP_N,
  SKELETON_BASE_FILL,
  SKELETON_GHOST_ALPHA,
  SKELETON_GHOST_BOTTOM_N,
  SKELETON_GHOST_TOP_N,
  SKELETON_HIGHLIGHT_SHARPNESS,
  SKELETON_HIGHLIGHT_SIGMA,
  SKELETON_INVERSE_SWEEP,
  WAVE_BARS,
  barRect,
  computeSeekTimeSeconds,
  extractSplitPeaksFromChannelData,
  hslFromVar,
  scrubRatioFromClientX,
  seededSplitPeaks,
  skeletonHighlightCenter,
  skeletonHighlightFalloff,
  formatAudioClock,
  type SplitPeaks,
  type WaveformStatus,
} from './musicWaveformShared'
import {
  clearDecodeInFlight,
  getCachedWaveformPeaks,
  getDecodeInFlight,
  getSharedDecodeAudioContext,
  setCachedWaveformPeaks,
  setDecodeInFlight,
} from './waveformDecodeCache'

function isValidPackedPeaks(w: { top: number[]; bottom: number[] } | null | undefined): w is WaveformPeaksPayload {
  return !!w && w.top.length === WAVE_BARS && w.bottom.length === WAVE_BARS
}

/** Spread decode + `get_attachment_record` IPC across frames when many audio rows arm at once (e.g. opening chat). */
function staggerMsForAudioRow(key: string | null | undefined): number {
  const s = key ?? ''
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % 112
  return h
}

export type UseMusicWaveformOptions = {
  audioSrc: string | null
  waveformSeed: string
  waveformPeaks?: WaveformPeaksPayload | null
  /** When set, we may load peaks from `get_attachment_record` if the message JSON omitted them. */
  attachmentId?: string | null
  /** When false, load/decode immediately (media modal). Default true (chat list). */
  lazyLoadMedia?: boolean
  /** When true (media modal), block play / scrub until waveform decode finishes. */
  gatePlayUntilWaveformReady?: boolean
  compact?: boolean
  waveHeight?: number
  onDecodedSampleRate?: (sampleRate: number) => void
}

export function useMusicWaveform({
  audioSrc,
  waveformSeed,
  waveformPeaks,
  attachmentId,
  lazyLoadMedia: lazyLoadMediaProp = true,
  gatePlayUntilWaveformReady = false,
  compact = false,
  waveHeight: waveHOverride,
  onDecodedSampleRate,
}: UseMusicWaveformOptions) {
  const cardRootRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const waveWrapRef = useRef<HTMLDivElement | null>(null)
  const pendingPlayRef = useRef(false)
  const pendingSeekRatioRef = useRef<number | null>(null)
  const playbackEndedRef = useRef(false)
  /** Deferred second seek when bouncing 0 → near-end; must be cancelled on replay / src change or it snaps the head back to the end. */
  const scrubEndRafRef = useRef<number | null>(null)

  const [shouldLoadMedia, setShouldLoadMedia] = useState(() => lazyLoadMediaProp === false)
  const [wantsPlaybackBuffer, setWantsPlaybackBuffer] = useState(false)

  const [playing, setPlaying] = useState(false)
  const [playbackEnded, setPlaybackEnded] = useState(false)

  const [progress, setProgress] = useState(0)
  const [dragProgress, setDragProgress] = useState<number | null>(null)
  const [currentSec, setCurrentSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)

  const isDraggingRef = useRef(false)
  const lastDragRatioRef = useRef(0)
  const wasPlayingBeforeWaveDragRef = useRef(false)
  const activeWaveDragPointerIdRef = useRef<number | null>(null)
  const waveDragCleanupRef = useRef<(() => void) | null>(null)
  const loadingAnimPhaseRef = useRef(0)
  const lastCanvasGeomRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 0 })
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)

  const displayProgress = dragProgress ?? progress

  const seeded = useMemo(() => seededSplitPeaks(waveformSeed, WAVE_BARS), [waveformSeed])

  const packagedPeaks = useMemo((): WaveformPeaksPayload | null => {
    const w = waveformPeaks
    if (!w || w.top.length !== WAVE_BARS || w.bottom.length !== WAVE_BARS) return null
    return w
  }, [waveformPeaks])

  const [peaks, setPeaks] = useState<SplitPeaks>(() => seeded)
  const [waveformStatus, setWaveformStatus] = useState<WaveformStatus>('seed')
  const seededRef = useRef(seeded)
  seededRef.current = seeded

  useEffect(() => {
    if (packagedPeaks) {
      setPeaks({ top: [...packagedPeaks.top], bottom: [...packagedPeaks.bottom] })
      setWaveformStatus('ready')
      return
    }
    setPeaks(seeded)
    setWaveformStatus('seed')
  }, [packagedPeaks, seeded])

  const canPlay = Boolean(audioSrc)
  /** Decode finished (real peaks or fallback). */
  const waveformPlaybackReady = waveformStatus === 'ready' || waveformStatus === 'error'
  const playbackUnlocked = !gatePlayUntilWaveformReady || waveformPlaybackReady

  const flushPendingPlay = useCallback(() => {
    if (!pendingPlayRef.current) return
    if (gatePlayUntilWaveformReady && !waveformPlaybackReady) return
    const el = audioRef.current
    if (!el) return
    if (el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return
    pendingPlayRef.current = false
    void el.play().catch(() => {})
  }, [gatePlayUntilWaveformReady, waveformPlaybackReady])

  /** Same as tapping play: wait for waveform gate + HAVE_FUTURE_DATA (canplay / loaded path calls flush again). */
  const armPendingPlay = useCallback(() => {
    pendingPlayRef.current = true
    setWantsPlaybackBuffer(true)
    flushPendingPlay()
  }, [flushPendingPlay])

  useEffect(() => {
    flushPendingPlay()
  }, [flushPendingPlay])

  const cancelScrubEndSeek = useCallback(() => {
    if (scrubEndRafRef.current != null) {
      cancelAnimationFrame(scrubEndRafRef.current)
      scrubEndRafRef.current = null
    }
  }, [])

  useEffect(() => {
    setShouldLoadMedia(!lazyLoadMediaProp ? true : false)
    setWantsPlaybackBuffer(false)
    pendingPlayRef.current = false
    pendingSeekRatioRef.current = null
    isDraggingRef.current = false
    setDragProgress(null)
    cancelScrubEndSeek()
    const el = audioRef.current
    if (el) {
      el.pause()
      setPlaying(false)
      playbackEndedRef.current = false
      setPlaybackEnded(false)
      setProgress(0)
      setCurrentSec(0)
      setDurationSec(0)
    }
  }, [audioSrc, waveformSeed, lazyLoadMediaProp, cancelScrubEndSeek])

  useEffect(() => {
    const root = cardRootRef.current
    if (!lazyLoadMediaProp || !root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setShouldLoadMedia(true)
        io.unobserve(root)
      },
      { root: null, rootMargin: LAZY_MEDIA_ROOT_MARGIN, threshold: 0 }
    )
    io.observe(root)
    return () => io.disconnect()
  }, [audioSrc, lazyLoadMediaProp])

  const syncTimeFromAudio = useCallback((el: HTMLAudioElement) => {
    const d = el.duration
    const t = el.currentTime
    if (Number.isFinite(d) && d > 0) {
      setProgress(t / d)
      setDurationSec(d)
    } else {
      setProgress(0)
    }
    if (Number.isFinite(t)) setCurrentSec(t)
  }, [])

  const runSeekNearEnd = useCallback(
    (el: HTMLAudioElement, d: number) => {
      cancelScrubEndSeek()
      if (!Number.isFinite(d) || d <= 0) return
      const target = Math.max(0, d - SCRUB_END_EPSILON_SEC)
      const cur = el.currentTime
      if (Math.abs(cur - target) < SEEK_NOOP_EPS_SEC) {
        el.currentTime = 0
        scrubEndRafRef.current = requestAnimationFrame(() => {
          scrubEndRafRef.current = null
          if (audioRef.current !== el) return
          const d2 = el.duration
          if (!Number.isFinite(d2) || d2 <= 0) return
          el.currentTime = Math.max(0, d2 - SCRUB_END_EPSILON_SEC)
        })
        return
      }
      el.currentTime = target
    },
    [cancelScrubEndSeek]
  )

  const commitSeekSeconds = useCallback(
    (el: HTMLAudioElement, seconds: number) => {
      if (!Number.isFinite(seconds) || seconds < 0) return
      const cur = el.currentTime
      const d = el.duration
      const scrubEnd =
        Number.isFinite(d) && d > 0 ? Math.max(0, d - SCRUB_END_EPSILON_SEC) : NaN
      const isScrubEndSnap =
        Number.isFinite(scrubEnd) && Math.abs(seconds - scrubEnd) < SEEK_NOOP_EPS_SEC
      if (seconds > 0 && Number.isFinite(cur) && Math.abs(cur - seconds) < SEEK_NOOP_EPS_SEC) {
        if (isScrubEndSnap && Number.isFinite(d) && d > 0) {
          runSeekNearEnd(el, d)
          queueMicrotask(() => {
            if (audioRef.current !== el) return
            syncTimeFromAudio(el)
          })
          return
        }
        el.currentTime = Math.max(0, seconds - SEEK_NUDGE_BACK_SEC)
      }
      el.currentTime = seconds
      queueMicrotask(() => {
        if (audioRef.current !== el) return
        syncTimeFromAudio(el)
      })
    },
    [syncTimeFromAudio, runSeekNearEnd]
  )

  const commitSeekRatio = useCallback(
    (el: HTMLAudioElement, ratio: number) => {
      const sec = computeSeekTimeSeconds(el, ratio)
      if (sec == null) return
      commitSeekSeconds(el, sec)
    },
    [commitSeekSeconds]
  )

  const onAudioLoadedMetadata = useCallback(
    (e: React.SyntheticEvent<HTMLAudioElement>) => {
      const el = e.currentTarget
      syncTimeFromAudio(el)
      const pending = pendingSeekRatioRef.current
      if (pending != null && Number.isFinite(el.duration) && el.duration > 0) {
        commitSeekRatio(el, pending)
        pendingSeekRatioRef.current = null
      }
      flushPendingPlay()
    },
    [syncTimeFromAudio, commitSeekRatio, flushPendingPlay]
  )

  const onAudioCanPlay = useCallback(() => {
    flushPendingPlay()
  }, [flushPendingPlay])

  useEffect(() => {
    if (!shouldLoadMedia) return
    const el = audioRef.current
    if (!el) return
    let rafId = 0

    const tick = () => {
      if (!isDraggingRef.current) {
        syncTimeFromAudio(el)
      }
      if (!el.paused) {
        rafId = requestAnimationFrame(tick)
      }
    }

    const onPlay = () => {
      setPlaying(true)
      playbackEndedRef.current = false
      setPlaybackEnded(false)
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(tick)
    }
    const onPause = () => {
      setPlaying(false)
      cancelAnimationFrame(rafId)
      if (!isDraggingRef.current) syncTimeFromAudio(el)
    }
    const onEnded = () => {
      setPlaying(false)
      cancelAnimationFrame(rafId)
      playbackEndedRef.current = true
      setPlaybackEnded(true)
      const d = el.duration
      if (Number.isFinite(d) && d > 0) {
        setProgress(1)
        setCurrentSec(d)
        setDurationSec(d)
      }
    }
    const onDuration = () => syncTimeFromAudio(el)
    const onSeeked = () => {
      const v = audioRef.current
      if (!v || v !== el) return
      const d = v.duration
      const t = v.currentTime
      if (Number.isFinite(d) && d > 0) {
        // Avoid clearing "ended" during seekNearEndOfScrubTrack's 0 → near-end bounce (breaks double scrub-to-end).
        const tail = Math.min(d * 0.5, Math.max(0.2, SCRUB_END_EPSILON_SEC * 4))
        const awayFromEnd = t < d - tail
        const awayFromStart = t > 0.04
        if (awayFromEnd && awayFromStart && !v.ended) {
          playbackEndedRef.current = false
          setPlaybackEnded(false)
        }
      }
      if (!isDraggingRef.current) syncTimeFromAudio(v)
    }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('durationchange', onDuration)
    el.addEventListener('seeked', onSeeked)

    if (!el.paused) {
      rafId = requestAnimationFrame(tick)
    }

    return () => {
      cancelAnimationFrame(rafId)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('durationchange', onDuration)
      el.removeEventListener('seeked', onSeeked)
    }
  }, [shouldLoadMedia, audioSrc, syncTimeFromAudio])

  useEffect(() => {
    if (packagedPeaks) return
    if (!shouldLoadMedia || !audioSrc) return
    let cancelled = false
    const stagger = staggerMsForAudioRow(attachmentId ?? audioSrc)
    const staggerId = window.setTimeout(() => {
      if (cancelled) return
      setWaveformStatus('loading')
      void runDecode()
    }, stagger)

    async function runDecode() {
      const src = audioSrc
      if (!src) return
      try {
        const aid = attachmentId?.trim()
        if (aid) {
          try {
            const rec = await getAttachmentRecord(aid)
            if (!cancelled && rec?.waveform_peaks && isValidPackedPeaks(rec.waveform_peaks)) {
              const w = rec.waveform_peaks
              const next = { top: [...w.top], bottom: [...w.bottom] }
              setPeaks(next)
              setWaveformStatus('ready')
              setCachedWaveformPeaks(src, next)
              return
            }
          } catch {
            /* fall through to decode */
          }
        }

        const cached = getCachedWaveformPeaks(src)
        if (cached && !cancelled) {
          setPeaks(cached)
          setWaveformStatus('ready')
          return
        }

        let decodePromise = getDecodeInFlight(src)
        if (!decodePromise) {
          decodePromise = (async (): Promise<SplitPeaks> => {
            const ac = getSharedDecodeAudioContext()
            if (ac.state === 'suspended') await ac.resume()
            // No AbortSignal: decodes may be shared across mounts; aborting would break waiters.
            const res = await fetch(src)
            if (!res.ok) throw new Error(`fetch ${res.status}`)
            const buf = await res.arrayBuffer()
            const audioBuffer = await ac.decodeAudioData(buf.slice(0))
            onDecodedSampleRate?.(audioBuffer.sampleRate)
            const ch = audioBuffer.getChannelData(0)
            const peaks = extractSplitPeaksFromChannelData(ch, WAVE_BARS)
            setCachedWaveformPeaks(src, peaks)
            return peaks
          })()
          setDecodeInFlight(src, decodePromise)
          void decodePromise.finally(() => clearDecodeInFlight(src))
        }

        const peaks = await decodePromise
        if (!cancelled) {
          setPeaks({ top: [...peaks.top], bottom: [...peaks.bottom] })
          setWaveformStatus('ready')
        }
      } catch {
        if (!cancelled) {
          setPeaks(seededRef.current)
          setWaveformStatus('error')
        }
      }
    }

    return () => {
      cancelled = true
      window.clearTimeout(staggerId)
    }
  }, [audioSrc, attachmentId, packagedPeaks, shouldLoadMedia, onDecodedSampleRate])

  const waveH = waveHOverride ?? (compact ? 20 : 32)

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = waveWrapRef.current
    if (!canvas || !wrap) return
    if (canvasElRef.current !== canvas) {
      canvasElRef.current = canvas
      lastCanvasGeomRef.current = { w: 0, h: 0, dpr: 0 }
      canvasCtxRef.current = null
    }
    const w = Math.max(1, Math.floor(wrap.clientWidth))
    const h = waveH
    const dpr = window.devicePixelRatio || 1
    const lg = lastCanvasGeomRef.current
    if (w !== lg.w || h !== lg.h || dpr !== lg.dpr) {
      lastCanvasGeomRef.current = { w, h, dpr }
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      canvasCtxRef.current = canvas.getContext('2d')
    }
    const ctx = canvasCtxRef.current ?? (canvasCtxRef.current = canvas.getContext('2d'))
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cy = h / 2
    const n = peaks.top.length
    if (n === 0) return

    const half = Math.max(1, Math.floor(h / 2) - 1)
    const topTrack = hslFromVar('--foreground', 0.26)
    const bottomTrack = hslFromVar('--foreground', 0.14)
    const topFg = hslFromVar('--primary', 1)
    const bottomFg = hslFromVar('--primary', 0.5)

    const playW = displayProgress * w

    const isSkeleton = waveformStatus === 'seed' || waveformStatus === 'loading'
    /** Only animate while decoding — never at 60fps for every nearby `seed` row (was main scroll-jank source). */
    const useAnimatedSkeleton = waveformStatus === 'loading'
    const skeletonT = useAnimatedSkeleton ? loadingAnimPhaseRef.current : 0

    if (isSkeleton) {
      const hiCenter = skeletonHighlightCenter(n, skeletonT)
      const ghostTopPx = SKELETON_GHOST_TOP_N * half
      const ghostBotPx = SKELETON_GHOST_BOTTOM_N * half
      const activeTopPx = SKELETON_ACTIVE_TOP_N * half
      const activeBotPx = SKELETON_ACTIVE_BOTTOM_N * half
      for (let i = 0; i < n; i++) {
        const { left, bw } = barRect(i, w, n)
        const gRaw = skeletonHighlightFalloff(i, hiCenter, SKELETON_HIGHLIGHT_SIGMA)
        const g = Math.pow(gRaw, SKELETON_HIGHLIGHT_SHARPNESS)
        const sweep = SKELETON_INVERSE_SWEEP ? 1 - g : g
        const m = SKELETON_BASE_FILL + (1 - SKELETON_BASE_FILL) * sweep

        ctx.globalAlpha = SKELETON_GHOST_ALPHA
        ctx.fillStyle = topTrack
        ctx.fillRect(left, cy - ghostTopPx, bw, ghostTopPx)
        ctx.fillStyle = bottomTrack
        ctx.fillRect(left, cy, bw, ghostBotPx)

        ctx.globalAlpha = 1
        ctx.fillStyle = topTrack
        ctx.fillRect(left, cy - activeTopPx * m, bw, activeTopPx * m)
        ctx.fillStyle = bottomTrack
        ctx.fillRect(left, cy, bw, activeBotPx * m)
      }
      ctx.globalAlpha = 1
    } else {
      for (let i = 0; i < n; i++) {
        const { left, bw } = barRect(i, w, n)
        const tl = peaks.top[i] ?? 0
        const bl = peaks.bottom[i] ?? 0
        const topPx = tl * half
        const botPx = bl * half
        ctx.fillStyle = topTrack
        ctx.fillRect(left, cy - topPx, bw, topPx)
        ctx.fillStyle = bottomTrack
        ctx.fillRect(left, cy, bw, botPx)
      }

      if (playW > 0) {
        for (let i = 0; i < n; i++) {
          const { left, bw } = barRect(i, w, n)
          const barRight = left + bw
          const fillEnd = Math.min(barRight, playW)
          if (fillEnd <= left) continue
          const ov = fillEnd - left
          const tl = peaks.top[i] ?? 0
          const bl = peaks.bottom[i] ?? 0
          const topPx = tl * half
          const botPx = bl * half
          ctx.fillStyle = topFg
          ctx.fillRect(left, cy - topPx, ov, topPx)
          ctx.fillStyle = bottomFg
          ctx.fillRect(left, cy, ov, botPx)
        }
      }
    }

    ctx.strokeStyle = hslFromVar('--foreground', 0.35)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, cy + 0.5)
    ctx.lineTo(w, cy + 0.5)
    ctx.stroke()

    if (displayProgress > 0) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const xDevice = Math.round(playW * dpr)
      const lineW = 2
      const hDevice = Math.round(h * dpr)
      ctx.fillStyle = hslFromVar('--primary-foreground', 1)
      ctx.fillRect(xDevice - Math.floor(lineW / 2), 0, lineW, hDevice)
      ctx.restore()
    }
  }, [peaks, displayProgress, waveH, waveformStatus])

  useEffect(() => {
    const run = waveformStatus === 'loading'
    if (!run) return
    const startMs = performance.now()
    loadingAnimPhaseRef.current = 0
    let id = 0
    const loop = (now: number) => {
      loadingAnimPhaseRef.current = (now - startMs) * 0.001
      drawWaveform()
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [waveformStatus, drawWaveform])

  useEffect(() => {
    drawWaveform()
    const wrap = waveWrapRef.current
    if (!wrap) return
    let roRaf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(roRaf)
      roRaf = requestAnimationFrame(() => drawWaveform())
    })
    ro.observe(wrap)
    return () => {
      cancelAnimationFrame(roRaf)
      ro.disconnect()
    }
  }, [drawWaveform])

  const togglePlay = useCallback(() => {
    if (!audioSrc) return
    if (!playbackUnlocked) return
    if (!shouldLoadMedia) {
      setShouldLoadMedia(true)
      setWantsPlaybackBuffer(true)
      pendingPlayRef.current = true
      return
    }
    const el = audioRef.current
    if (!el) {
      pendingPlayRef.current = true
      return
    }
    if (el.paused) {
      setWantsPlaybackBuffer(true)
      const d = el.duration
      const t = el.currentTime
      const nearEnd =
        el.ended || (Number.isFinite(d) && d > 0 && t >= d - SCRUB_END_EPSILON_SEC * 2)
      if (nearEnd || playbackEndedRef.current) {
        cancelScrubEndSeek()
        el.pause()
        playbackEndedRef.current = false
        setPlaybackEnded(false)
        let played = false
        let fallbackTid: ReturnType<typeof window.setTimeout> = 0 as ReturnType<typeof window.setTimeout>
        const tryPlay = () => {
          if (played) return
          played = true
          window.clearTimeout(fallbackTid)
          const a = audioRef.current
          if (!a || a !== el) return
          void a.play().catch(() => {})
        }
        fallbackTid = window.setTimeout(tryPlay, 320)
        el.addEventListener('seeked', tryPlay, { once: true })
        el.currentTime = 0
        syncTimeFromAudio(el)
      } else {
        void el.play().catch(() => {})
      }
    } else {
      el.pause()
    }
  }, [audioSrc, shouldLoadMedia, syncTimeFromAudio, playbackUnlocked])

  const finalizeWaveDrag = useCallback(() => {
    if (!isDraggingRef.current) return
    waveDragCleanupRef.current?.()
    waveDragCleanupRef.current = null

    const pid = activeWaveDragPointerIdRef.current
    activeWaveDragPointerIdRef.current = null
    const wrap = waveWrapRef.current
    if (pid != null && wrap) {
      try {
        if (typeof wrap.hasPointerCapture === 'function' && wrap.hasPointerCapture(pid)) {
          wrap.releasePointerCapture(pid)
        }
      } catch {
        /* already released */
      }
    }

    isDraggingRef.current = false
    setDragProgress(null)

    const el = audioRef.current
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return

    const ratio = lastDragRatioRef.current
    const d = el.duration

    if (ratio >= SCRUB_COMPLETION_RATIO) {
      playbackEndedRef.current = true
      setPlaybackEnded(true)
      el.pause()
      setPlaying(false)
      setProgress(1)
      setCurrentSec(d)
      setDurationSec(d)
      runSeekNearEnd(el, d)
      queueMicrotask(() => {
        setProgress(1)
        setCurrentSec(d)
        setDurationSec(d)
        syncTimeFromAudio(el)
      })
    } else {
      playbackEndedRef.current = false
      setPlaybackEnded(false)
      commitSeekRatio(el, ratio)
      if (wasPlayingBeforeWaveDragRef.current) {
        queueMicrotask(() => {
          const a = audioRef.current
          if (a && a === el) void a.play().catch(() => {})
        })
      }
    }
  }, [commitSeekRatio, syncTimeFromAudio])

  const onWavePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!canPlay || !playbackUnlocked || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      cancelScrubEndSeek()
      const target = e.currentTarget
      const wrap = waveWrapRef.current
      if (!wrap) return
      target.setPointerCapture(e.pointerId)
      activeWaveDragPointerIdRef.current = e.pointerId
      isDraggingRef.current = true
      const ratio = scrubRatioFromClientX(e.clientX, wrap)
      lastDragRatioRef.current = ratio
      setDragProgress(ratio)
      setWantsPlaybackBuffer(true)

      const pid = e.pointerId
      const onWinFinalize = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return
        finalizeWaveDrag()
      }
      waveDragCleanupRef.current = () => {
        window.removeEventListener('pointerup', onWinFinalize)
        window.removeEventListener('pointercancel', onWinFinalize)
      }
      window.addEventListener('pointerup', onWinFinalize)
      window.addEventListener('pointercancel', onWinFinalize)

      if (!shouldLoadMedia) {
        wasPlayingBeforeWaveDragRef.current = false
        pendingSeekRatioRef.current = ratio
        setShouldLoadMedia(true)
        return
      }
      const el = audioRef.current
      if (el && Number.isFinite(el.duration) && el.duration > 0) {
        if (el.ended) {
          runSeekNearEnd(el, el.duration)
        }
        wasPlayingBeforeWaveDragRef.current = !el.paused
        playbackEndedRef.current = false
        setPlaybackEnded(false)
        el.pause()
        setPlaying(false)
      } else {
        wasPlayingBeforeWaveDragRef.current = false
        pendingSeekRatioRef.current = ratio
      }
    },
    [canPlay, shouldLoadMedia, finalizeWaveDrag, playbackUnlocked, cancelScrubEndSeek, runSeekNearEnd]
  )

  const onWavePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    const w = waveWrapRef.current
    if (!w) return
    const ratio = scrubRatioFromClientX(e.clientX, w)
    lastDragRatioRef.current = ratio
    setDragProgress(ratio)
  }, [])

  const onWavePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLDivElement>) => {
      finalizeWaveDrag()
    },
    [finalizeWaveDrag]
  )

  useEffect(() => {
    return () => {
      if (scrubEndRafRef.current != null) {
        cancelAnimationFrame(scrubEndRafRef.current)
        scrubEndRafRef.current = null
      }
      waveDragCleanupRef.current?.()
      waveDragCleanupRef.current = null
      if (isDraggingRef.current) {
        isDraggingRef.current = false
      }
      activeWaveDragPointerIdRef.current = null
    }
  }, [])

  const rowHeightClass = compact ? 'h-5' : 'h-8'

  const displayCurrentSec =
    dragProgress != null && Number.isFinite(durationSec) && durationSec > 0 ? dragProgress * durationSec : currentSec

  const preloadAttr: 'none' | 'metadata' | 'auto' = !shouldLoadMedia
    ? 'none'
    : wantsPlaybackBuffer
      ? 'auto'
      : 'metadata'

  return {
    cardRootRef,
    audioRef,
    canvasRef,
    waveWrapRef,
    shouldLoadMedia,
    audioSrc,
    preloadAttr,
    onAudioLoadedMetadata,
    onAudioCanPlay,
    playing,
    playbackEnded,
    canPlay,
    togglePlay,
    armPendingPlay,
    /** 0–1 playback position for accessibility */
    displayProgress,
    displayCurrentSec,
    durationSec,
    waveH,
    rowHeightClass,
    onWavePointerDown,
    onWavePointerMove,
    onWavePointerUp,
    formatSplitTime: (cur: number, tot: number) =>
      Number.isFinite(tot) && tot > 0 ? `${formatAudioClock(cur, tot)} / ${formatAudioClock(tot, tot)}` : '— / —',
    formatClock: formatAudioClock,
    waveformStatus,
    waveformPlaybackReady,
  }
}
