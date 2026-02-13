import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize2, Gauge } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

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
}

export function CustomVideoPlayer({ src, className, onCanPlay, onAspectRatio, showControls = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isDraggingProgress, setIsDraggingProgress] = useState(false)
  const [isHoveringProgress, setIsHoveringProgress] = useState(false)
  const volumeSliderRef = useRef<HTMLDivElement>(null)
  const [isDraggingVolume, setIsDraggingVolume] = useState(false)
  const [isHoveringVolume, setIsHoveringVolume] = useState(false)

  const video = videoRef.current
  const volumePct = muted ? 0 : volume

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return

    const onLoadedMetadata = () => {
      setDuration(v.duration)
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        onAspectRatio?.(v.videoWidth, v.videoHeight)
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
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('ended', onEnded)

    return () => {
      v.removeEventListener('loadedmetadata', onLoadedMetadata)
      v.removeEventListener('durationchange', onDurationChange)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('ended', onEnded)
    }
  }, [src, onAspectRatio])

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
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await el.requestFullscreen()
    }
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div
      ref={containerRef}
      className={cn('relative flex flex-col bg-black overflow-hidden', className)}
    >
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <video
          ref={videoRef}
          src={src}
          autoPlay
          playsInline
          onClick={togglePlay}
          onCanPlay={onCanPlay}
          className="max-w-full max-h-full object-cover"
        />
      </div>

      {/* Controls bar - visible on hover, hide when idle or unhover */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent pt-8 pb-2 px-3 transition-opacity duration-200',
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
      >
        {/* Progress bar - hard corners, thumb on hover/drag. py-px expands hit area 1px above/below without changing bar height. */}
        <div
          ref={progressBarRef}
          className="relative py-px -my-px cursor-pointer mb-2"
          onClick={handleProgressClick}
          onMouseDown={handleProgressMouseDown}
          onMouseEnter={() => setIsHoveringProgress(true)}
          onMouseLeave={() => setIsHoveringProgress(false)}
        >
          <div className="h-1.5 bg-white/30 rounded-none">
            <div
              className="h-full bg-white rounded-none"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {(isHoveringProgress || isDraggingProgress) && (
            <div
              className="absolute top-1/2 w-2.5 h-2.5 bg-white rounded-none -translate-y-1/2 pointer-events-none"
              style={{ left: `${progressPct}%`, transform: 'translate(-50%, -50%)' }}
            />
          )}
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
              title={muted ? 'Unmute' : 'Mute'}
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
              onMouseEnter={() => setIsHoveringVolume(true)}
              onMouseLeave={() => setIsHoveringVolume(false)}
            >
              <div className="relative h-1 w-16 bg-white/30 rounded-none">
                <div
                  className="absolute inset-y-0 left-0 bg-white rounded-none"
                  style={{ width: `${volumePct * 100}%` }}
                />
              </div>
              {(isHoveringVolume || isDraggingVolume) && (
                <div
                  className="absolute top-1/2 w-2.5 h-2.5 bg-white rounded-none -translate-y-1/2 pointer-events-none"
                  style={{ left: `${volumePct * 100}%`, transform: 'translate(-50%, -50%)' }}
                />
              )}
            </div>
          </div>

          {/* Playback speed */}
          <div className="relative ml-auto">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-white hover:bg-white/20 shrink-0 gap-1"
              onClick={() => setShowSpeedMenu((s) => !s)}
              title="Playback speed"
            >
              <Gauge className="h-4 w-4" />
              <span>{playbackRate}x</span>
            </Button>
            {showSpeedMenu && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowSpeedMenu(false)}
                />
                <div className="absolute bottom-full right-0 mb-1 py-1 bg-black/90 border border-white/20 rounded z-20 min-w-[5rem]">
                  {SPEED_OPTIONS.map((s) => (
                    <button
                      key={s}
                      className={cn(
                        'w-full px-3 py-1.5 text-left text-xs hover:bg-white/20',
                        playbackRate === s && 'bg-white/20'
                      )}
                      onClick={() => {
                        setPlaybackRate(s)
                        setShowSpeedMenu(false)
                      }}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-white hover:bg-white/20 shrink-0"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
