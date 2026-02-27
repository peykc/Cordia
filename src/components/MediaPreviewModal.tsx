import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Loader2 } from 'lucide-react'

const HIDE_CONTROLS_DELAY_MS = 1500
import { Button } from './ui/button'
import { CustomVideoPlayer } from './CustomVideoPlayer'
import { readAttachmentBytes } from '../lib/tauri'
import { cn } from '../lib/utils'
import { FilenameEllipsis } from './FilenameEllipsis'

const MAX_PREVIEW_W = 90
const MAX_PREVIEW_H = 85

type Props = {
  type: 'image' | 'video'
  url: string | null
  /** When url is null, fetch from attachmentId and show loading spinner */
  attachmentId?: string
  fileName?: string
  onClose: () => void
}

export function MediaPreviewModal({ type, url, attachmentId, fileName, onClose }: Props) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(url)
  const [loading, setLoading] = useState(!!attachmentId && !url)
  const [videoReady, setVideoReady] = useState(false)
  const [videoAspect, setVideoAspect] = useState<{ w: number; h: number } | null>(null)
  const [showMediaControls, setShowMediaControls] = useState(false)
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createdBlobRef = useRef<string | null>(null)

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    setVideoReady(false)
    setVideoAspect(null)
  }, [resolvedUrl, url])

  useEffect(() => {
    if (url) {
      setResolvedUrl(url)
      setLoading(false)
      return
    }
    if (!attachmentId || type !== 'video') return

    let cancelled = false
    setLoading(true)

    const load = async () => {
      try {
        const bytes = await readAttachmentBytes(attachmentId)
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
  }, [url, attachmentId, type])

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

  const displayUrl = resolvedUrl ?? url

  return (
    <div className="fixed top-8 left-1 right-1 bottom-1 z-40 flex items-center justify-center bg-black/80 rounded-b-md">
      <div
        className="absolute inset-0 cursor-default rounded-b-md"
        role="button"
        tabIndex={0}
        onClick={onClose}
        onKeyDown={(e) => e.key === 'Enter' && onClose()}
        aria-label="Close preview"
      />
      <div className="relative z-10 w-full h-full flex items-center justify-center p-4 pointer-events-none">
        {loading ? (
          <div className="flex flex-col items-center gap-4 text-white pointer-events-auto">
            <Loader2 className="h-12 w-12 animate-spin" />
            <span className="text-sm">Loading video…</span>
            <Button
              variant="outline"
              size="sm"
              className="border-white/50 text-white hover:bg-white/20"
              onClick={onClose}
            >
              Cancel
            </Button>
          </div>
        ) : type === 'image' && displayUrl ? (
          <div
            className="relative inline-block max-w-full max-h-full pointer-events-auto"
            onMouseEnter={handleMediaMouseEnter}
            onMouseMove={handleMediaMouseMove}
            onMouseLeave={handleMediaMouseLeave}
          >
            {/* Top vignette bar - file name left, X right */}
            <div
              className={cn(
                'absolute top-0 left-0 right-0 z-20 flex items-center justify-between bg-gradient-to-b from-black/90 to-transparent pt-2 pb-6 px-3 transition-opacity duration-200',
                showMediaControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
              )}
            >
              <div className="min-w-0 flex-1 overflow-hidden pr-2">
                <FilenameEllipsis name={fileName ?? 'Image'} className="block text-white text-xs" />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20 shrink-0"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <img
              src={displayUrl}
              alt=""
              className="max-w-full max-h-full object-contain block rounded-none"
              style={{
                maxWidth: `${MAX_PREVIEW_W}vw`,
                maxHeight: `${MAX_PREVIEW_H}vh`,
              }}
              draggable={false}
            />
          </div>
        ) : type === 'video' && displayUrl ? (
          <div
            className="relative inline-block max-w-full max-h-full pointer-events-auto"
            onMouseEnter={handleMediaMouseEnter}
            onMouseMove={handleMediaMouseMove}
            onMouseLeave={handleMediaMouseLeave}
          >
            <div
              className={cn(
                'absolute top-0 left-0 right-0 z-20 flex items-center justify-between bg-gradient-to-b from-black/90 to-transparent pt-2 pb-6 px-3 transition-opacity duration-200',
                showMediaControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
              )}
            >
              <div className="min-w-0 flex-1 overflow-hidden pr-2">
                <FilenameEllipsis name={fileName ?? 'Video'} className="block text-white text-xs" />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20 shrink-0"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div
              className={`transition-opacity duration-150 rounded-none overflow-hidden ${videoReady ? 'opacity-100' : 'opacity-0'}`}
              style={
                videoAspect
                  ? {
                      aspectRatio: `${videoAspect.w} / ${videoAspect.h}`,
                      maxWidth: 'min(90vw, 72rem)',
                      maxHeight: 'min(85vh, 45rem)',
                      width: `min(90vw, 72rem, min(85vh, 45rem) * ${videoAspect.w} / ${videoAspect.h})`,
                    }
                  : { width: 'min(90vw, 72rem)', height: 'min(85vh, 45rem)' }
              }
            >
              <CustomVideoPlayer
                src={displayUrl}
                onCanPlay={() => setVideoReady(true)}
                onAspectRatio={(w, h) => setVideoAspect({ w, h })}
                showControls={showMediaControls}
                keepControlsWhenPaused
                autoPlay
                className="w-full h-full rounded-none"
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
