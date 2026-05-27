import { useEffect, useMemo, useState, memo } from 'react'
import { cn } from '../../lib/utils'
import type { SplitPeaks } from './musicWaveformShared'
import {
  LOADING_WAVEFORM_MAX_FPS,
  SKELETON_ACTIVE_BOTTOM_N,
  SKELETON_ACTIVE_TOP_N,
  SKELETON_BASE_FILL,
  SKELETON_GHOST_ALPHA,
  SKELETON_GHOST_BOTTOM_N,
  SKELETON_GHOST_TOP_N,
  SKELETON_HIGHLIGHT_SHARPNESS,
  SKELETON_HIGHLIGHT_SIGMA,
  SKELETON_INVERSE_SWEEP,
  SKELETON_SWEEP_PERIOD_SEC,
  skeletonHighlightCenter,
  skeletonHighlightFalloff,
} from './musicWaveformShared'

export interface SimplifiedMusicWaveformProps {
  peaks: SplitPeaks
  progress: number
  waveHeight?: number
  barGap?: number
  className?: string
}

const TARGET_BAR_COUNT = 40

export interface ChatBarWaveformSkeletonProps {
  waveHeight?: number
  compact?: boolean
  className?: string
  /** When true, same slow sweep as canvas loading skeleton (capped FPS). */
  animated?: boolean
}

/**
 * DOM version of the canvas seed/loading skeleton: ghost band + Gaussian-highlighted active bars.
 */
export const ChatBarWaveformSkeleton = memo(function ChatBarWaveformSkeleton({
  waveHeight = 32,
  compact = false,
  className,
  animated = false,
}: ChatBarWaveformSkeletonProps) {
  const [phaseMs, setPhaseMs] = useState(0)

  useEffect(() => {
    if (!animated) return
    let cancelled = false
    let raf = 0
    const start = performance.now()
    const minStep = 1000 / LOADING_WAVEFORM_MAX_FPS
    let last = 0
    const loop = (now: number) => {
      if (cancelled) return
      if (now - last >= minStep) {
        last = now
        setPhaseMs(now - start)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [animated])

  const tSec = animated ? phaseMs * 0.001 : SKELETON_SWEEP_PERIOD_SEC * 0.22
  const hiCenter = skeletonHighlightCenter(TARGET_BAR_COUNT, tSec)
  const half = Math.max(2, Math.floor(waveHeight / 2) - 1)
  const ghostTopPx = SKELETON_GHOST_TOP_N * half
  const ghostBotPx = SKELETON_GHOST_BOTTOM_N * half
  const activeTopPx = SKELETON_ACTIVE_TOP_N * half
  const activeBotPx = SKELETON_ACTIVE_BOTTOM_N * half

  const ghostTopColor = `hsl(var(--foreground) / ${0.26 * SKELETON_GHOST_ALPHA})`
  const ghostBotColor = `hsl(var(--foreground) / ${0.14 * SKELETON_GHOST_ALPHA})`

  const barGap = compact ? 1.5 : 2
  const midPx = Math.floor(waveHeight / 2)
  const botRegionPx = waveHeight - midPx

  return (
    <div
      className={cn('grid w-full', className)}
      style={{
        height: `${waveHeight}px`,
        gridTemplateColumns: `repeat(${TARGET_BAR_COUNT}, minmax(0, 1fr))`,
        columnGap: `${barGap}px`,
      }}
      aria-hidden
    >
      {Array.from({ length: TARGET_BAR_COUNT }, (_, i) => {
        const gRaw = skeletonHighlightFalloff(i, hiCenter, SKELETON_HIGHLIGHT_SIGMA)
        const g = Math.pow(gRaw, SKELETON_HIGHLIGHT_SHARPNESS)
        const sweep = SKELETON_INVERSE_SWEEP ? 1 - g : g
        const m = SKELETON_BASE_FILL + (1 - SKELETON_BASE_FILL) * sweep
        const topActH = activeTopPx * m
        const botActH = activeBotPx * m
        return (
          <div key={i} className="relative h-full min-w-0">
            <div
              className="absolute inset-x-0 top-0 flex flex-col justify-end overflow-hidden"
              style={{ height: midPx }}
            >
              <div style={{ height: ghostTopPx, backgroundColor: ghostTopColor }} />
            </div>
            <div
              className="absolute inset-x-0 flex flex-col justify-start overflow-hidden"
              style={{ top: midPx, height: botRegionPx }}
            >
              <div style={{ height: ghostBotPx, backgroundColor: ghostBotColor }} />
            </div>
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-[1] box-border flex flex-col justify-end overflow-hidden border-b border-foreground/[0.14]"
              style={{ height: midPx }}
            >
              <div className="w-full bg-foreground/[0.26] rounded-t-sm" style={{ height: topActH }} />
            </div>
            <div
              className="pointer-events-none absolute inset-x-0 z-[1] flex flex-col justify-start overflow-hidden"
              style={{ top: midPx, height: botRegionPx }}
            >
              <div className="w-full bg-foreground/[0.14] rounded-b-sm" style={{ height: botActH }} />
            </div>
          </div>
        )
      })}
    </div>
  )
})

/**
 * Messaging-style waveform: ~40 uniform columns, DOM only (no per-frame canvas).
 * Intended for chat lists with many audio rows; modal keeps the detailed canvas renderer.
 */
export const SimplifiedMusicWaveform = memo(function SimplifiedMusicWaveform({
  peaks,
  progress,
  waveHeight = 32,
  barGap = 2,
  className,
}: SimplifiedMusicWaveformProps) {
  const displayBars = useMemo(() => {
    const rawLen = peaks.top.length
    if (rawLen === 0) return []
    const sampled: { top: number; bottom: number }[] = []
    const step = rawLen / TARGET_BAR_COUNT
    for (let i = 0; i < TARGET_BAR_COUNT; i++) {
      const index = Math.min(rawLen - 1, Math.floor(i * step))
      sampled.push({
        top: peaks.top[index] ?? 0.12,
        bottom: peaks.bottom[index] ?? 0.08,
      })
    }
    return sampled
  }, [peaks])

  /** One shared horizontal seam in px so every column’s top/bottom meet on the same line (no per-flex rounding). */
  const midPx = Math.floor(waveHeight / 2)
  const botRegionPx = waveHeight - midPx
  const halfAmp = Math.max(2, midPx - 2)

  return (
    <div
      className={cn('grid w-full', className)}
      style={{
        height: `${waveHeight}px`,
        gridTemplateColumns: `repeat(${TARGET_BAR_COUNT}, minmax(0, 1fr))`,
        columnGap: `${barGap}px`,
      }}
      aria-hidden
    >
      {displayBars.map((bar, i) => {
        const t = (i + 0.5) / TARGET_BAR_COUNT
        const isActive = t <= progress
        const topH = Math.min(midPx - 1, Math.max(2, bar.top * halfAmp))
        const bottomH = Math.min(botRegionPx - 1, Math.max(2, bar.bottom * halfAmp))
        return (
          <div key={i} className="relative h-full min-w-0">
            <div
              className="absolute inset-x-0 top-0 box-border flex flex-col justify-end overflow-hidden border-b border-foreground/[0.14]"
              style={{ height: midPx }}
            >
              <div
                className={cn(
                  'w-full min-w-0 transition-colors duration-75 rounded-none',
                  isActive ? 'bg-primary' : 'bg-foreground/[0.26]'
                )}
                style={{ height: `${topH}px` }}
              />
            </div>
            <div
              className="absolute inset-x-0 flex flex-col justify-start overflow-hidden"
              style={{ top: midPx, height: botRegionPx }}
            >
              <div
                className={cn(
                  'w-full min-w-0 transition-colors duration-75 rounded-none',
                  isActive ? 'bg-primary/50' : 'bg-foreground/[0.14]'
                )}
                style={{ height: `${bottomH}px` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
})
