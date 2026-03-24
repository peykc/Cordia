import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { Play, Pause, RotateCcw, Volume2, VolumeX, Maximize, Minimize2, ChevronUp, ChevronDown, PictureInPicture, Loader2 } from 'lucide-react'
import { getCurrent } from '@tauri-apps/api/window'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { useVideoFullscreen } from '../contexts/VideoFullscreenContext'

const PLAYBACK_SPEED_MIN = 0.25
const PLAYBACK_SPEED_MAX = 2
const PLAYBACK_SPEED_STEP = 0.25

/** Breakpoints for dynamic control sizing */
const WIDTH_COMPACT = 360
const WIDTH_LARGE = 720

/** Meta row wraps vertically → move hide above. */
const HIDE_CHROME_META_OVERFLOW_ENTER_PX = 3
/** Hide button closer than this to the end of the time text (or overlapping) → move hide to its own row above. */
const HIDE_TIME_GAP_COLLISION_ENTER_PX = 6
/** After colliding, only allow inline hide again once the player is this many px wider (avoids flip-flop; gutter metric breaks when center column is empty). */
const HIDE_INLINE_WIDTH_EXIT_DELTA_PX = 36
/** Ignore “exit above” until this long after entering above (stabilizes layout + ResizeObserver bursts). */
const HIDE_PLACEMENT_SETTLE_MS = 160

/** Truncation levels when compact layout overflows: 0=none, 1=time above, 2=+PiP above, 3=+speed above */
type TruncationLevel = 0 | 1 | 2 | 3

const VIDEO_VOLUME_STORAGE_KEY = 'cordia:video-player:volume'

function loadStoredVolume(): { volume: number; muted: boolean } {
  try {
    const raw = localStorage.getItem(VIDEO_VOLUME_STORAGE_KEY)
    if (!raw) return { volume: 1, muted: false }
    const parsed = JSON.parse(raw) as { volume?: number; muted?: boolean }
    const volume = typeof parsed.volume === 'number' ? Math.max(0, Math.min(1, parsed.volume)) : 1
    const muted = !!parsed.muted
    return { volume, muted }
  } catch {
    return { volume: 1, muted: false }
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

type Props = {
  src: string
  className?: string
  onCanPlay?: () => void
  /** Called when video metadata loads, with intrinsic dimensions for aspect-ratio sizing */
  onAspectRatio?: (videoWidth: number, videoHeight: number) => void
  /** When false, controls are hidden (e.g. when not hovering) */
  showControls?: boolean
  /** When true (e.g. in-chat player), keep controls visible while video is paused */
  keepControlsWhenPaused?: boolean
  /** Start playing as soon as the video can play (e.g. for inline chat playback) */
  autoPlay?: boolean
  /** When going fullscreen, pass so we can scroll this element back into view on exit. */
  getScrollTarget?: () => HTMLElement | null
  /** Notified when playback state changes (play / pause / ended). */
  onPlayingChange?: (playing: boolean) => void
  /** True after `ended` until replay or seek clears it (mirrors main play button replay vs play). */
  onPlaybackEndedChange?: (ended: boolean) => void
  /** When set (e.g. media preview), paused state can hide all chrome behind a chevron toggle. */
  collapsibleChrome?: boolean
  /** When true, main controls + progress are hidden; only the expand strip is shown. */
  chromeCollapsed?: boolean
  onChromeCollapsedChange?: (collapsed: boolean) => void
}

export function CustomVideoPlayer({
  src,
  className,
  onCanPlay,
  onAspectRatio,
  showControls = false,
  keepControlsWhenPaused = false,
  autoPlay = false,
  getScrollTarget,
  onPlayingChange,
  onPlaybackEndedChange,
  collapsibleChrome = false,
  chromeCollapsed = false,
  onChromeCollapsedChange,
}: Props) {
  const { setNativeVideoFullscreen } = useVideoFullscreen()
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasAutoPlayedRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  /** True after `ended` until user replays or seeks away (drives replay control vs play). */
  const [playbackEnded, setPlaybackEnded] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(() => loadStoredVolume().volume)
  const [muted, setMuted] = useState(() => loadStoredVolume().muted)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const [isInPictureInPicture, setIsInPictureInPicture] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  /** When true, fullscreen is OS-level (Tauri window); container uses fixed inset-0 to fill the window. */
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false)
  const [isDraggingProgress, setIsDraggingProgress] = useState(false)
  const volumeSliderRef = useRef<HTMLDivElement>(null)
  const [isDraggingVolume, setIsDraggingVolume] = useState(false)
  const speedMenuContainerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const belowBarRowRef = useRef<HTMLDivElement>(null)
  /** Inner row: intrinsic width of “full” compact bottom bar (for un-truncate). */
  const measureRowRef = useRef<HTMLDivElement>(null)
  /** Outer slot width (controls strip); inner must fit here to restore single-row layout. */
  const measureCompactRowOuterRef = useRef<HTMLDivElement>(null)
  const truncationRafRef = useRef(0)
  const [truncationLevel, setTruncationLevel] = useState<TruncationLevel>(0)
  /** When true, hide-chrome sits above the compact meta row instead of between meta and scrubber. */
  const [hideChromeAboveMeta, setHideChromeAboveMeta] = useState(false)
  const hideChromePlacementRef = useRef(false)
  const compactMetaRowRef = useRef<HTMLDivElement>(null)
  const compactMetaTimeRef = useRef<HTMLSpanElement>(null)
  const compactMetaHideButtonRef = useRef<HTMLButtonElement>(null)
  const compactMetaRightClusterRef = useRef<HTMLDivElement>(null)
  /** Container width when we last moved hide above (width-based exit hysteresis). */
  const hideCollidedAtWidthRef = useRef<number | null>(null)
  /** performance.now() when hide moved above; used so we don't exit above during layout settle. */
  const hideEnteredAboveAtRef = useRef<number | null>(null)
  const hidePlacementRafRef = useRef<number>(0)
  const [isBuffering, setIsBuffering] = useState(false)
  /** Avoid notifying parent with stale `false` before the first play/pause/ended from the element. */
  const hasEmittedPlayingRef = useRef(false)
  const prevSrcForPlayingNotifyRef = useRef(src)

  useEffect(() => {
    if (prevSrcForPlayingNotifyRef.current !== src) {
      prevSrcForPlayingNotifyRef.current = src
      return
    }
    if (!playing && !hasEmittedPlayingRef.current) {
      return
    }
    hasEmittedPlayingRef.current = true
    onPlayingChange?.(playing)
  }, [src, playing, onPlayingChange])

  useEffect(() => {
    onPlaybackEndedChange?.(playbackEnded)
  }, [playbackEnded, onPlaybackEndedChange])

  useEffect(() => {
    setPlaying(false)
    setPlaybackEnded(false)
    hasAutoPlayedRef.current = false
    hasEmittedPlayingRef.current = false
  }, [src])

  const video = videoRef.current
  const isCompact = containerWidth > 0 && containerWidth < WIDTH_COMPACT
  const isLarge = containerWidth >= WIDTH_LARGE
  const showAboveBar = isCompact && truncationLevel > 0
  const volumePct = muted ? 0 : volume

  useEffect(() => {
    const handler = () => {
      if (!isNativeFullscreen) setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [isNativeFullscreen])

  // Track container width for dynamic control sizing
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerWidth(e.contentRect.width)
    })
    ro.observe(el)
    setContainerWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  // When compact: detect overflow and set truncation level. Observe the whole player so widening always re-checks.
  // Un-truncate uses inner intrinsic width vs outer slot (scrollWidth on overflow:hidden measure row was stuck === clientWidth).
  const truncationLevelRef = useRef(truncationLevel)
  truncationLevelRef.current = truncationLevel
  const OVERFLOW_HYSTERESIS_PX = 24

  const timeLayoutFloor = Math.floor(currentTime)
  const durationLayoutFloor = Number.isFinite(duration) ? Math.floor(duration) : 0

  useLayoutEffect(() => {
    if (!isCompact) {
      setTruncationLevel(0)
      return
    }
    const container = containerRef.current
    if (!container) return

    const runTruncationCheck = () => {
      const current = truncationLevelRef.current
      if (current > 0) {
        const outer = measureCompactRowOuterRef.current
        const inner = measureRowRef.current
        if (outer && inner) {
          const fits = inner.offsetWidth + OVERFLOW_HYSTERESIS_PX <= outer.clientWidth
          if (fits) {
            setTruncationLevel((prev) => (prev > 0 ? 0 : prev))
          }
        }
      } else {
        const row = belowBarRowRef.current
        if (row && row.scrollWidth > row.clientWidth + 1) {
          setTruncationLevel((prev) => (prev === 0 ? 3 : prev))
        }
      }
    }

    const scheduleTruncationCheck = () => {
      if (truncationRafRef.current) return
      truncationRafRef.current = requestAnimationFrame(() => {
        truncationRafRef.current = 0
        runTruncationCheck()
      })
    }

    scheduleTruncationCheck()
    const ro = new ResizeObserver(scheduleTruncationCheck)
    ro.observe(container)
    return () => {
      ro.disconnect()
      if (truncationRafRef.current) {
        cancelAnimationFrame(truncationRafRef.current)
        truncationRafRef.current = 0
      }
    }
  }, [isCompact, truncationLevel])

  // Re-measure when the time label width can change (without tying to every currentTime rAF tick).
  useLayoutEffect(() => {
    if (!isCompact || truncationLevel <= 0) return
    const outer = measureCompactRowOuterRef.current
    const inner = measureRowRef.current
    if (!outer || !inner) return
    if (inner.offsetWidth + OVERFLOW_HYSTERESIS_PX <= outer.clientWidth) {
      setTruncationLevel((prev) => (prev > 0 ? 0 : prev))
    }
  }, [isCompact, truncationLevel, timeLayoutFloor, durationLayoutFloor, playbackRate])

  // Inline hide between time and speed row; move hide to its own row above when it collides with the time text or the row wraps.
  useLayoutEffect(() => {
    const baseControlsVisible = showControls || (keepControlsWhenPaused && !playing)
    const showHideChromeStrip =
      collapsibleChrome && !playing && !chromeCollapsed && baseControlsVisible
    if (!isCompact || !showAboveBar || !showHideChromeStrip) {
      hideChromePlacementRef.current = false
      hideCollidedAtWidthRef.current = null
      hideEnteredAboveAtRef.current = null
      setHideChromeAboveMeta(false)
      return
    }
    const row = compactMetaRowRef.current
    if (!row) return

    const apply = () => {
      const wasAbove = hideChromePlacementRef.current
      const timeEl = compactMetaTimeRef.current
      const hideBtn = compactMetaHideButtonRef.current

      let next = wasAbove
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const enteredAt = hideEnteredAboveAtRef.current
      const settled =
        enteredAt == null ? false : now - enteredAt >= HIDE_PLACEMENT_SETTLE_MS

      if (wasAbove) {
        const w0 = hideCollidedAtWidthRef.current
        if (settled && w0 != null && containerWidth >= w0 + HIDE_INLINE_WIDTH_EXIT_DELTA_PX) {
          next = false
        }
      } else {
        if (timeEl && hideBtn) {
          const tr = timeEl.getBoundingClientRect()
          const hr = hideBtn.getBoundingClientRect()
          const timeHideCollision = hr.left < tr.right + HIDE_TIME_GAP_COLLISION_ENTER_PX
          if (timeHideCollision) next = true
        }
        const overflowY = row.scrollHeight - row.clientHeight
        if (overflowY > HIDE_CHROME_META_OVERFLOW_ENTER_PX) next = true
      }

      if (!wasAbove && next) {
        hideCollidedAtWidthRef.current = containerWidth
        hideEnteredAboveAtRef.current = now
      }
      if (wasAbove && !next) {
        hideCollidedAtWidthRef.current = null
        hideEnteredAboveAtRef.current = null
      }

      hideChromePlacementRef.current = next
      setHideChromeAboveMeta((prev) => (prev === next ? prev : next))
    }

    const scheduleApply = () => {
      if (hidePlacementRafRef.current) return
      hidePlacementRafRef.current = requestAnimationFrame(() => {
        hidePlacementRafRef.current = 0
        apply()
      })
    }

    scheduleApply()
    const ro = new ResizeObserver(() => {
      scheduleApply()
    })
    ro.observe(row)
    return () => {
      ro.disconnect()
      if (hidePlacementRafRef.current) {
        cancelAnimationFrame(hidePlacementRafRef.current)
        hidePlacementRafRef.current = 0
      }
    }
  }, [
    isCompact,
    showAboveBar,
    collapsibleChrome,
    playing,
    chromeCollapsed,
    showControls,
    keepControlsWhenPaused,
    containerWidth,
    currentTime,
    duration,
  ])

  // Sync state when user exits OS-level fullscreen (e.g. Escape key or window event)
  useEffect(() => {
    if (!isNativeFullscreen) return
    let unlisten: (() => void) | undefined
    getCurrent()
      .listen('tauri://fullscreen', () => {
        const appWindow = getCurrent()
        appWindow
          .isFullscreen()
          .then((full) => {
            if (!full) {
              appWindow.setResizable(true).catch(() => {})
              setIsFullscreen(false)
              setIsNativeFullscreen(false)
              setNativeVideoFullscreen(false)
            }
          })
          .catch(() => {})
      })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [isNativeFullscreen, setNativeVideoFullscreen])

  // Escape key exits fullscreen
  useEffect(() => {
    if (!isNativeFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const appWindow = getCurrent()
        appWindow
          .setFullscreen(false)
          .then(() => appWindow.setResizable(true))
          .then(() => {
            setIsFullscreen(false)
            setIsNativeFullscreen(false)
            setNativeVideoFullscreen(false)
          })
          .catch(() => {
            appWindow.setResizable(true).catch(() => {})
          })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isNativeFullscreen, setNativeVideoFullscreen])

  // When speed menu is open: close on scroll (so chat can scroll) and close on click outside
  useEffect(() => {
    if (!showSpeedMenu) return
    const closeMenu = () => setShowSpeedMenu(false)
    const onWheel = () => { closeMenu() }
    const onMouseDown = (e: MouseEvent) => {
      const el = speedMenuContainerRef.current
      if (el && !el.contains(e.target as Node)) closeMenu()
    }
    document.addEventListener('wheel', onWheel, { passive: true })
    document.addEventListener('mousedown', onMouseDown, true)
    return () => {
      document.removeEventListener('wheel', onWheel)
      document.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [showSpeedMenu])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return

    const onLoadedMetadata = () => {
      setDuration(v.duration)
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        onAspectRatio?.(v.videoWidth, v.videoHeight)
      }
    }
    const onCanPlayThrough = () => {
      if (autoPlay && !hasAutoPlayedRef.current) {
        hasAutoPlayedRef.current = true
        v.play().catch(() => {})
      }
    }
    const onDurationChange = () => setDuration(v.duration)
    const onPlay = () => {
      setPlaying(true)
      setPlaybackEnded(false)
    }
    const onPause = () => {
      setPlaying(false)
      setCurrentTime(v.currentTime)
      setIsBuffering(false)
    }
    const onWaiting = () => setIsBuffering(true)
    const onCanPlay = () => setIsBuffering(false)
    const onPlaying = () => setIsBuffering(false)
    const onSeeked = () => {
      setIsBuffering(false)
      if (!v.ended) setPlaybackEnded(false)
    }
    const onEnded = () => {
      setPlaying(false)
      setPlaybackEnded(true)
      setCurrentTime(v.currentTime)
      setIsBuffering(false)
    }

    v.addEventListener('loadedmetadata', onLoadedMetadata)
    v.addEventListener('durationchange', onDurationChange)
    v.addEventListener('canplaythrough', onCanPlayThrough)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('ended', onEnded)
    v.addEventListener('waiting', onWaiting)
    v.addEventListener('canplay', onCanPlay)
    v.addEventListener('playing', onPlaying)
    v.addEventListener('seeked', onSeeked)

    return () => {
      v.removeEventListener('loadedmetadata', onLoadedMetadata)
      v.removeEventListener('durationchange', onDurationChange)
      v.removeEventListener('canplaythrough', onCanPlayThrough)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('ended', onEnded)
      v.removeEventListener('waiting', onWaiting)
      v.removeEventListener('canplay', onCanPlay)
      v.removeEventListener('playing', onPlaying)
      v.removeEventListener('seeked', onSeeked)
    }
  }, [src, onAspectRatio, autoPlay])

  useEffect(() => {
    setIsBuffering(false)
  }, [src])

  useEffect(() => {
    try {
      localStorage.setItem(VIDEO_VOLUME_STORAGE_KEY, JSON.stringify({ volume, muted }))
    } catch {
      // localStorage may be full or unavailable (e.g. private mode)
    }
  }, [volume, muted])

  // Smooth progress bar: use requestAnimationFrame while playing instead of timeupdate (which fires ~250ms)
  useEffect(() => {
    const v = videoRef.current
    if (!v || !playing) return

    let rafId: number
    const tick = () => {
      setCurrentTime(v.currentTime)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [playing, src])

  useEffect(() => {
    if (!video) return
    video.playbackRate = playbackRate
  }, [video, playbackRate])

  useEffect(() => {
    if (!video) return
    video.volume = muted ? 0 : volume
  }, [video, volume, muted])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onEnter = () => setIsInPictureInPicture(true)
    const onLeave = () => setIsInPictureInPicture(false)
    v.addEventListener('enterpictureinpicture', onEnter)
    v.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      v.removeEventListener('enterpictureinpicture', onEnter)
      v.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [])

  const togglePictureInPicture = async () => {
    const v = videoRef.current
    if (!v) return
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else {
        await v.requestPictureInPicture()
      }
    } catch {
      // PiP not supported or user denied
    }
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (playbackEnded || v.ended) {
      v.currentTime = 0
      setCurrentTime(0)
      setPlaybackEnded(false)
      void v.play()
      return
    }
    if (v.paused) void v.play()
    else v.pause()
  }

  const toggleMute = () => setMuted((m) => !m)

  const handleVolumeChange = (value: number) => {
    setVolume(value)
    if (value > 0) setMuted(false)
  }

  const getVolumeFromClientX = (clientX: number): number => {
    if (!volumeSliderRef.current) return 0
    const rect = volumeSliderRef.current.getBoundingClientRect()
    const x = clientX - rect.left
    return Math.max(0, Math.min(1, x / rect.width))
  }

  const handleVolumeClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const val = getVolumeFromClientX(e.clientX)
    handleVolumeChange(val)
    if (val > 0) setMuted(false)
  }

  const handleVolumeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDraggingVolume(true)
    const val = getVolumeFromClientX(e.clientX)
    handleVolumeChange(val)
    if (val > 0) setMuted(false)
  }

  useEffect(() => {
    if (!isDraggingVolume) return

    const onMove = (e: MouseEvent) => {
      const bar = volumeSliderRef.current
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      const x = e.clientX - rect.left
      const val = Math.max(0, Math.min(1, x / rect.width))
      setVolume(val)
      if (val > 0) setMuted(false)
    }

    const onUp = () => setIsDraggingVolume(false)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDraggingVolume])

  const getProgressFromClientX = (clientX: number): number => {
    if (!progressBarRef.current) return 0
    const rect = progressBarRef.current.getBoundingClientRect()
    const x = clientX - rect.left
    return Math.max(0, Math.min(1, x / rect.width))
  }

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!video || !progressBarRef.current) return
    const pct = getProgressFromClientX(e.clientX)
    const newTime = pct * video.duration
    video.currentTime = newTime
    setCurrentTime(newTime)
  }

  const handleProgressMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!video) return
    e.preventDefault()
    setIsDraggingProgress(true)
    const pct = getProgressFromClientX(e.clientX)
    const newTime = pct * video.duration
    video.currentTime = newTime
    setCurrentTime(newTime)
  }

  useEffect(() => {
    if (!isDraggingProgress) return

    const onMove = (e: MouseEvent) => {
      const bar = progressBarRef.current
      const v = videoRef.current
      if (!bar || !v) return
      const rect = bar.getBoundingClientRect()
      const x = e.clientX - rect.left
      const pct = Math.max(0, Math.min(1, x / rect.width))
      const newTime = pct * v.duration
      v.currentTime = newTime
      setCurrentTime(newTime)
    }

    const onUp = () => setIsDraggingProgress(false)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDraggingProgress])

  const toggleFullscreen = async () => {
    const el = containerRef.current
    if (!el) return
    if (isFullscreen) {
      if (isNativeFullscreen) {
        try {
          const appWindow = getCurrent()
          await appWindow.setFullscreen(false)
          await appWindow.setResizable(true)
          setIsFullscreen(false)
          setIsNativeFullscreen(false)
          setNativeVideoFullscreen(false)
        } catch {
          getCurrent().setResizable(true).catch(() => {})
          setIsFullscreen(false)
          setIsNativeFullscreen(false)
          setNativeVideoFullscreen(false)
        }
      } else {
        await document.exitFullscreen()
        setIsFullscreen(false)
      }
    } else {
      try {
        const appWindow = getCurrent()
        await appWindow.setFullscreen(true)
        await appWindow.setResizable(false)
        setIsFullscreen(true)
        setIsNativeFullscreen(true)
        setNativeVideoFullscreen(true, getScrollTarget)
      } catch {
        await el.requestFullscreen()
      }
    }
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

  const fullscreenOverlay = isFullscreen && isNativeFullscreen

  const baseControlsVisible = showControls || (keepControlsWhenPaused && !playing)
  const showMainChrome = baseControlsVisible && !(collapsibleChrome && chromeCollapsed)
  const showRevealChromeStrip = collapsibleChrome && chromeCollapsed
  const showCollapseChromeControl =
    collapsibleChrome && !playing && !chromeCollapsed && baseControlsVisible

  const renderCollapseHideButton = (buttonRef?: Ref<HTMLButtonElement>) => (
    <button
      ref={buttonRef}
      type="button"
      className={cn(
        'flex items-center justify-center rounded-md bg-[hsl(220_7%_38%_/_0.47)] hover:bg-[hsl(220_7%_44%_/_0.58)] text-white transition-colors shrink-0 border border-white/15 box-border',
        isCompact ? 'h-[1.1rem] w-10 px-0 active:scale-100' : 'h-6 min-w-10 px-4 active:scale-100'
      )}
      onClick={(e) => {
        e.stopPropagation()
        onChromeCollapsedChange?.(true)
      }}
      aria-label="Hide player controls"
    >
      <span className="inline-flex min-w-4 max-w-4 w-4 shrink-0 items-center justify-center">
        <ChevronDown className={cn(isCompact ? 'h-3 w-3' : 'h-4 w-4', 'opacity-95')} strokeWidth={2.25} />
      </span>
    </button>
  )

  const hideChromeRow = (wrapperMbClass: string) => (
    <div className={cn('flex w-full justify-center', wrapperMbClass)}>{renderCollapseHideButton()}</div>
  )

  const inner = (
    <>
      <div className={cn(
        'relative flex-1 min-h-0 flex items-center justify-center',
        isCompact && 'min-h-[60px]',
        fullscreenOverlay && 'w-full h-full'
      )}>
        <video
          ref={videoRef}
          src={src}
          autoPlay={autoPlay}
          playsInline
          onClick={togglePlay}
          onCanPlay={onCanPlay}
          className={cn(
            fullscreenOverlay
              ? 'w-full h-full min-w-0 min-h-0 object-contain'
              : 'max-w-full max-h-full object-cover'
          )}
        />
        {isBuffering && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none" aria-hidden>
            <Loader2 className="h-8 w-8 text-white animate-spin" />
          </div>
        )}
      </div>

      {/* Controls bar - visible on hover, or always when paused if keepControlsWhenPaused. Dynamic sizing: compact (<360px) moves time/speed/PiP above bar; normal; large (>=720px). */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-200 min-w-0',
          isCompact && 'pt-3 pb-1 px-1.5',
          !isCompact && !isLarge && 'pt-8 pb-2 px-3',
          isLarge && 'pt-10 pb-3 px-4',
          showMainChrome ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
      >
        {/* Truncation: compact meta row — time | hide (inline, same row) | speed+PiP. If that row wraps, hide moves to its own row above (measured via compactMetaRowRef). */}
        {showCollapseChromeControl && hideChromeAboveMeta && showAboveBar && hideChromeRow(isCompact ? 'mb-0.5' : 'mb-2')}
        {showAboveBar && (
          <div
            ref={compactMetaRowRef}
            className="grid w-full min-w-0 grid-cols-[1fr_auto_1fr] items-center gap-x-1 mb-0.5 text-white text-[10px]"
          >
            <span
              ref={compactMetaTimeRef}
              className="min-w-0 justify-self-start truncate tabular-nums"
            >
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            <div className="flex justify-center justify-self-center px-0.5">
              {showCollapseChromeControl && !hideChromeAboveMeta
                ? renderCollapseHideButton(compactMetaHideButtonRef)
                : null}
            </div>
            <div
              ref={compactMetaRightClusterRef}
              className="flex items-center justify-end justify-self-end gap-0.5 shrink-0"
            >
              <div ref={speedMenuContainerRef} className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 min-w-0 text-white hover:bg-white/20 shrink-0"
                  onClick={() => setShowSpeedMenu((s) => !s)}
                >
                  <span className="tabular-nums">{playbackRate % 1 === 0 ? `${playbackRate}x` : playbackRate.toFixed(2) + 'x'}</span>
                </Button>
                {showSpeedMenu && (
                  <>
                    <div className="fixed inset-0 z-10 pointer-events-none" aria-hidden />
                    <div className="absolute bottom-full right-0 mb-1 py-1.5 px-2 bg-black/90 border border-white/20 rounded z-20 flex flex-col items-center gap-0">
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-white hover:bg-white/20 shrink-0 rounded" onClick={() => setPlaybackRate((r) => Math.min(PLAYBACK_SPEED_MAX, Math.round(r / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP + PLAYBACK_SPEED_STEP))} aria-label="Increase speed">
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <span className="text-[10px] text-white tabular-nums py-0.5">{playbackRate % 1 === 0 ? `${playbackRate}x` : playbackRate.toFixed(2) + 'x'}</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-white hover:bg-white/20 shrink-0 rounded" onClick={() => setPlaybackRate((r) => Math.max(PLAYBACK_SPEED_MIN, Math.round(r / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP - PLAYBACK_SPEED_STEP))} aria-label="Decrease speed">
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
              {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
                <Button variant="ghost" size="icon" className="h-6 w-6 text-white hover:bg-white/20 shrink-0" onClick={togglePictureInPicture} aria-label={isInPictureInPicture ? 'Exit picture-in-picture' : 'Picture-in-picture'} title={isInPictureInPicture ? 'Exit picture-in-picture' : 'Pop out (picture-in-picture)'}>
                  <PictureInPicture className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Hide chrome above scrubber when meta row is on the bottom (non-compact-truncated layout) */}
        {showCollapseChromeControl && !showAboveBar && hideChromeRow(isCompact ? 'mb-1' : 'mb-2')}

        {/* Progress bar - hard corners, thumb visible whenever controls are shown. py-px expands hit area 1px above/below without changing bar height. */}
        <div
          ref={progressBarRef}
          className={cn(
            'relative py-px -my-px cursor-pointer',
            isCompact ? 'mb-1' : 'mb-2'
          )}
          onClick={handleProgressClick}
          onMouseDown={handleProgressMouseDown}
        >
          <div className={cn(
            'bg-white/30 rounded-none',
            isCompact ? 'h-1' : isLarge ? 'h-2' : 'h-1.5'
          )}>
            <div
              className="h-full bg-white rounded-none"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div
            className={cn(
              'absolute top-1/2 bg-white rounded-none -translate-y-1/2 pointer-events-none',
              isCompact ? 'w-2 h-2' : isLarge ? 'w-3 h-3' : 'w-2.5 h-2.5'
            )}
            style={{ left: `${progressPct}%`, transform: 'translate(-50%, -50%)' }}
          />
        </div>

        {/* Hidden probe: outer = available width; inner = intrinsic full compact bar (no overflow:hidden — fixes stuck scrollWidth). */}
        {showAboveBar && (
          <div
            ref={measureCompactRowOuterRef}
            className="absolute left-1.5 top-3 right-1.5 min-w-0 opacity-0 pointer-events-none"
            style={{ visibility: 'hidden' }}
            aria-hidden
          >
            <div
              ref={measureRowRef}
              className="inline-flex w-max items-center gap-x-1 whitespace-nowrap text-[10px] text-white"
            >
              <div className="h-6 w-6 shrink-0" />
              <span className="shrink-0 tabular-nums">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                <div className="h-6 w-6 shrink-0" />
                <div className="h-0.5 w-8 shrink-0" />
              </div>
              <div className="h-6 px-1.5 shrink-0 min-w-0">
                <span className="tabular-nums">
                  {playbackRate % 1 === 0 ? `${playbackRate}x` : `${playbackRate.toFixed(2)}x`}
                </span>
              </div>
              {typeof document !== 'undefined' && document.pictureInPictureEnabled && <div className="h-6 w-6 shrink-0" />}
              <div className="h-6 w-6 shrink-0" />
            </div>
          </div>
        )}

        {/* Row below progress bar: play + volume + fullscreen (truncated) or play + time + volume + speed + PiP + fullscreen (normal) */}
        <div
          ref={belowBarRowRef}
          className={cn(
          'flex items-center text-white min-w-0',
          isCompact ? 'gap-x-1' : isLarge ? 'gap-3' : 'gap-2',
          isCompact ? 'text-[10px]' : isLarge ? 'text-sm' : 'text-xs'
        )}>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'text-white hover:bg-white/20 shrink-0',
              isCompact && 'h-6 w-6',
              !isCompact && !isLarge && 'h-8 w-8',
              isLarge && 'h-10 w-10'
            )}
            onClick={togglePlay}
            aria-label={playbackEnded ? 'Replay' : playing ? 'Pause' : 'Play'}
          >
            {playing ? (
              <Pause className={cn(isCompact ? 'h-3 w-3' : isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
            ) : playbackEnded ? (
              <RotateCcw className={cn(isCompact ? 'h-3 w-3' : isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
            ) : (
              <Play className={cn(isCompact ? 'h-3 w-3' : isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
            )}
          </Button>

          {!showAboveBar && (
            <span className="shrink-0 tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          )}

          {/* Volume: icon toggles mute, slider adjusts volume */}
          <div className={cn('flex items-center shrink-0', isCompact ? 'gap-0.5' : isLarge ? 'gap-2' : 'gap-1.5')}>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'text-white hover:bg-white/20 shrink-0',
                isCompact && 'h-6 w-6',
                !isCompact && !isLarge && 'h-8 w-8',
                isLarge && 'h-10 w-10'
              )}
              onClick={toggleMute}
            >
              {muted ? (
                <VolumeX className={cn(isCompact ? 'h-3 w-3' : isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
              ) : (
                <Volume2 className={cn(isCompact ? 'h-3 w-3' : isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
              )}
            </Button>
            <div
              ref={volumeSliderRef}
              className="relative py-px -my-px cursor-pointer"
              onClick={handleVolumeClick}
              onMouseDown={handleVolumeMouseDown}
            >
              <div className={cn(
                'relative bg-white/30 rounded-none',
                isCompact ? 'h-0.5 w-8' : isLarge ? 'h-1.5 w-24' : 'h-1 w-16'
              )}>
                <div
                  className="absolute inset-y-0 left-0 bg-white rounded-none"
                  style={{ width: `${volumePct * 100}%` }}
                />
              </div>
              <div
                className={cn(
                  'absolute top-1/2 bg-white rounded-none -translate-y-1/2 pointer-events-none',
                  isCompact ? 'w-1.5 h-1.5' : isLarge ? 'w-3 h-3' : 'w-2.5 h-2.5'
                )}
                style={{ left: `${volumePct * 100}%`, transform: 'translate(-50%, -50%)' }}
              />
            </div>
          </div>

          {!showAboveBar && (
            <>
              {/* Playback speed - only below bar when not truncated */}
              <div ref={speedMenuContainerRef} className="relative ml-auto shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'text-white hover:bg-white/20 shrink-0 gap-1',
                    !isLarge && 'h-8 px-2',
                    isLarge && 'h-10 px-3'
                  )}
                  onClick={() => setShowSpeedMenu((s) => !s)}
                >
                  <span className="tabular-nums">{playbackRate % 1 === 0 ? `${playbackRate}x` : playbackRate.toFixed(2) + 'x'}</span>
                </Button>
                {showSpeedMenu && (
                  <>
                    <div className="fixed inset-0 z-10 pointer-events-none" aria-hidden />
                    <div className={cn(
                      'absolute bottom-full right-0 mb-1 py-1.5 px-2 bg-black/90 border border-white/20 rounded z-20 flex flex-col items-center gap-0',
                      isLarge && 'py-2 px-3'
                    )}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'text-white hover:bg-white/20 shrink-0 rounded',
                          isLarge ? 'h-8 w-8' : 'h-7 w-7'
                        )}
                        onClick={() => setPlaybackRate((r) => Math.min(PLAYBACK_SPEED_MAX, Math.round(r / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP + PLAYBACK_SPEED_STEP))}
                        aria-label="Increase speed"
                      >
                        <ChevronUp className={cn(isLarge ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
                      </Button>
                      <span className={cn(
                        'text-white tabular-nums py-0.5',
                        isLarge ? 'text-sm' : 'text-xs'
                      )}>
                        {playbackRate % 1 === 0 ? `${playbackRate}x` : playbackRate.toFixed(2) + 'x'}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'text-white hover:bg-white/20 shrink-0 rounded',
                          isLarge ? 'h-8 w-8' : 'h-7 w-7'
                        )}
                        onClick={() => setPlaybackRate((r) => Math.max(PLAYBACK_SPEED_MIN, Math.round(r / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP - PLAYBACK_SPEED_STEP))}
                        aria-label="Decrease speed"
                      >
                        <ChevronDown className={cn(isLarge ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
                      </Button>
                    </div>
                  </>
                )}
              </div>

              {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'text-white hover:bg-white/20 shrink-0',
                    !isLarge && 'h-8 w-8',
                    isLarge && 'h-10 w-10'
                  )}
                  onClick={togglePictureInPicture}
                  aria-label={isInPictureInPicture ? 'Exit picture-in-picture' : 'Picture-in-picture'}
                  title={isInPictureInPicture ? 'Exit picture-in-picture' : 'Pop out (picture-in-picture)'}
                >
                  <PictureInPicture className={cn(isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
                </Button>
              )}
            </>
          )}

          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'text-white hover:bg-white/20 shrink-0',
              showAboveBar && 'ml-auto',
              isCompact && 'h-6 w-6',
              !isCompact && !isLarge && 'h-8 w-8',
              isLarge && 'h-10 w-10'
            )}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? (
              <Minimize2 className={cn(isCompact ? 'h-3 w-3' : isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
            ) : (
              <Maximize className={cn(isCompact ? 'h-3 w-3' : isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
            )}
          </Button>
        </div>
      </div>
    </>
  )

  const wrapper = (
    <div
      ref={containerRef}
      className={cn(
        'relative flex flex-col bg-black overflow-hidden',
        fullscreenOverlay && 'fixed inset-0 z-[9999] w-screen h-screen',
        className
      )}
    >
      {inner}
      {showRevealChromeStrip && (
        <div className="absolute bottom-0 left-0 right-0 z-30 pointer-events-none flex justify-center pb-2">
          <button
            type="button"
            className={cn(
              'pointer-events-auto flex items-center justify-center rounded-md bg-[hsl(220_7%_38%_/_0.47)] hover:bg-[hsl(220_7%_44%_/_0.58)] text-white transition-colors shrink-0 border border-white/15 box-border',
              isCompact ? 'h-[1.1rem] w-10 px-0 active:scale-100' : 'h-6 min-w-10 px-4 active:scale-100'
            )}
            onClick={(e) => {
              e.stopPropagation()
              onChromeCollapsedChange?.(false)
            }}
            aria-label="Show player controls"
          >
            <span className="inline-flex min-w-4 max-w-4 w-4 shrink-0 items-center justify-center">
              <ChevronUp className={cn(isCompact ? 'h-3 w-3' : 'h-4 w-4', 'opacity-95')} strokeWidth={2.25} />
            </span>
          </button>
        </div>
      )}
    </div>
  )

  return wrapper
}
