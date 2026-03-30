import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from 'react'
import {
  AudioLines,
  X,
  Loader2,
  Upload,
  FolderOpen,
  Info,
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Tooltip } from './Tooltip'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { ensureMusicCoverPreviewFull, getAudioStreamInfo, openPathInFileExplorer } from '../lib/tauri'
import { formatBytes } from '../lib/bytes'
import type { MediaPreviewState } from '../contexts/MediaPreviewContext'
import { avatarStyleForUserId } from '../lib/userAvatarStyle'
import { cn } from '../lib/utils'
import { IconForCategory } from './FileIcon'
import { useMusicWaveform } from './music/useMusicWaveform'

type AudioPreviewProps = Extract<Exclude<MediaPreviewState, null>, { type: 'audio' }> & { onClose: () => void }

function directoryForPath(path: string): string {
  const normalized = path.replace(/\//g, '\\')
  const idx = normalized.lastIndexOf('\\')
  return idx > 0 ? normalized.slice(0, idx) : normalized
}

function initialsFromDisplayName(name: string): string {
  const t = name.trim()
  if (!t) return '?'
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0]![0] + parts[1]![0]).toUpperCase()
  }
  return t.slice(0, 2).toUpperCase()
}

function truncateSha256(hex: string): string {
  const s = hex.trim()
  if (s.length <= 20) return s
  return `${s.slice(0, 10)}…${s.slice(-8)}`
}

/** Horizontally center `thumb` inside strip scrollport (clamped). */
function scrollAudioGalleryStripToCenterThumb(
  strip: HTMLElement,
  thumb: HTMLElement,
  behavior: ScrollBehavior = 'auto'
) {
  const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth)
  if (maxScroll <= 0) return
  const centerX = thumb.offsetLeft + thumb.offsetWidth / 2
  const left = Math.max(0, Math.min(centerX - strip.clientWidth / 2, maxScroll))
  strip.scrollTo({ left, behavior })
}

/** Title line: basename only; extension is on the meta row below. */
function stripFileExtension(name: string): string {
  const t = name.trim()
  if (!t) return ''
  const idx = t.lastIndexOf('.')
  if (idx <= 0) return t
  const base = t.slice(0, idx)
  return base.length > 0 ? base : t
}

/** Sample rate in kHz for display (44100 → 44.1, 48000 → 48). */
function formatKhzFromHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return ''
  const k = hz / 1000
  const rounded = Math.round(k * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, '')
}

/** Darker than title-bar chrome */
const toolbarIconBtnClass =
  'h-8 w-8 border-border bg-[hsl(220_7%_10%)] text-foreground hover:bg-muted/60'

/**
 * Tier 0 = show everything. Higher = hide more (lowest UI priority first).
 * Hide order: kbps/kHz (tier ≥ 2) → file type/size (tier ≥ 3) → volume → play → waveform → title → (cover shrinks only).
 * Play stays visible one tier longer than before so a tier-4 cover shrink can free space before the button hides.
 */
function rawTierFromDim(s: number): number {
  if (s <= 0) return 0
  if (s >= 440) return 0
  if (s >= 380) return 1
  if (s >= 320) return 2
  if (s >= 270) return 3
  if (s >= 220) return 4
  if (s >= 170) return 5
  return 6
}

/**
 * Extra “virtual” height for landscape tiering only: art + controls sit in a row, so the same
 * measured content height leaves more room for the control stack than a single portrait column.
 * Without this, vertical shrink in landscape hid rows while they still fit.
 */
const LANDSCAPE_TIER_HEIGHT_PAD_PX = 88

/**
 * Portrait: the stacked column (cover + two meta lines + controls) can overflow before tier
 * catches up to the raw measured height — subtract so meta rows hide earlier and avoid clipping.
 */
const PORTRAIT_TIER_HEIGHT_ADJUST_PX = 112

/** Tier from content area height. Width is ignored; landscape pads, portrait tightens. */
function tierFromContentHeight(h: number, landscape: boolean): number {
  if (h <= 0) return 0
  if (landscape) {
    return rawTierFromDim(h + LANDSCAPE_TIER_HEIGHT_PAD_PX)
  }
  const eff = Math.max(0, h - PORTRAIT_TIER_HEIGHT_ADJUST_PX)
  return rawTierFromDim(eff)
}

/** Filled transport glyphs (Lucide defaults are stroked). */
function FilledPlay({ className }: { className?: string }) {
  return <Play className={cn('fill-foreground stroke-none', className)} strokeWidth={0} aria-hidden />
}

function FilledPause({ className }: { className?: string }) {
  return <Pause className={cn('fill-foreground stroke-none', className)} strokeWidth={0} aria-hidden />
}

/**
 * Skip prev/next: filled triangle + thin vertical bar (same geometry as Lucide SkipBack/SkipForward),
 * so they read as skip vs. play (triangle-only).
 */
function FilledSkipBack({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={cn('block shrink-0', className)}
      aria-hidden
    >
      <polygon points="19 20 9 12 19 4 19 20" className="fill-foreground" stroke="none" />
      <line
        x1="5"
        y1="19"
        x2="5"
        y2="5"
        className="stroke-foreground"
        strokeWidth={2.25}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

function FilledSkipForward({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={cn('block shrink-0', className)}
      aria-hidden
    >
      <polygon points="5 4 15 12 5 20 5 4" className="fill-foreground" stroke="none" />
      <line
        x1="19"
        y1="5"
        x2="19"
        y2="19"
        className="stroke-foreground"
        strokeWidth={2.25}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

/** Active audio carousel thumb: same play / pause / replay treatment as video gallery thumbs. */
function galleryAudioCarouselTransportIcon(opts: { playing: boolean; ended: boolean; canPlay: boolean }) {
  const iconClass =
    'h-5 w-5 shrink-0 text-white fill-white stroke-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]'
  if (!opts.canPlay) {
    return <Play className={cn(iconClass, 'translate-x-[1px] opacity-45')} strokeWidth={0} aria-hidden />
  }
  if (opts.ended) {
    return (
      <RotateCcw
        className="h-5 w-5 shrink-0 text-white fill-none stroke-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]"
        strokeWidth={2.25}
        aria-hidden
      />
    )
  }
  if (opts.playing) {
    return <Pause className={iconClass} strokeWidth={0} aria-hidden />
  }
  return <Play className={`${iconClass} translate-x-[1px]`} strokeWidth={0} aria-hidden />
}

function coverArtClass(tier: number, landscape: boolean, hasGallery: boolean): string {
  if (landscape) {
    /* Reserve toolbar + carousel strip + control column; avoid vh-based box clipping under bar / over strip */
    if (hasGallery) {
      return 'aspect-square max-h-[min(100%,min(42vw,min(280px,calc(100svh-15rem))))] w-[min(100%,min(42vw,min(280px,calc(100svh-15rem))))] max-w-[min(100%,50vw)] shrink-0 self-center'
    }
    return 'aspect-square max-h-[min(100%,min(50vw,min(320px,calc(100svh-11rem))))] w-[min(100%,min(50vw,min(320px,calc(100svh-11rem))))] max-w-[min(100%,50vw)] shrink-0 self-center'
  }
  if (tier >= 6) return 'w-[min(100%,min(88px,24vh))]'
  if (tier >= 5) return 'w-[min(100%,min(120px,28vh))]'
  if (tier >= 4) return 'w-[min(100%,min(168px,min(34vh,40vw)))]'
  if (tier >= 3) return 'w-[min(100%,min(220px,38vh))]'
  if (tier >= 2) return 'w-[min(100%,min(260px,40vh))]'
  return 'w-[min(100%,min(320px,42vh))]'
}

export function MediaPreviewModalAudio({
  chatAudioGallery,
  onClose,
  source,
  originUserId,
  originDisplayName,
  originAvatarDataUrl,
  originSentAtIso,
  localPath: localPathProp,
  attachmentId: attachmentIdProp,
  fileName: fileNameProp,
  musicCoverFullSourcePath: musicCoverFullSourcePathProp,
  sizeBytes: sizeBytesProp,
  sha256: sha256Prop,
  showShareInChat: showShareInChatProp,
  onShareInChat: onShareInChatProp,
}: AudioPreviewProps) {
  const galleryItems = chatAudioGallery?.items
  const hasAudioGallery = !!(galleryItems && galleryItems.length >= 2)
  const galleryKey =
    (galleryItems?.map((i) => i.attachmentId).join('|') ?? '') + ':' + (chatAudioGallery?.startIndex ?? 0)
  const [galleryIdx, setGalleryIdx] = useState(() => chatAudioGallery?.startIndex ?? 0)
  /** After opening the modal or switching carousel track, start playback once waveform + media are ready. */
  const pendingCarouselAutoplayRef = useRef(false)

  useEffect(() => {
    pendingCarouselAutoplayRef.current = true
  }, [])

  useEffect(() => {
    setGalleryIdx(chatAudioGallery?.startIndex ?? 0)
  }, [chatAudioGallery?.startIndex, galleryKey])

  const activeItem = hasAudioGallery && galleryItems ? galleryItems[galleryIdx]! : null

  const localPath = activeItem?.localPath ?? localPathProp
  const attachmentId = activeItem?.attachmentId ?? attachmentIdProp
  const fileName = activeItem?.fileName ?? fileNameProp
  const musicCoverFullSourcePath = activeItem?.musicCoverFullSourcePath ?? musicCoverFullSourcePathProp
  const sizeBytes = activeItem?.sizeBytes ?? sizeBytesProp
  const sha256 = activeItem?.sha256 ?? sha256Prop
  const showShareInChat = activeItem?.showShareInChat ?? showShareInChatProp
  const onShareInChat = activeItem?.onShareInChat ?? onShareInChatProp

  const goPrevTrack = useCallback(() => {
    setGalleryIdx((i) => {
      const next = Math.max(0, i - 1)
      if (next !== i) pendingCarouselAutoplayRef.current = true
      return next
    })
  }, [])

  const goNextTrack = useCallback(() => {
    setGalleryIdx((i) => {
      const n = galleryItems?.length ?? 0
      if (n < 2) return i
      const next = Math.min(n - 1, i + 1)
      if (next !== i) pendingCarouselAutoplayRef.current = true
      return next
    })
  }, [galleryItems?.length])

  useEffect(() => {
    if (!hasAudioGallery) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable=true]')) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrevTrack()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNextTrack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasAudioGallery, goPrevTrack, goNextTrack])

  const galleryStripRef = useRef<HTMLDivElement>(null)
  const galleryIdxRef = useRef(galleryIdx)
  galleryIdxRef.current = galleryIdx
  const [galleryStripOverflows, setGalleryStripOverflows] = useState(false)

  useEffect(() => {
    if (!hasAudioGallery || !galleryItems?.length) return
    const root = galleryStripRef.current
    if (!root) return
    const id = requestAnimationFrame(() => {
      const tabs = root.querySelectorAll<HTMLElement>('[role="tab"]')
      const active = tabs[galleryIdx]
      if (active) scrollAudioGalleryStripToCenterThumb(root, active, 'smooth')
    })
    return () => cancelAnimationFrame(id)
  }, [galleryIdx, galleryKey, hasAudioGallery, galleryItems?.length])

  useLayoutEffect(() => {
    if (!hasAudioGallery || !galleryItems?.length) {
      setGalleryStripOverflows(false)
      return
    }
    const root = galleryStripRef.current
    if (!root) return
    setGalleryStripOverflows(root.scrollWidth > root.clientWidth + 1)
  }, [hasAudioGallery, galleryItems?.length, galleryKey])

  useLayoutEffect(() => {
    if (!hasAudioGallery || !galleryItems?.length) return
    const root = galleryStripRef.current
    if (!root) return

    let raf = 0
    let skipFirstRo = true
    const runInstant = () => {
      const idx = galleryIdxRef.current
      const tabs = root.querySelectorAll<HTMLElement>('[role="tab"]')
      const active = tabs[idx]
      if (active) scrollAudioGalleryStripToCenterThumb(root, active, 'instant')
    }
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const overflows = root.scrollWidth > root.clientWidth + 1
        setGalleryStripOverflows(overflows)
        if (skipFirstRo) {
          skipFirstRo = false
          return
        }
        runInstant()
      })
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(root)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [hasAudioGallery, galleryItems?.length, galleryKey])

  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverLoading, setCoverLoading] = useState(false)
  const [coverFailed, setCoverFailed] = useState(false)
  const [avatarImgFailed, setAvatarImgFailed] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [sampleRateHz, setSampleRateHz] = useState<number | null>(null)
  /** ffprobe when available; bits only from container (not from Web Audio decode). */
  const [ffprobeAudio, setFfprobeAudio] = useState<{
    sampleRateHz: number
    bitsPerSample: number | null
  } | null>(null)

  /** Media letterbox (available region below toolbar) — not the player chrome box, so tier/cover don’t collapse before cover/waveform load. */
  const letterboxMeasureRef = useRef<HTMLDivElement | null>(null)
  const [layoutSize, setLayoutSize] = useState({ w: 0, h: 0 })

  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  const audioSrc = useMemo(() => {
    const p = localPath?.trim()
    if (!p) return null
    try {
      return convertFileSrc(p)
    } catch {
      return null
    }
  }, [localPath])

  const waveformSeed = `${attachmentId ?? ''}\0${fileName ?? ''}\0${localPath ?? ''}`

  const isLandscape = layoutSize.w > layoutSize.h && layoutSize.w > 0
  const tier = useMemo(() => {
    const h = layoutSize.h
    if (h <= 0) return 0
    return tierFromContentHeight(h, isLandscape)
  }, [layoutSize.h, isLandscape])

  const waveHeight = useMemo(() => {
    if (tier >= 5) return 32
    if (tier >= 3) return 36
    return isLandscape ? 40 : 48
  }, [tier, isLandscape])

  const {
    cardRootRef,
    audioRef,
    canvasRef,
    waveWrapRef,
    shouldLoadMedia,
    preloadAttr,
    onAudioLoadedMetadata,
    onAudioCanPlay,
    playing,
    playbackEnded,
    canPlay,
    togglePlay,
    armPendingPlay,
    displayProgress,
    displayCurrentSec,
    durationSec,
    waveH,
    rowHeightClass,
    onWavePointerDown,
    onWavePointerMove,
    onWavePointerUp,
    formatClock,
    waveformPlaybackReady,
  } = useMusicWaveform({
    audioSrc,
    waveformSeed,
    waveformPeaks: null,
    attachmentId,
    lazyLoadMedia: false,
    gatePlayUntilWaveformReady: true,
    compact: false,
    waveHeight,
    onDecodedSampleRate: setSampleRateHz,
  })

  useEffect(() => {
    if (!pendingCarouselAutoplayRef.current) return
    if (!waveformPlaybackReady) return
    pendingCarouselAutoplayRef.current = false
    armPendingPlay()
  }, [waveformPlaybackReady, audioSrc, attachmentId, armPendingPlay])

  const setPlayerRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      ;(cardRootRef as MutableRefObject<HTMLDivElement | null>).current = el
    },
    [cardRootRef]
  )

  useLayoutEffect(() => {
    const el = letterboxMeasureRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr) return
      setLayoutSize({ w: cr.width, h: cr.height })
    })
    ro.observe(el)
    setLayoutSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    el.muted = muted
    el.volume = muted ? 0 : volume
  }, [volume, muted, shouldLoadMedia, audioSrc, audioRef])

  useEffect(() => {
    setCoverFailed(false)
    setCoverUrl(null)
    if (musicCoverFullSourcePath === null) {
      setCoverLoading(false)
      return
    }
    const aid = attachmentId?.trim()
    const coverSource = (musicCoverFullSourcePath ?? localPath)?.trim()
    if (!coverSource) {
      setCoverLoading(false)
      return
    }
    if (!aid) {
      setCoverLoading(false)
      return
    }
    let cancelled = false
    setCoverLoading(true)
    void ensureMusicCoverPreviewFull(aid, coverSource)
      .then((p) => {
        if (cancelled) return
        if (p) {
          try {
            setCoverUrl(convertFileSrc(p))
          } catch {
            setCoverUrl(null)
          }
        } else {
          setCoverUrl(null)
        }
      })
      .catch(() => {
        if (!cancelled) setCoverUrl(null)
      })
      .finally(() => {
        if (!cancelled) setCoverLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attachmentId, musicCoverFullSourcePath, localPath])

  useEffect(() => {
    const p = localPath?.trim()
    if (!p) {
      setFfprobeAudio(null)
      return
    }
    let cancelled = false
    void getAudioStreamInfo(p).then((info) => {
      if (cancelled) return
      if (!info) {
        setFfprobeAudio(null)
        return
      }
      setFfprobeAudio({
        sampleRateHz: info.sampleRateHz,
        bitsPerSample: info.bitsPerSample ?? null,
      })
    })
    return () => {
      cancelled = true
    }
  }, [localPath])

  const extLabel = fileName?.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.') + 1).toUpperCase()
    : '—'

  const displayTitleName = fileName?.trim()
    ? stripFileExtension(fileName.trim()) || fileName.trim()
    : 'Audio'

  const avgKbps =
    sizeBytes != null &&
    sizeBytes > 0 &&
    Number.isFinite(durationSec) &&
    durationSec > 0
      ? (sizeBytes * 8) / durationSec / 1000
      : null

  const rateHzForSpecs =
    ffprobeAudio != null && Number.isFinite(ffprobeAudio.sampleRateHz) && ffprobeAudio.sampleRateHz > 0
      ? ffprobeAudio.sampleRateHz
      : sampleRateHz != null && Number.isFinite(sampleRateHz) && sampleRateHz > 0
        ? sampleRateHz
        : null

  const bitsForSpecs =
    ffprobeAudio?.bitsPerSample != null &&
    Number.isFinite(ffprobeAudio.bitsPerSample) &&
    ffprobeAudio.bitsPerSample > 0
      ? ffprobeAudio.bitsPerSample
      : null

  const rateBitsDisplay =
    rateHzForSpecs != null
      ? bitsForSpecs != null
        ? `${formatKhzFromHz(rateHzForSpecs)} / ${bitsForSpecs}`
        : `${formatKhzFromHz(rateHzForSpecs)} kHz`
      : null

  const primaryMetaLine = [
    extLabel,
    sizeBytes != null && sizeBytes > 0 ? formatBytes(sizeBytes) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const specsMetaLine = [avgKbps != null ? `~${avgKbps.toFixed(0)} kbps` : null, rateBitsDisplay]
    .filter(Boolean)
    .join(' · ')

  const displayLabel = originDisplayName?.trim() || 'Unknown'
  let formattedTime = originSentAtIso
  try {
    const d = new Date(originSentAtIso)
    if (!Number.isNaN(d.getTime())) {
      formattedTime = d.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    }
  } catch {
    /* keep raw */
  }

  const canOpenFolder = !!(localPath && String(localPath).trim())
  const onOpenFolder = () => {
    if (!localPath) return
    void openPathInFileExplorer(directoryForPath(localPath))
  }

  const onShare = async () => {
    if (!onShareInChat || shareBusy) return
    setShareBusy(true)
    try {
      await Promise.resolve(onShareInChat())
    } finally {
      setShareBusy(false)
    }
  }

  const detailsContent = (
    <div className="space-y-1 text-left font-mono text-[11px] leading-snug">
      <div className="font-sans font-medium text-popover-foreground break-all">{fileName ?? 'Audio'}</div>
      {sizeBytes != null && sizeBytes > 0 && <div>{formatBytes(sizeBytes)}</div>}
      {sha256 && (
        <div className="break-all opacity-90" title={sha256}>
          {truncateSha256(sha256)}
        </div>
      )}
    </div>
  )

  const chromeStop = (e: React.MouseEvent) => e.stopPropagation()

  const avatarKey = originUserId?.trim() || 'unknown'
  const hasAvatarUrl = !!(originAvatarDataUrl && String(originAvatarDataUrl).trim())
  const showAvatarPlaceholder = !hasAvatarUrl || avatarImgFailed
  const avatarFallbackStyle: CSSProperties | undefined = showAvatarPlaceholder
    ? avatarStyleForUserId(avatarKey)
    : undefined

  const totalSecDisplay = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0

  /** kbps/kHz — first meta row to hide when compressing */
  const showSpecsMeta = tier < 2 && !!specsMetaLine
  /** file type · size — hides one tier after specs */
  const showPrimaryMeta = tier < 3 && !!primaryMetaLine
  const showVolume = tier < 3
  /** Play hides at tier 5; waveform at 6 — so at tier 4 the smaller cover can sit with play still visible. */
  const showPlay = tier < 5
  const showWaveform = tier < 6
  const showTitle = tier < 6

  const coverCls = coverArtClass(tier, isLandscape, hasAudioGallery)

  const waveformBlock = (
    <div
      className={cn(
        'w-full min-h-0 min-w-0 shrink space-y-2',
        !showWaveform && 'hidden',
        !showWaveform && 'pointer-events-none select-none'
      )}
      aria-hidden={!showWaveform}
    >
      <div className="flex w-full min-w-0 items-center gap-1 tabular-nums text-muted-foreground sm:gap-1.5">
        <span className="w-9 shrink-0 text-left text-[11px] tabular-nums sm:w-10 sm:text-xs">
          {totalSecDisplay > 0 ? formatClock(displayCurrentSec, totalSecDisplay) : '—'}
        </span>
        <div
          ref={waveWrapRef}
          role={canPlay ? 'slider' : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(displayProgress * 100)}
          tabIndex={canPlay ? 0 : undefined}
          className={cn(
            'relative min-w-0 flex-1 rounded-sm touch-none select-none',
            rowHeightClass,
            canPlay && showWaveform && 'cursor-grab active:cursor-grabbing'
          )}
          style={{ height: waveH }}
          onPointerDown={canPlay && showWaveform ? onWavePointerDown : undefined}
          onPointerMove={canPlay && showWaveform ? onWavePointerMove : undefined}
          onPointerUp={canPlay && showWaveform ? onWavePointerUp : undefined}
          onPointerCancel={canPlay && showWaveform ? onWavePointerUp : undefined}
          onKeyDown={
            canPlay && showWaveform
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    togglePlay()
                  }
                }
              : undefined
          }
        >
          <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 block h-full w-full" aria-hidden />
        </div>
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums sm:w-10 sm:text-xs">
          {totalSecDisplay > 0 ? formatClock(totalSecDisplay, totalSecDisplay) : '—'}
        </span>
      </div>
    </div>
  )

  const titleBlock = (
    <div
      className={cn(
        'w-full min-h-0 min-w-0 space-y-1 overflow-hidden text-center',
        !showTitle && 'hidden'
      )}
    >
      <Tooltip
        content={fileName?.trim() || displayTitleName}
        side="top"
        showDelayMs={0}
        hideDelayMs={0}
        fadeMs={70}
        dismissOnTriggerPointerDown
        className="block w-full min-w-0 max-w-full"
        contentClassName="max-w-[min(90vw,420px)] whitespace-normal break-words [overflow-wrap:anywhere] text-left font-normal"
      >
        <div
          className={cn(
            'mx-auto w-full max-w-full px-0.5 font-semibold text-foreground [overflow-wrap:anywhere] break-words text-pretty',
            tier >= 5 ? 'text-sm' : 'text-base sm:text-lg',
            'line-clamp-[8] sm:line-clamp-[10]'
          )}
        >
          {displayTitleName}
        </div>
      </Tooltip>
      {showPrimaryMeta && primaryMetaLine ? (
        <p className="text-muted-foreground [overflow-wrap:anywhere] text-[10px] leading-snug sm:text-xs">{primaryMetaLine}</p>
      ) : null}
      {showSpecsMeta && specsMetaLine ? (
        <p className="text-muted-foreground [overflow-wrap:anywhere] text-[10px] leading-snug sm:text-xs">{specsMetaLine}</p>
      ) : null}
    </div>
  )

  const transportIconClass = tier >= 5 ? 'h-4 w-4' : 'h-5 w-5 sm:h-6 sm:w-6'
  const skipBtnClass = cn(
    'rounded-md border-2 border-foreground/50 bg-background/90 shrink-0',
    tier >= 5 ? 'h-9 w-9' : 'h-11 w-11 sm:h-12 sm:w-12'
  )
  const playBtnClass = cn(
    'rounded-md border-2 border-foreground/50 bg-background/90',
    tier >= 5 ? 'h-10 w-10' : 'h-12 w-12 sm:h-14 sm:w-14',
    (!canPlay || !waveformPlaybackReady) && 'opacity-50'
  )

  const playBlock = (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center gap-2 pt-1 sm:gap-4',
        hasAudioGallery && 'gap-3 sm:gap-5',
        !showPlay && 'hidden'
      )}
    >
      {hasAudioGallery ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={skipBtnClass}
          disabled={galleryIdx <= 0}
          aria-label="Previous track"
          onClick={goPrevTrack}
        >
          <FilledSkipBack className={transportIconClass} />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled={!canPlay || !waveformPlaybackReady}
        className={playBtnClass}
        aria-label={
          !waveformPlaybackReady
            ? 'Loading waveform'
            : playing
              ? 'Pause'
              : playbackEnded
                ? 'Replay'
                : 'Play'
        }
        onClick={() => togglePlay()}
      >
        {!waveformPlaybackReady ? (
          <Loader2 className={cn('animate-spin', transportIconClass)} aria-hidden />
        ) : playing ? (
          <FilledPause className={transportIconClass} />
        ) : playbackEnded ? (
          <RotateCcw
            className={cn('fill-none stroke-foreground', transportIconClass)}
            strokeWidth={2.25}
            aria-hidden
          />
        ) : (
          <FilledPlay className={cn('pl-0.5', transportIconClass)} />
        )}
      </Button>
      {hasAudioGallery ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={skipBtnClass}
          disabled={!galleryItems || galleryIdx >= galleryItems.length - 1}
          aria-label="Next track"
          onClick={goNextTrack}
        >
          <FilledSkipForward className={transportIconClass} />
        </Button>
      ) : null}
    </div>
  )

  const volumeBlock = (
    <div
      className={cn(
        'flex w-full min-w-0 shrink-0 items-center gap-2 px-0.5 sm:gap-3',
        !showVolume && 'hidden'
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:bg-muted/80 hover:text-foreground"
        aria-label={muted ? 'Unmute' : 'Mute'}
        onClick={() => setMuted((m) => !m)}
      >
        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </Button>
      <Slider
        value={muted ? 0 : volume}
        min={0}
        max={1}
        step={0.01}
        onValueChange={(v) => {
          setVolume(v)
          if (v > 0) setMuted(false)
        }}
        className="min-w-0 flex-1"
        aria-label="Volume"
      />
    </div>
  )

  const coverArt = (
    <div
      className={cn(
        'relative aspect-square shrink-0 self-center overflow-hidden rounded-lg border border-border/50 bg-muted/50 shadow-lg',
        coverCls
      )}
    >
      {coverLoading ? (
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        </div>
      ) : coverUrl && !coverFailed ? (
        <img
          src={coverUrl}
          alt=""
          className="h-full w-full object-contain"
          draggable={false}
          onError={() => setCoverFailed(true)}
        />
      ) : (
        <div
          className={cn(
            'flex h-full w-full items-center justify-center',
            tier >= 6 ? '[&>svg]:h-12 [&>svg]:w-12' : '[&>svg]:h-16 [&>svg]:w-16 sm:[&>svg]:h-24 sm:[&>svg]:w-24'
          )}
        >
          <IconForCategory cat="music" className="text-muted-foreground" />
        </div>
      )}
    </div>
  )

  const controlsStack = (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden sm:gap-3',
        'w-full items-stretch',
        isLandscape && 'max-h-full max-w-xl flex-1 justify-center'
      )}
    >
      {waveformBlock}
      {titleBlock}
      {playBlock}
      {volumeBlock}
    </div>
  )

  /** Portrait: cover + controls as one block, vertically centered in the modal (not cover pinned top). */
  const portraitPlayerColumn = (
    <div className="flex min-h-0 w-full max-w-xl flex-col items-stretch gap-3 overflow-hidden min-w-0">
      {coverArt}
      {controlsStack}
    </div>
  )

  /** Landscape: cap overall row width on very wide windows; tier still follows height only. */
  const landscapePlayerRow = (
    <div className="mx-auto flex min-h-0 w-full max-w-6xl min-w-0 flex-row items-center justify-center gap-4 overflow-hidden">
      {coverArt}
      {controlsStack}
    </div>
  )

  return (
    <div className="pointer-events-none fixed top-8 bottom-[2px] left-[2px] right-[2px] z-[80] flex min-h-0 flex-col overflow-hidden">
      <div
        className="pointer-events-auto relative z-30 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 pb-2 pt-6"
        onClick={chromeStop}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-none text-[9px] font-mono tracking-wider text-white ring-2 ring-border"
            style={avatarFallbackStyle}
          >
            {hasAvatarUrl && !avatarImgFailed ? (
              <img
                src={originAvatarDataUrl!}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                onError={() => setAvatarImgFailed(true)}
              />
            ) : (
              <span className="relative z-[1] drop-shadow-sm">{initialsFromDisplayName(displayLabel)}</span>
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{displayLabel}</div>
            <div className="truncate text-xs text-muted-foreground">{formattedTime}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <div className="flex shrink-0 items-center gap-1">
            {source === 'chat' && showShareInChat && onShareInChat && (
              <Tooltip content={shareBusy ? 'Sharing…' : 'Share in this chat'} side="bottom">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className={toolbarIconBtnClass}
                  disabled={shareBusy}
                  onClick={() => void onShare()}
                  aria-label="Share in this chat"
                >
                  {shareBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                </Button>
              </Tooltip>
            )}
            <Tooltip
              content={detailsContent}
              side="bottom"
              contentClassName="max-w-[min(90vw,320px)] min-w-[200px] whitespace-normal break-words"
            >
              <Button type="button" variant="outline" size="icon" className={toolbarIconBtnClass} aria-label="File details">
                <Info className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip content={canOpenFolder ? 'Open folder' : 'File not on disk'} side="bottom">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={toolbarIconBtnClass}
                disabled={!canOpenFolder}
                onClick={onOpenFolder}
                aria-label="Open folder"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </Tooltip>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={toolbarIconBtnClass}
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="pointer-events-auto relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className="absolute inset-0 z-0 cursor-default bg-background/1 backdrop-blur-xl backdrop-saturate-150"
          role="button"
          tabIndex={0}
          aria-label="Close preview"
          onClick={onClose}
          onKeyDown={(e) => e.key === 'Enter' && onClose()}
        />
        <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pointer-events-none">
          {/*
            Letterbox around the player is pointer-events-none so clicks reach the backdrop (same as image/video modal).
            Only the centered player chrome receives hits.
          */}
          <div
            ref={letterboxMeasureRef}
            className="flex min-h-0 min-w-0 w-full flex-1 items-center justify-center overflow-hidden px-3 py-3 sm:px-4 pointer-events-none"
          >
            <div
              ref={setPlayerRootRef}
              className={cn(
                'relative z-10 flex w-full max-h-full min-h-0 min-w-0 justify-center overflow-hidden pointer-events-auto',
                isLandscape
                  ? 'max-w-6xl flex-row items-center gap-4'
                  : 'max-w-xl flex-col items-center px-1 sm:px-2'
              )}
              onClick={chromeStop}
            >
              {shouldLoadMedia && audioSrc ? (
                <audio
                  ref={audioRef}
                  src={audioSrc}
                  preload={preloadAttr}
                  className="hidden"
                  onLoadedMetadata={onAudioLoadedMetadata}
                  onCanPlay={onAudioCanPlay}
                />
              ) : null}

              {isLandscape ? landscapePlayerRow : portraitPlayerColumn}
            </div>
          </div>

          {hasAudioGallery && galleryItems && (
            <div className="pointer-events-auto min-h-0 shrink-0 overflow-hidden px-3 pb-4 pt-1 sm:px-4">
              <div
                ref={galleryStripRef}
                className={cn(
                  'z-20 flex min-w-0 overflow-x-auto overflow-y-hidden px-2 pb-1 pt-2 [scrollbar-width:thin] [scrollbar-gutter:stable]',
                  galleryStripOverflows
                    ? 'pointer-events-auto justify-start'
                    : 'pointer-events-none justify-center'
                )}
                role="tablist"
                aria-label="Tracks in this message"
              >
                <div className={cn('flex min-w-0 gap-1', galleryStripOverflows ? '' : 'pointer-events-auto')}>
                  {galleryItems.map((it, i) => {
                    const thumb = it.thumbnailUrl?.trim()
                    const trackLabel = it.fileName?.trim() || `Track ${i + 1}`
                    const isActiveThumb = i === galleryIdx
                    const tabAriaLabel = isActiveThumb
                      ? !waveformPlaybackReady
                        ? `${trackLabel}, loading waveform`
                        : !canPlay
                          ? `${trackLabel}, loading`
                          : playbackEnded
                            ? `${trackLabel}, replay`
                            : playing
                              ? `${trackLabel}, pause`
                              : `${trackLabel}, play`
                      : trackLabel
                    return (
                      <Tooltip
                        key={it.attachmentId}
                        content={trackLabel}
                        side="top"
                        showDelayMs={0}
                        hideDelayMs={0}
                        fadeMs={70}
                        dismissOnTriggerPointerDown
                        className="shrink-0"
                        contentClassName="max-w-[min(90vw,420px)] whitespace-normal break-words [overflow-wrap:anywhere] text-left font-normal"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={isActiveThumb}
                          aria-label={tabAriaLabel}
                          className={cn(
                            'group/gthumb relative h-14 w-14 shrink-0 overflow-hidden rounded-md border transition-[opacity,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                            isActiveThumb
                              ? 'border-border opacity-100 ring-1 ring-ring ring-offset-0 ring-offset-background'
                              : 'border-border/50 opacity-50 hover:opacity-80'
                          )}
                          onClick={(e) => {
                            chromeStop(e)
                            if (isActiveThumb) {
                              togglePlay()
                              return
                            }
                            pendingCarouselAutoplayRef.current = true
                            setGalleryIdx(i)
                          }}
                        >
                          {thumb ? (
                            <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} />
                          ) : (
                            <div className="relative flex h-full w-full items-center justify-center bg-muted">
                              <span
                                aria-hidden
                                className={cn(
                                  'pointer-events-none absolute inset-0 z-0 flex items-center justify-center transition-opacity duration-150',
                                  isActiveThumb
                                    ? 'opacity-0'
                                    : 'opacity-0 group-hover/gthumb:opacity-100'
                                )}
                              >
                                <IconForCategory cat="music" className="h-6 w-6 text-muted-foreground" />
                              </span>
                            </div>
                          )}
                          {isActiveThumb ? (
                            <span
                              className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center rounded-md bg-black/30 transition-colors duration-150 group-hover/gthumb:bg-black/40"
                              aria-hidden
                            >
                              {!waveformPlaybackReady ? (
                                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]" />
                              ) : (
                                galleryAudioCarouselTransportIcon({
                                  playing,
                                  ended: playbackEnded,
                                  canPlay,
                                })
                              )}
                            </span>
                          ) : (
                            <span
                              className={cn(
                                'pointer-events-none absolute inset-0 z-[1] flex items-center justify-center rounded-md bg-black/30 transition-opacity duration-150',
                                'opacity-100 group-hover/gthumb:opacity-0'
                              )}
                              aria-hidden
                            >
                              <AudioLines
                                className="h-6 w-6 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
                                strokeWidth={2}
                                aria-hidden
                              />
                            </span>
                          )}
                        </button>
                      </Tooltip>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
