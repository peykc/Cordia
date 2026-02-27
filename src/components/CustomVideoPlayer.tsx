import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize2, ChevronUp, ChevronDown, PictureInPicture } from 'lucide-react'
import { getCurrent } from '@tauri-apps/api/window'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { useVideoFullscreen } from '../contexts/VideoFullscreenContext'

const PLAYBACK_SPEED_MIN = 0.25
const PLAYBACK_SPEED_MAX = 2
const PLAYBACK_SPEED_STEP = 0.25

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
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
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

  const video = videoRef.current
  const volumePct = muted ? 0 : volume

  useEffect(() => {
    const handler = () => {
      if (!isNativeFullscreen) setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [isNativeFullscreen])

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
    }
    const onEnded = () => {
      setPlaying(false)
      setCurrentTime(v.currentTime)
    }

    v.addEventListener('loadedmetadata', onLoadedMetadata)
    v.addEventListener('durationchange', onDurationChange)
    v.addEventListener('canplaythrough', onCanPlayThrough)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('ended', onEnded)

    return () => {
      v.removeEventListener('loadedmetadata', onLoadedMetadata)
      v.removeEventListener('durationchange', onDurationChange)
      v.removeEventListener('canplaythrough', onCanPlayThrough)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('ended', onEnded)
    }
  }, [src, onAspectRatio, autoPlay])

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
      <div className={cn('flex-1 min-h-0 flex items-center justify-center', fullscreenOverlay && 'w-full h-full')}>
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
      </div>

      {/* Controls bar - visible on hover, or always when paused if keepControlsWhenPaused */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent pt-8 pb-2 px-3 transition-opacity duration-200',
          (showControls || (keepControlsWhenPaused && !playing)) ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
      >
        {/* Progress bar - hard corners, thumb visible whenever controls are shown. py-px expands hit area 1px above/below without changing bar height. */}
        <div
          ref={progressBarRef}
          className="relative py-px -my-px cursor-pointer mb-2"
          onClick={handleProgressClick}
          onMouseDown={handleProgressMouseDown}
        >
          <div className="h-1.5 bg-white/30 rounded-none">
            <div
              className="h-full bg-white rounded-none"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div
            className="absolute top-1/2 w-2.5 h-2.5 bg-white rounded-none -translate-y-1/2 pointer-events-none"
            style={{ left: `${progressPct}%`, transform: 'translate(-50%, -50%)' }}
          />
        </div>

        <div className="flex items-center gap-2 text-white text-xs">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-white hover:bg-white/20 shrink-0"
            onClick={togglePlay}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>

          <span className="shrink-0 tabular-nums">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          {/* Volume: icon toggles mute, slider adjusts volume */}
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/20 shrink-0"
              onClick={toggleMute}
            >
              {muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
            <div
              ref={volumeSliderRef}
              className="relative py-px -my-px cursor-pointer"
              onClick={handleVolumeClick}
              onMouseDown={handleVolumeMouseDown}
            >
              <div className="relative h-1 w-16 bg-white/30 rounded-none">
                <div
                  className="absolute inset-y-0 left-0 bg-white rounded-none"
                  style={{ width: `${volumePct * 100}%` }}
                />
              </div>
              <div
                className="absolute top-1/2 w-2.5 h-2.5 bg-white rounded-none -translate-y-1/2 pointer-events-none"
                style={{ left: `${volumePct * 100}%`, transform: 'translate(-50%, -50%)' }}
              />
            </div>
          </div>

          {/* Playback speed: button opens popup with +/- 0.25x controls */}
          <div ref={speedMenuContainerRef} className="relative ml-auto shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-white hover:bg-white/20 shrink-0 gap-1"
              onClick={() => setShowSpeedMenu((s) => !s)}
            >
              <span className="tabular-nums">{playbackRate % 1 === 0 ? `${playbackRate}x` : playbackRate.toFixed(2) + 'x'}</span>
            </Button>
            {showSpeedMenu && (
              <>
                <div className="fixed inset-0 z-10 pointer-events-none" aria-hidden />
                <div className="absolute bottom-full right-0 mb-1 py-1.5 px-2 bg-black/90 border border-white/20 rounded z-20 flex flex-col items-center gap-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-white hover:bg-white/20 shrink-0 rounded"
                    onClick={() => setPlaybackRate((r) => Math.min(PLAYBACK_SPEED_MAX, Math.round(r / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP + PLAYBACK_SPEED_STEP))}
                    aria-label="Increase speed"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs text-white tabular-nums py-0.5">
                    {playbackRate % 1 === 0 ? `${playbackRate}x` : playbackRate.toFixed(2) + 'x'}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-white hover:bg-white/20 shrink-0 rounded"
                    onClick={() => setPlaybackRate((r) => Math.max(PLAYBACK_SPEED_MIN, Math.round(r / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP - PLAYBACK_SPEED_STEP))}
                    aria-label="Decrease speed"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </>
            )}
          </div>

          {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/20 shrink-0"
              onClick={togglePictureInPicture}
              aria-label={isInPictureInPicture ? 'Exit picture-in-picture' : 'Picture-in-picture'}
              title={isInPictureInPicture ? 'Exit picture-in-picture' : 'Pop out (picture-in-picture)'}
            >
              <PictureInPicture className="h-4 w-4" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-white hover:bg-white/20 shrink-0"
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
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
