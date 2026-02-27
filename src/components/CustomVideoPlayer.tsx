import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize2, ChevronUp, ChevronDown, PictureInPicture, Loader2 } from 'lucide-react'
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
}

export function CustomVideoPlayer({ src, className, onCanPlay, onAspectRatio, showControls = false, keepControlsWhenPaused = false, autoPlay = false, getScrollTarget }: Props) {
  const { setNativeVideoFullscreen } = useVideoFullscreen()
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasAutoPlayedRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
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
  const measureRowRef = useRef<HTMLDivElement>(null)
  const [truncationLevel, setTruncationLevel] = useState<TruncationLevel>(0)
  const [isBuffering, setIsBuffering] = useState(false)

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

  // When compact: detect overflow and set truncation level. Truncation only when compact layout would collide.
  // Hysteresis prevents flip-flop at boundary sizes (un-truncate only when we have buffer).
  const truncationLevelRef = useRef(truncationLevel)
  truncationLevelRef.current = truncationLevel
  const OVERFLOW_HYSTERESIS_PX = 24

  useLayoutEffect(() => {
    if (!isCompact) {
      setTruncationLevel(0)
      return
    }
    const rowToMeasure = truncationLevelRef.current > 0 ? measureRowRef.current : belowBarRowRef.current
    if (!rowToMeasure) return

    const checkOverflow = () => {
      const scrollW = rowToMeasure.scrollWidth
      const clientW = rowToMeasure.clientWidth
      const current = truncationLevelRef.current
      let next: TruncationLevel | null = null
      if (current > 0) {
        if (scrollW + OVERFLOW_HYSTERESIS_PX <= clientW) next = 0
      } else {
        if (scrollW > clientW) next = 3
      }
      if (next !== null) {
        requestAnimationFrame(() => {
          setTruncationLevel((prev) => (next === 0 && prev > 0 ? 0 : next === 3 && prev < 3 ? 3 : prev))
        })
      }
    }

    checkOverflow()
    const ro = new ResizeObserver(checkOverflow)
    ro.observe(rowToMeasure)
    return () => ro.disconnect()
  }, [isCompact, truncationLevel])

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
    const onPlay = () => setPlaying(true)
    const onPause = () => {
      setPlaying(false)
      setCurrentTime(v.currentTime)
      setIsBuffering(false)
    }
    const onWaiting = () => setIsBuffering(true)
    const onCanPlay = () => setIsBuffering(false)
    const onPlaying = () => setIsBuffering(false)
    const onSeeked = () => setIsBuffering(false)
    const onEnded = () => {
      setPlaying(false)
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
    if (!video) return
    if (video.paused) video.play()
    else video.pause()
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
          (showControls || (keepControlsWhenPaused && !playing)) ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
      >
        {/* Truncation: row above progress bar - timestamp (left), speed + PiP (right). Only when compact layout overflows. */}
        {showAboveBar && (
          <div className="flex items-center justify-between gap-2 mb-0.5 text-white text-[10px] min-w-0">
            <span className="shrink-0 tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            <div className="flex items-center gap-0.5 shrink-0">
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

        {/* Hidden row for overflow measurement when truncated - mirrors full compact row to detect when we can un-truncate */}
        {showAboveBar && (
          <div
            ref={measureRowRef}
            className="absolute left-1.5 top-3 right-1.5 flex items-center gap-x-1 text-[10px] opacity-0 pointer-events-none overflow-hidden"
            style={{ visibility: 'hidden' }}
            aria-hidden
          >
            <div className="h-6 w-6 shrink-0" />
            <span className="shrink-0 tabular-nums">0:00 / 34:52</span>
            <div className="flex items-center gap-0.5 shrink-0">
              <div className="h-6 w-6 shrink-0" />
              <div className="h-0.5 w-8 shrink-0" />
            </div>
            <div className="h-6 px-1.5 shrink-0 min-w-0">
              <span>1x</span>
            </div>
            {typeof document !== 'undefined' && document.pictureInPictureEnabled && <div className="h-6 w-6 shrink-0" />}
            <div className="h-6 w-6 shrink-0" />
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
          >
            {playing ? (
              <Pause className={cn(isCompact ? 'h-3 w-3' : isLarge ? 'h-5 w-5' : 'h-4 w-4')} />
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
    </div>
  )

  return wrapper
}
