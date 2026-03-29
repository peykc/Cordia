import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { X, Loader2, Upload, FolderOpen, Info, ChevronLeft, ChevronRight, Play, Pause, RotateCcw } from 'lucide-react'
import { Button } from './ui/button'
import { CustomVideoPlayer, type CustomVideoPlayerHandle } from './CustomVideoPlayer'
import { Tooltip } from './Tooltip'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { ensureMusicCoverPreviewFull, readAttachmentBytes, openPathInFileExplorer } from '../lib/tauri'
import { formatBytes } from '../lib/bytes'
import type { MediaPreviewState } from '../contexts/MediaPreviewContext'

type ImageVideoPreviewProps = Extract<Exclude<MediaPreviewState, null>, { type: 'image' | 'video' }> & {
  onClose: () => void
}
import { avatarStyleForUserId } from '../lib/userAvatarStyle'
import { cn } from '../lib/utils'
import { FilenameEllipsis } from './FilenameEllipsis'

const HIDE_CONTROLS_DELAY_MS = 1500
/** Show the behind-media spinner only after this delay so fast loads never flash the loader. */
const MEDIA_SPINNER_DELAY_MS = 200
const IMAGE_ZOOM_SCALE = 2.25
/** Padding, carousel collapse, and transform scale share this so immersive zoom feels one motion. */
const IMAGE_ZOOM_LAYOUT_DURATION_CLASS = 'duration-300'
/** Side rails for prev/next: width collapses on immersive zoom so media can grow edge-to-edge. */
const GALLERY_SIDE_RAIL_MOTION = cn(
  'ease-out transition-[width,min-width,opacity,padding]',
  IMAGE_ZOOM_LAYOUT_DURATION_CLASS
)
const GALLERY_STRIP_IMMERSE_MOTION = cn(
  'ease-out transition-[max-height,padding-bottom,opacity,transform]',
  IMAGE_ZOOM_LAYOUT_DURATION_CLASS
)

/** Filled glyphs on thumb overlay (same idea as transfer list / FileIcon video previews). */
function galleryVideoOverlayIcon(opts: { isActive: boolean; playing: boolean; ended: boolean }) {
  const iconClass =
    'h-5 w-5 shrink-0 text-white fill-white stroke-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]'
  if (!opts.isActive) {
    return <Play className={`${iconClass} translate-x-[1px]`} strokeWidth={0} aria-hidden />
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

/** Horizontally center `thumb` inside `strip` scrollport (clamped so first/last can’t over-scroll). */
function scrollGalleryStripToCenterThumb(
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

/** Pixel rect where `object-fit: contain` draws an image in a cw×ch box (centered). */
function objectContainRect(containerW: number, containerH: number, intrinsicW: number, intrinsicH: number) {
  if (containerW <= 0 || containerH <= 0 || intrinsicW <= 0 || intrinsicH <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const scale = Math.min(containerW / intrinsicW, containerH / intrinsicH)
  const width = intrinsicW * scale
  const height = intrinsicH * scale
  const left = (containerW - width) / 2
  const top = (containerH - height) / 2
  return { left, top, width, height }
}

/**
 * Clamp pan so the scaled stage (uniform scale about CSS % origin) always covers the viewport — no empty gutters.
 * Symmetric (stageW*(s-1)/2) is wrong when transform-origin ≠ center; this matches the actual scaled AABB.
 */
function clampImageZoomPan(
  stageW: number,
  stageH: number,
  scale: number,
  originPct: { x: number; y: number },
  pan: { x: number; y: number }
) {
  if (stageW <= 0 || stageH <= 0) return { x: 0, y: 0 }
  if (scale <= 1) return { x: pan.x, y: pan.y }
  const Ox = (originPct.x / 100) * stageW
  const Oy = (originPct.y / 100) * stageH
  const xs = [0, stageW].map((cx) => Ox + scale * (cx - Ox))
  const ys = [0, stageH].map((cy) => Oy + scale * (cy - Oy))
  const left0 = Math.min(...xs)
  const right0 = Math.max(...xs)
  const top0 = Math.min(...ys)
  const bottom0 = Math.max(...ys)
  const minTx = stageW - right0
  const maxTx = -left0
  const minTy = stageH - bottom0
  const maxTy = -top0
  return {
    x: Math.max(minTx, Math.min(maxTx, pan.x)),
    y: Math.max(minTy, Math.min(maxTy, pan.y)),
  }
}

const ZOOM_PAN_DRAG_THRESHOLD_PX = 5

type Props = ImageVideoPreviewProps

export function MediaPreviewModal({
  type,
  url,
  attachmentId,
  fileName,
  onClose,
  source,
  originUserId,
  originDisplayName,
  originAvatarDataUrl,
  originSentAtIso,
  localPath,
  musicCoverFullSourcePath,
  sizeBytes,
  sha256,
  aspectW,
  aspectH,
  showShareInChat,
  onShareInChat,
  chatMediaGallery,
}: Props) {
  const galleryItems = chatMediaGallery?.items
  const hasGallery = !!(galleryItems && galleryItems.length >= 2)
  const galleryKey =
    (galleryItems?.map((i) => i.attachmentId).join('|') ?? '') + ':' + (chatMediaGallery?.startIndex ?? 0)

  const [galleryIdx, setGalleryIdx] = useState(() => chatMediaGallery?.startIndex ?? 0)

  useEffect(() => {
    setGalleryIdx(chatMediaGallery?.startIndex ?? 0)
  }, [chatMediaGallery?.startIndex, galleryKey])

  const activeGalleryItem = hasGallery && galleryItems ? galleryItems[galleryIdx]! : null

  const displayType = activeGalleryItem?.type ?? type
  const displayUrlProp = activeGalleryItem?.url ?? url
  const displayAttachmentId = activeGalleryItem?.attachmentId ?? attachmentId
  const displayFileName = activeGalleryItem?.fileName ?? fileName
  const displayLocalPath = activeGalleryItem?.localPath ?? localPath
  const displayMusicCoverFullSourcePath = activeGalleryItem?.musicCoverFullSourcePath ?? musicCoverFullSourcePath
  const displaySizeBytes = activeGalleryItem?.sizeBytes ?? sizeBytes
  const displaySha256 = activeGalleryItem?.sha256 ?? sha256
  const displayAspectW = activeGalleryItem?.aspectW ?? aspectW
  const displayAspectH = activeGalleryItem?.aspectH ?? aspectH
  const displayShowShareInChat = activeGalleryItem?.showShareInChat ?? showShareInChat
  const displayOnShareInChat = activeGalleryItem?.onShareInChat ?? onShareInChat

  const [resolvedUrl, setResolvedUrl] = useState<string | null>(displayUrlProp)
  const [loading, setLoading] = useState(() => !!(displayAttachmentId && !displayUrlProp))
  const [videoReady, setVideoReady] = useState(false)
  const [videoAspect, setVideoAspect] = useState<{ w: number; h: number } | null>(null)
  const [showMediaControls, setShowMediaControls] = useState(false)
  /** Mirrors CustomVideoPlayer `playing` so top vignette stays visible when bottom controls stay up (paused/ended + keepControlsWhenPaused). */
  const [videoPlaying, setVideoPlaying] = useState(true)
  /** Mirrors CustomVideoPlayer `playbackEnded` so carousel shows replay like the main control. */
  const [videoPlaybackEnded, setVideoPlaybackEnded] = useState(false)
  /** Full-width chevron hides bottom controls + top filename until expanded again. */
  const [videoChromeCollapsed, setVideoChromeCollapsed] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [imageNatural, setImageNatural] = useState<{ w: number; h: number } | null>(null)
  /** Image `<img>` decode / paint — separate from URL resolution so we can show a delayed spinner behind. */
  const [imageBitmapReady, setImageBitmapReady] = useState(false)
  const [imageZoomed, setImageZoomed] = useState(false)
  const [imageZoomOriginPct, setImageZoomOriginPct] = useState({ x: 50, y: 50 })
  const imageZoomOriginPctRef = useRef(imageZoomOriginPct)
  imageZoomOriginPctRef.current = imageZoomOriginPct
  const [imageZoomPan, setImageZoomPan] = useState({ x: 0, y: 0 })
  /** While primary button is down on zoomed image — disable translate transitions + show grabbing cursor. */
  const [imageZoomPointerCaptured, setImageZoomPointerCaptured] = useState(false)
  const imageZoomPanRef = useRef(imageZoomPan)
  imageZoomPanRef.current = imageZoomPan
  const imageZoomPanGestureRef = useRef({
    pointerId: null as number | null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    didDrag: false,
  })
  const [avatarImgFailed, setAvatarImgFailed] = useState(false)
  /** When false, all thumbs fit — center the row; when true, use start alignment so horizontal scroll isn’t clipped. */
  const [galleryStripOverflows, setGalleryStripOverflows] = useState(false)
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createdBlobRef = useRef<string | null>(null)
  const galleryStripRef = useRef<HTMLDivElement>(null)
  const galleryIdxRef = useRef(galleryIdx)
  galleryIdxRef.current = galleryIdx
  const videoPlayerRef = useRef<CustomVideoPlayerHandle>(null)
  /** Stage — measured for vignette alignment with true object-contain bounds. */
  const imageStageRef = useRef<HTMLDivElement>(null)
  /** Filename strip + vignette track the visible bitmap when using object-contain (not full letterbox width). */
  const [imageVignetteRect, setImageVignetteRect] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)

  /** Full-bleed below toolbar when image zoomed — carousel row hidden; used by layout + strip measurement. */
  const imageImmersiveZoom = displayType === 'image' && imageZoomed

  /** Match vignette to object-contain rect; immersive uses full-width strip (object-cover). */
  useLayoutEffect(() => {
    if (displayType !== 'image') {
      setImageVignetteRect(null)
      return
    }
    const el = imageStageRef.current
    if (!el) return

    const measure = () => {
      if (imageImmersiveZoom) {
        setImageVignetteRect(null)
        return
      }
      const cw = el.clientWidth
      const ch = el.clientHeight
      if (cw <= 0 || ch <= 0) return
      const nw = imageNatural?.w ?? displayAspectW
      const nh = imageNatural?.h ?? displayAspectH
      if (nw == null || nh == null || nw <= 0 || nh <= 0) {
        setImageVignetteRect(null)
        return
      }
      const r = objectContainRect(cw, ch, nw, nh)
      setImageVignetteRect({ left: r.left, top: r.top, width: r.width, height: r.height })
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [
    displayType,
    displayAttachmentId,
    imageImmersiveZoom,
    imageNatural,
    displayAspectW,
    displayAspectH,
  ])

  /** Smoothly center the active thumb when the selection changes (main media still updates instantly). */
  useEffect(() => {
    if (!hasGallery || !galleryItems?.length || imageImmersiveZoom) return
    const root = galleryStripRef.current
    if (!root) return
    const id = requestAnimationFrame(() => {
      const tabs = root.querySelectorAll<HTMLElement>('[role="tab"]')
      const active = tabs[galleryIdx]
      if (active) scrollGalleryStripToCenterThumb(root, active, 'smooth')
    })
    return () => cancelAnimationFrame(id)
  }, [galleryIdx, galleryKey, hasGallery, galleryItems?.length, imageImmersiveZoom])

  /** Correct justify before paint when gallery content / width changes (RO also keeps this in sync on resize). */
  useLayoutEffect(() => {
    if (!hasGallery || !galleryItems?.length || imageImmersiveZoom) {
      setGalleryStripOverflows(false)
      return
    }
    const root = galleryStripRef.current
    if (!root) return
    setGalleryStripOverflows(root.scrollWidth > root.clientWidth + 1)
  }, [hasGallery, galleryItems?.length, galleryKey, imageImmersiveZoom])

  /** Instant re-center when the strip width changes (window resize); skip RO’s first fire so it doesn’t cancel opening smooth scroll. */
  useLayoutEffect(() => {
    if (!hasGallery || !galleryItems?.length || imageImmersiveZoom) return
    const root = galleryStripRef.current
    if (!root) return

    let raf = 0
    let skipFirstRo = true
    const runInstant = () => {
      const idx = galleryIdxRef.current
      const tabs = root.querySelectorAll<HTMLElement>('[role="tab"]')
      const active = tabs[idx]
      if (active) scrollGalleryStripToCenterThumb(root, active, 'instant')
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
  }, [hasGallery, galleryItems?.length, galleryKey, imageImmersiveZoom])

  const scheduleHideControls = useCallback(() => {
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current)
    hideControlsTimerRef.current = setTimeout(() => {
      setShowMediaControls(false)
      hideControlsTimerRef.current = null
    }, HIDE_CONTROLS_DELAY_MS)
  }, [])

  const handleMediaMouseEnter = useCallback(() => {
    setShowMediaControls(true)
    scheduleHideControls()
  }, [scheduleHideControls])

  const handleMediaMouseMove = useCallback(() => {
    setShowMediaControls(true)
    scheduleHideControls()
  }, [scheduleHideControls])

  const handleMediaMouseLeave = useCallback(() => {
    if (hideControlsTimerRef.current) {
      clearTimeout(hideControlsTimerRef.current)
      hideControlsTimerRef.current = null
    }
    setShowMediaControls(false)
  }, [])

  /** Discord-like: when an image is zoomed, gallery arrows + carousel hide — don’t steal arrow keys. */
  const galleryKeyboardActive =
    hasGallery && !!galleryItems && galleryItems.length >= 2 && !(displayType === 'image' && imageZoomed)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && galleryKeyboardActive) {
        e.preventDefault()
        const n = galleryItems!.length
        setGalleryIdx((i) => (i - 1 + n) % n)
        return
      }
      if (e.key === 'ArrowRight' && galleryKeyboardActive) {
        e.preventDefault()
        const n = galleryItems!.length
        setGalleryIdx((i) => (i + 1) % n)
        return
      }
      if (e.key !== 'Escape') return
      if (displayType === 'image' && imageZoomed) {
        setImageZoomed(false)
        setImageZoomPan({ x: 0, y: 0 })
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, displayType, imageZoomed, galleryKeyboardActive, galleryItems])

  /** Reset viewer chrome when the *logical* item changes — not when blob URL resolves for the same video. */
  useEffect(() => {
    setVideoReady(false)
    setVideoAspect(null)
    setImageNatural(null)
    setImageBitmapReady(false)
    setVideoPlaying(true)
    setImageZoomed(false)
    setImageZoomOriginPct({ x: 50, y: 50 })
    setImageZoomPan({ x: 0, y: 0 })
    setVideoChromeCollapsed(false)
  }, [displayAttachmentId, displayType, displayUrlProp])

  /** Transfers: full-res album art from audio file (not the list thumb). Clear stale bitmap when opening. */
  useLayoutEffect(() => {
    if (displayType !== 'image') return
    if (displayUrlProp) return
    if (!displayMusicCoverFullSourcePath?.trim() || !displayAttachmentId?.trim()) return
    if (createdBlobRef.current) {
      URL.revokeObjectURL(createdBlobRef.current)
      createdBlobRef.current = null
    }
    setResolvedUrl(null)
    setLoading(true)
  }, [displayType, displayUrlProp, displayAttachmentId, displayMusicCoverFullSourcePath])

  useEffect(() => {
    if (displayType !== 'image' || !displayMusicCoverFullSourcePath?.trim() || !displayAttachmentId?.trim()) return
    if (displayUrlProp) return
    let cancelled = false
    const load = async () => {
      try {
        const p = await ensureMusicCoverPreviewFull(displayAttachmentId, displayMusicCoverFullSourcePath)
        if (cancelled) return
        if (p) {
          setResolvedUrl(convertFileSrc(p))
        } else {
          setResolvedUrl(null)
        }
      } catch {
        if (!cancelled) setResolvedUrl(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [displayType, displayAttachmentId, displayMusicCoverFullSourcePath, displayUrlProp])

  useEffect(() => {
    setAvatarImgFailed(false)
  }, [originAvatarDataUrl, originUserId])

  /**
   * Before paint: drop stale blob / resolved URL when switching to a video that must be fetched.
   * Otherwise `resolvedUrl` from the previous item wins until the async effect runs and we briefly
   * feed a video blob to an <img> or an image URL to the player — huge jank.
   */
  useLayoutEffect(() => {
    if (displayUrlProp) return
    if (displayType !== 'video' || !displayAttachmentId) return
    if (createdBlobRef.current) {
      URL.revokeObjectURL(createdBlobRef.current)
      createdBlobRef.current = null
    }
    setResolvedUrl(null)
    setLoading(true)
  }, [displayAttachmentId, displayType, displayUrlProp])

  useEffect(() => {
    if (displayUrlProp) {
      if (createdBlobRef.current) {
        URL.revokeObjectURL(createdBlobRef.current)
        createdBlobRef.current = null
      }
      setResolvedUrl(displayUrlProp)
      setLoading(false)
      return
    }
    if (!displayAttachmentId || displayType !== 'video') return

    let cancelled = false

    const load = async () => {
      try {
        const bytes = await readAttachmentBytes(displayAttachmentId)
        const blob = new Blob([new Uint8Array(bytes)])
        const blobUrl = URL.createObjectURL(blob)
        if (!cancelled) {
          createdBlobRef.current = blobUrl
          setResolvedUrl(blobUrl)
          setLoading(false)
        } else {
          URL.revokeObjectURL(blobUrl)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [displayUrlProp, displayAttachmentId, displayType])

  useEffect(() => {
    return () => {
      const toRevoke = createdBlobRef.current
      if (toRevoke) {
        URL.revokeObjectURL(toRevoke)
        createdBlobRef.current = null
      }
      if (hideControlsTimerRef.current) {
        clearTimeout(hideControlsTimerRef.current)
      }
    }
  }, [])

  /** Prefer direct URL from the active item so we never show the previous item's blob/path for one frame. */
  const displayUrl = displayUrlProp ?? resolvedUrl

  const mediaBusy = useMemo(() => {
    if (loading) return true
    if (displayType === 'image' && displayUrl && !imageBitmapReady) return true
    if (displayType === 'video' && displayUrl && !videoReady) return true
    return false
  }, [loading, displayType, displayUrl, imageBitmapReady, videoReady])

  const [delayedSpinnerVisible, setDelayedSpinnerVisible] = useState(false)
  useEffect(() => {
    if (!mediaBusy) {
      setDelayedSpinnerVisible(false)
      return
    }
    const id = window.setTimeout(() => setDelayedSpinnerVisible(true), MEDIA_SPINNER_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [mediaBusy])

  useEffect(() => {
    if (displayType !== 'image' || !displayUrl) return
    setImageBitmapReady(false)
  }, [displayType, displayUrl, displayAttachmentId])

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

  const dimsW = imageNatural?.w ?? videoAspect?.w ?? displayAspectW
  const dimsH = imageNatural?.h ?? videoAspect?.h ?? displayAspectH
  const dimsLine =
    dimsW != null && dimsH != null && dimsW > 0 && dimsH > 0 ? `${dimsW}×${dimsH}` : null

  const canOpenFolder = !!(displayLocalPath && String(displayLocalPath).trim())

  const onOpenFolder = () => {
    if (!displayLocalPath) return
    void openPathInFileExplorer(directoryForPath(displayLocalPath))
  }

  const onShare = async () => {
    if (!displayOnShareInChat || shareBusy) return
    setShareBusy(true)
    try {
      await Promise.resolve(displayOnShareInChat())
    } finally {
      setShareBusy(false)
    }
  }

  const detailsContent = (
    <div className="space-y-1 text-left font-mono text-[11px] leading-snug">
      <div className="font-sans font-medium text-popover-foreground break-all">{displayFileName ?? 'Media'}</div>
      {displaySizeBytes != null && displaySizeBytes > 0 && <div>{formatBytes(displaySizeBytes)}</div>}
      {dimsLine && <div>{dimsLine}</div>}
      {displaySha256 && (
        <div className="break-all opacity-90" title={displaySha256}>
          {truncateSha256(displaySha256)}
        </div>
      )}
    </div>
  )

  const chromeStop = (e: React.MouseEvent) => e.stopPropagation()

  const suppressImageStageDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }, [])

  const onImageZoomPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // WebView2/Chromium: blocks native “drag image out” + selection highlight while panning / clicking zoom.
    e.preventDefault()
    if (!imageZoomed) return
    e.stopPropagation()
    const p = imageZoomPanRef.current
    const g = imageZoomPanGestureRef.current
    g.pointerId = e.pointerId
    g.startClientX = e.clientX
    g.startClientY = e.clientY
    g.startPanX = p.x
    g.startPanY = p.y
    g.didDrag = false
    setImageZoomPointerCaptured(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [imageZoomed])

  const onImageZoomPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!imageZoomed) return
    const g = imageZoomPanGestureRef.current
    if (g.pointerId !== e.pointerId) return
    const dx = e.clientX - g.startClientX
    const dy = e.clientY - g.startClientY
    if (Math.hypot(dx, dy) > ZOOM_PAN_DRAG_THRESHOLD_PX) g.didDrag = true
    if (!g.didDrag) return
    const stage = imageStageRef.current
    if (!stage) return
    const { width, height } = stage.getBoundingClientRect()
    setImageZoomPan(
      clampImageZoomPan(width, height, IMAGE_ZOOM_SCALE, imageZoomOriginPctRef.current, {
        x: g.startPanX + dx,
        y: g.startPanY + dy,
      })
    )
  }, [imageZoomed])

  const onImageZoomPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const g = imageZoomPanGestureRef.current
    if (g.pointerId == null || g.pointerId !== e.pointerId) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    g.pointerId = null
    setImageZoomPointerCaptured(false)
  }, [])

  const handleImageZoomClick = (e: React.MouseEvent<HTMLDivElement>) => {
    chromeStop(e)
    const stageEl = imageStageRef.current
    if (!stageEl) return
    const rect = stageEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    if (imageZoomed) {
      if (imageZoomPanGestureRef.current.didDrag) return
      setImageZoomed(false)
      setImageZoomPan({ x: 0, y: 0 })
      return
    }
    // transform-origin % is relative to the full stage box (same as the scaled wrapper), not the hit overlay.
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    setImageZoomOriginPct({
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y)),
    })
    setImageZoomPan({ x: 0, y: 0 })
    setImageZoomed(true)
  }

  /** Darker than title-bar chrome so these controls read as in-app, not OS window buttons */
  const toolbarIconBtnClass =
    'h-8 w-8 border-border bg-[hsl(220_7%_10%)] text-foreground hover:bg-muted/60'

  const galleryNavBtnClass =
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-none border border-white/15 bg-[hsl(220_7%_38%_/_0.47)] text-white shadow-md transition-colors hover:bg-[hsl(220_7%_44%_/_0.58)]'

  const goGalleryPrev = () =>
    setGalleryIdx((i) => {
      const n = galleryItems?.length ?? 0
      if (n < 2) return i
      return (i - 1 + n) % n
    })
  const goGalleryNext = () =>
    setGalleryIdx((i) => {
      const n = galleryItems?.length ?? 0
      if (n < 2) return i
      return (i + 1) % n
    })

  const avatarKey = originUserId?.trim() || 'unknown'
  const hasAvatarUrl = !!(originAvatarDataUrl && String(originAvatarDataUrl).trim())
  const showAvatarPlaceholder = !hasAvatarUrl || avatarImgFailed
  const avatarFallbackStyle: CSSProperties | undefined = showAvatarPlaceholder
    ? avatarStyleForUserId(avatarKey)
    : undefined

  return (
    /* Inset 2px = AppLayout border-2 so the program frame stays visible; blur/tint only below chrome */
    <div className="pointer-events-none fixed top-8 bottom-[2px] left-[2px] right-[2px] z-[80] flex min-h-0 flex-col overflow-hidden">
      {/* Toolbar: opaque bg-background — same as TitleBar; no transparency / blur here */}
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
            {source === 'chat' && displayShowShareInChat && displayOnShareInChat && (
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
              contentClassName="max-w-[min(90vw,320px)] min-w-[200px] whitespace-normal"
            >
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={toolbarIconBtnClass}
                aria-label="File details"
              >
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

      {/* Media region only: frosted / blurred backdrop; click-through on letterbox closes */}
      <div className="pointer-events-auto relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className="absolute inset-0 z-0 cursor-default bg-background/1 backdrop-blur-xl backdrop-saturate-150"
          role="button"
          tabIndex={0}
          aria-label="Close preview"
          onClick={onClose}
          onKeyDown={(e) => e.key === 'Enter' && onClose()}
        />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden pointer-events-none">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pointer-events-none">
          {/*
            Column: main media flex-1, thumbnail strip shrink-0 below (not over the image). On immersive
            zoom the strip collapses with max-height (not display:none) so flex-1 grows smoothly.
          */}
          <div
            className={cn(
              'pointer-events-none relative min-h-0 min-w-0 flex-1 overflow-hidden',
              hasGallery && 'flex min-h-0 min-w-0 flex-row'
            )}
          >
            {hasGallery && (
              <div
                className={cn(
                  'pointer-events-auto z-20 flex shrink-0 items-center justify-end',
                  GALLERY_SIDE_RAIL_MOTION,
                  imageImmersiveZoom
                    ? 'w-0 min-w-0 overflow-hidden py-0 pl-0 pr-0 opacity-0 pointer-events-none'
                    : 'w-12 min-w-[3rem] py-0 pl-3 pr-0 opacity-100'
                )}
              >
                <button
                  type="button"
                  aria-label="Previous attachment (wraps to last)"
                  className={cn(galleryNavBtnClass, 'pointer-events-auto shrink-0')}
                  onClick={(e) => {
                    chromeStop(e)
                    goGalleryPrev()
                  }}
                >
                  <ChevronLeft className="h-5 w-5 shrink-0" strokeWidth={2.25} />
                </button>
              </div>
            )}
            <div
              className={cn(
                'pointer-events-none relative min-h-0 overflow-hidden',
                hasGallery ? 'min-w-0 flex-1' : 'h-full w-full'
              )}
            >
            <div
              className={cn(
                'pointer-events-none absolute inset-0 flex items-center justify-center transition-[padding] ease-out',
                IMAGE_ZOOM_LAYOUT_DURATION_CLASS,
                imageImmersiveZoom ? 'p-0' : 'p-4'
              )}
            >
            <div className="pointer-events-none relative flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden">
              {delayedSpinnerVisible && mediaBusy ? (
                <div
                  className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none text-foreground/70"
                  aria-hidden
                >
                  <Loader2 className="h-12 w-12 animate-spin" />
                </div>
              ) : null}
              {displayType === 'image' && displayUrl ? (
          /*
            True object-contain when unzoomed (full image, no cover crop). Immersive = object-cover fill + crop.
            Vignette tracks contain rect when letterboxed. Layout zoom smoothness uses padding/carousel only.
          */
          <div className="relative z-10 flex h-full min-h-0 w-full min-w-0 items-center justify-center overflow-hidden pointer-events-none">
            {/*
              Outer shell is pointer-events-none so letterbox / padding passes clicks to the backdrop.
              Only the hit overlay (bitmap bounds) uses pointer-events-auto for zoom + hover vignette.
            */}
            <div
              className={cn(
                'pointer-events-none relative h-full w-full min-h-0 min-w-0 max-h-full max-w-full overflow-hidden rounded-none select-none [-webkit-user-drag:none]'
              )}
            >
              <div
                ref={imageStageRef}
                role="presentation"
                className="pointer-events-none relative h-full w-full overflow-hidden select-none [-webkit-user-drag:none]"
              >
                <div
                  className={cn(
                    'relative h-full w-full min-h-0 min-w-0 transition-transform ease-out will-change-transform',
                    imageZoomPointerCaptured ? 'duration-0' : IMAGE_ZOOM_LAYOUT_DURATION_CLASS
                  )}
                  style={{
                    transform: imageZoomed
                      ? `translate(${imageZoomPan.x}px, ${imageZoomPan.y}px)`
                      : 'translate(0,0)',
                  }}
                >
                  <div
                    className={cn(
                      'relative h-full w-full min-h-0 min-w-0 transition-transform ease-out will-change-transform',
                      IMAGE_ZOOM_LAYOUT_DURATION_CLASS
                    )}
                    style={{
                      transform: imageZoomed ? `scale(${IMAGE_ZOOM_SCALE})` : 'scale(1)',
                      transformOrigin: `${imageZoomOriginPct.x}% ${imageZoomOriginPct.y}%`,
                    }}
                  >
                  <img
                    key={displayAttachmentId ?? displayUrl}
                    src={displayUrl}
                    alt=""
                    className={cn(
                      'pointer-events-none block h-full w-full rounded-none select-none transition-opacity duration-200 [-webkit-user-drag:none]',
                      imageImmersiveZoom ? 'object-cover object-center' : 'object-contain object-center',
                      imageBitmapReady ? 'opacity-100' : 'opacity-0'
                    )}
                    draggable={false}
                    onDragStart={(e) => e.preventDefault()}
                    onLoad={(e) => {
                      const el = e.currentTarget
                      setImageBitmapReady(true)
                      if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                        setImageNatural({ w: el.naturalWidth, h: el.naturalHeight })
                      }
                    }}
                    onError={() => setImageBitmapReady(true)}
                  />
                  <div
                    className={cn(
                      'pointer-events-none absolute z-20 flex items-start bg-gradient-to-b from-black/90 to-transparent pt-2 pb-8 px-3 transition-opacity duration-200',
                      showMediaControls ? 'opacity-100' : 'opacity-0',
                      imageImmersiveZoom && 'inset-x-0 top-0',
                      !imageImmersiveZoom && imageVignetteRect == null && 'inset-x-0 top-0'
                    )}
                    style={
                      !imageImmersiveZoom && imageVignetteRect
                        ? {
                            left: imageVignetteRect.left,
                            top: imageVignetteRect.top,
                            width: imageVignetteRect.width,
                            right: 'auto',
                          }
                        : undefined
                    }
                    aria-hidden
                  >
                    <div className="min-w-0 flex-1 overflow-hidden pr-2">
                      <FilenameEllipsis name={displayFileName ?? 'Image'} className="block text-xs text-white" />
                    </div>
                  </div>
                  </div>
                </div>
                {/*
                  Hit target: full stage when zoomed (object-cover). Unzoomed = object-contain bitmap only
                  so letterboxing doesn’t zoom / steal drags.
                */}
                <div
                  className={cn(
                    'pointer-events-auto absolute z-[15] select-none [-webkit-user-drag:none]',
                    imageImmersiveZoom || imageVignetteRect == null ? 'inset-0' : null,
                    imageImmersiveZoom &&
                      (imageZoomPointerCaptured ? 'cursor-grabbing touch-none' : 'cursor-grab touch-none'),
                    !imageImmersiveZoom && 'cursor-zoom-in touch-manipulation'
                  )}
                  style={
                    !imageImmersiveZoom && imageVignetteRect
                      ? {
                          left: imageVignetteRect.left,
                          top: imageVignetteRect.top,
                          width: imageVignetteRect.width,
                          height: imageVignetteRect.height,
                        }
                      : undefined
                  }
                  onMouseEnter={handleMediaMouseEnter}
                  onMouseMove={handleMediaMouseMove}
                  onMouseLeave={handleMediaMouseLeave}
                  onClick={handleImageZoomClick}
                  onPointerDown={onImageZoomPointerDown}
                  onPointerMove={onImageZoomPointerMove}
                  onPointerUp={onImageZoomPointerUp}
                  onPointerCancel={onImageZoomPointerUp}
                  onDragStart={suppressImageStageDragStart}
                  aria-hidden
                />
              </div>
            </div>
          </div>
        ) : displayType === 'video' && displayUrl ? (
          <div className="relative z-10 flex h-full min-h-0 w-full min-w-0 items-center justify-center overflow-hidden pointer-events-none">
            <div
              className={cn(
                'pointer-events-auto relative min-h-0 min-w-0 max-h-full max-w-full overflow-hidden rounded-none transition-opacity duration-150',
                videoReady ? 'opacity-100' : 'opacity-0'
              )}
              style={
                videoAspect
                  ? {
                      aspectRatio: `${videoAspect.w} / ${videoAspect.h}`,
                      maxWidth: '100%',
                      maxHeight: '100%',
                      width: 'auto',
                      height: 'auto',
                    }
                  : displayAspectW != null &&
                      displayAspectH != null &&
                      displayAspectW > 0 &&
                      displayAspectH > 0
                    ? {
                        aspectRatio: `${displayAspectW} / ${displayAspectH}`,
                        maxWidth: '100%',
                        maxHeight: '100%',
                        width: 'auto',
                        height: 'auto',
                      }
                    : {
                        maxWidth: '100%',
                        maxHeight: '100%',
                        width: 'min(100%, 72rem)',
                        aspectRatio: '16 / 9',
                      }
              }
              onMouseEnter={handleMediaMouseEnter}
              onMouseMove={handleMediaMouseMove}
              onMouseLeave={handleMediaMouseLeave}
              onClick={chromeStop}
            >
              <CustomVideoPlayer
                ref={videoPlayerRef}
                key={`${displayAttachmentId ?? displayUrl}-${displayUrl}`}
                src={displayUrl}
                onCanPlay={() => setVideoReady(true)}
                onAspectRatio={(w, h) => setVideoAspect({ w, h })}
                showControls={showMediaControls}
                keepControlsWhenPaused
                autoPlay
                onPlayingChange={setVideoPlaying}
                onPlaybackEndedChange={setVideoPlaybackEnded}
                collapsibleChrome
                chromeCollapsed={videoChromeCollapsed}
                onChromeCollapsedChange={setVideoChromeCollapsed}
                className="h-full w-full rounded-none"
              />
              <div
                className={cn(
                  'pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-start bg-gradient-to-b from-black/90 to-transparent pt-2 pb-8 px-3 transition-opacity duration-200',
                  !videoChromeCollapsed && (showMediaControls || !videoPlaying) ? 'opacity-100' : 'opacity-0'
                )}
                aria-hidden
              >
                <div className="min-w-0 flex-1 overflow-hidden pr-2">
                  <FilenameEllipsis name={displayFileName ?? 'Video'} className="block text-xs text-white" />
                </div>
              </div>
            </div>
          </div>
        ) : null}
            </div>
          </div>
            </div>

            {hasGallery && (
              <div
                className={cn(
                  'pointer-events-auto z-20 flex shrink-0 items-center justify-start',
                  GALLERY_SIDE_RAIL_MOTION,
                  imageImmersiveZoom
                    ? 'w-0 min-w-0 overflow-hidden py-0 pl-0 pr-0 opacity-0 pointer-events-none'
                    : 'w-12 min-w-[3rem] py-0 pl-0 pr-3 opacity-100'
                )}
              >
                <button
                  type="button"
                  aria-label="Next attachment (wraps to first)"
                  className={cn(galleryNavBtnClass, 'pointer-events-auto shrink-0')}
                  onClick={(e) => {
                    chromeStop(e)
                    goGalleryNext()
                  }}
                >
                  <ChevronRight className="h-5 w-5 shrink-0" strokeWidth={2.25} />
                </button>
              </div>
            )}
          </div>

          {hasGallery && galleryItems && (
            <div
              className={cn(
                'min-h-0 shrink-0 overflow-hidden px-4',
                GALLERY_STRIP_IMMERSE_MOTION,
                imageImmersiveZoom
                  ? 'pointer-events-none max-h-0 translate-y-full pb-0 opacity-0'
                  : 'max-h-[8rem] translate-y-0 pb-5 opacity-100'
              )}
            >
            <div
              ref={galleryStripRef}
              className={cn(
                'z-20 flex min-w-0 overflow-x-auto overflow-y-hidden px-2 pb-1 pt-3 [scrollbar-width:thin] [scrollbar-gutter:stable]',
                /* When all thumbs fit, outer row is full-width but must not steal clicks from the backdrop in the side gutters (centered strip). */
                galleryStripOverflows
                  ? 'pointer-events-auto justify-start'
                  : 'pointer-events-none justify-center'
              )}
              role="tablist"
              aria-label="Attachments in this message"
            >
              <div
                className={cn(
                  'flex min-w-0 gap-0.5',
                  galleryStripOverflows ? '' : 'pointer-events-auto'
                )}
              >
              {galleryItems.map((it, i) => {
                const activeVideoThumb = it.type === 'video' && i === galleryIdx
                const tabBaseLabel = it.fileName ?? `Attachment ${i + 1}`
                const tabAriaLabel =
                  it.type === 'video' && i === galleryIdx
                    ? videoPlaybackEnded
                      ? `${tabBaseLabel}, replay video`
                      : videoPlaying
                        ? `${tabBaseLabel}, pause video`
                        : `${tabBaseLabel}, play video`
                    : tabBaseLabel
                return (
                <button
                  key={it.attachmentId}
                  type="button"
                  role="tab"
                  aria-selected={i === galleryIdx}
                  aria-label={tabAriaLabel}
                  className={cn(
                    'group relative h-14 w-14 shrink-0 overflow-hidden rounded-none border transition-[opacity,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0',
                    i === galleryIdx
                      ? 'border-border opacity-100 ring-1 ring-ring ring-offset-0'
                      : 'border-border/50 opacity-45 hover:opacity-70'
                  )}
                  onClick={(e) => {
                    chromeStop(e)
                    if (it.type === 'video' && i === galleryIdx) {
                      videoPlayerRef.current?.togglePlay()
                      return
                    }
                    setGalleryIdx(i)
                  }}
                >
                  {it.thumbnailUrl ? (
                    <>
                      <img src={it.thumbnailUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                      {it.type === 'video' && (
                        <span
                          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 transition-colors group-hover:bg-black/40"
                          aria-hidden
                        >
                          {galleryVideoOverlayIcon({
                            isActive: activeVideoThumb,
                            playing: videoPlaying,
                            ended: videoPlaybackEnded,
                          })}
                        </span>
                      )}
                    </>
                  ) : it.type === 'video' ? (
                    <div className="relative flex h-full w-full items-center justify-center bg-muted">
                      <span
                        className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30"
                        aria-hidden
                      >
                        {galleryVideoOverlayIcon({
                          isActive: activeVideoThumb,
                          playing: videoPlaying,
                          ended: videoPlaybackEnded,
                        })}
                      </span>
                    </div>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-muted">
                      <Play className="h-6 w-6 text-muted-foreground" aria-hidden />
                    </div>
                  )}
                </button>
                )
              })}
              </div>
            </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
