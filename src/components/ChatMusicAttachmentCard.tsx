import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { AudioLines, Pause, Play, RotateCcw } from 'lucide-react'
import { FilenameEllipsis } from './FilenameEllipsis'
import { IconForCategory } from './FileIcon'
import { ChatMediaSlot } from './ChatMediaSlot'
import { cn } from '../lib/utils'
import { ensureMusicCoverThumbnail } from '../lib/tauri'
import type { WaveformPeaksPayload } from '../contexts/EphemeralMessagesContext'
import { ChatInlineAudioContext } from '../contexts/ChatInlineAudioContext'
import { LAZY_CHAT_COVER_ROOT_MARGIN } from './music/musicWaveformShared'
import { useMusicWaveform } from './music/useMusicWaveform'

type Props = {
  className?: string
  title: string
  size: string
  audioSrc: string | null
  waveformSeed: string
  /** From attachment prep / message JSON — skips fetch + Web Audio decode when valid. */
  waveformPeaks?: WaveformPeaksPayload | null
  /** Album art from prep (file URL or embedded data URL); same slot size as the default music icon. */
  coverSrc?: string | null
  /** Message attachment id — used to cache extracted art next to prep thumbnails. */
  attachmentId?: string
  /** Raw local path to the audio file (download/cache). When set without coverSrc, we extract embedded art like upload prep. */
  localMediaPathForCover?: string | null
  /** When set, cover art / default music icon opens the full audio preview modal (requires local file on disk). */
  onOpenAudioPreview?: () => void
  compact?: boolean
  children?: ReactNode
}

function ChatMusicAttachmentCardInner({
  className,
  title,
  size,
  audioSrc,
  waveformSeed,
  waveformPeaks,
  coverSrc,
  attachmentId,
  localMediaPathForCover,
  onOpenAudioPreview,
  compact,
  children,
}: Props) {
  const chatInline = useContext(ChatInlineAudioContext)
  const useDetachedChatAudio = Boolean(chatInline && attachmentId && audioSrc)
  /** Match by id only so remount / browser-normalized `src` cannot drop shared binding. */
  const isDetachedActive =
    useDetachedChatAudio && chatInline!.activeTrack?.attachmentId === attachmentId

  const requestChatPlayback = useCallback((): HTMLAudioElement | null => {
    if (!chatInline || !attachmentId || !audioSrc) return null
    let out: HTMLAudioElement | null = null
    flushSync(() => {
      chatInline.playTrack(attachmentId, audioSrc)
      out = chatInline.sharedAudioRef.current
    })
    return out
  }, [chatInline, attachmentId, audioSrc])

  const claimPlaybackForScrub = useCallback((): HTMLAudioElement | null => {
    if (!chatInline || !attachmentId || !audioSrc) return null
    let out: HTMLAudioElement | null = null
    flushSync(() => {
      chatInline.armTrack(attachmentId, audioSrc)
      out = chatInline.sharedAudioRef.current
    })
    return out
  }, [chatInline, attachmentId, audioSrc])

  const {
    cardRootRef,
    audioRef,
    showLocalAudioTag,
    canvasRef,
    waveWrapRef,
    preloadAttr,
    onAudioLoadedMetadata,
    onAudioCanPlay,
    playing,
    playbackEnded,
    canPlay,
    togglePlay,
    displayProgress,
    displayCurrentSec,
    durationSec,
    waveH,
    rowHeightClass,
    onWavePointerDown,
    onWavePointerMove,
    onWavePointerUp,
    formatSplitTime,
  } = useMusicWaveform({
    audioSrc,
    waveformSeed,
    waveformPeaks,
    attachmentId,
    lazyLoadMedia: true,
    compact,
    sharedAudioRef: isDetachedActive ? chatInline!.sharedAudioRef : null,
    requestChatPlayback: useDetachedChatAudio && !isDetachedActive ? requestChatPlayback : null,
    claimPlaybackForScrub: useDetachedChatAudio && !isDetachedActive ? claimPlaybackForScrub : null,
    maxCanvasDpr: 1,
  })

  const coverSlotRef = useRef<HTMLDivElement | null>(null)
  const [coverGateOpen, setCoverGateOpen] = useState(false)
  const [coverFailed, setCoverFailed] = useState(false)
  const [lazyCoverSrc, setLazyCoverSrc] = useState<string | null>(null)
  const displayCoverSrc = coverSrc ?? lazyCoverSrc

  useEffect(() => {
    const el = coverSlotRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setCoverGateOpen(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setCoverGateOpen(true)
        io.unobserve(el)
      },
      { root: null, rootMargin: LAZY_CHAT_COVER_ROOT_MARGIN, threshold: 0 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    setCoverFailed(false)
  }, [coverSrc, lazyCoverSrc])

  useEffect(() => {
    if (!coverGateOpen) return
    const id = attachmentId?.trim()
    const path = localMediaPathForCover?.trim()
    if (!id || !path) return
    if (coverSrc) {
      setLazyCoverSrc(null)
      return
    }
    let cancelled = false
    ensureMusicCoverThumbnail(id, path)
      .then((p) => {
        if (cancelled || !p) return
        setLazyCoverSrc(convertFileSrc(p))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [coverGateOpen, attachmentId, localMediaPathForCover, coverSrc])

  useEffect(() => {
    setLazyCoverSrc(null)
  }, [audioSrc, waveformSeed])

  /** No local file URL — show filename/size + type icon only (same card footprint as playback mode). */
  const showPlayerChrome = Boolean(audioSrc)

  const coverBody =
    showPlayerChrome && !coverFailed ? (
      displayCoverSrc ? (
        <ChatMediaSlot fillParent className="rounded-md">
          <img
            src={displayCoverSrc}
            alt=""
            loading="lazy"
            decoding="async"
            className="object-cover"
            draggable={false}
            onError={() => setCoverFailed(true)}
          />
        </ChatMediaSlot>
      ) : (
        <div
          className={cn(
            'flex h-full w-full items-center justify-center bg-muted',
            compact ? '[&>svg]:size-8' : '[&>svg]:size-10'
          )}
        >
          <IconForCategory cat="music" className="text-muted-foreground" />
        </div>
      )
    ) : (
      <div
        className={cn(
          'flex h-full w-full items-center justify-center text-muted-foreground',
          compact ? '[&>svg]:size-8' : '[&>svg]:size-10'
        )}
      >
        <IconForCategory cat="music" className="text-muted-foreground" />
      </div>
    )

  /** Skip rendering work for cards that are in the DOM but not on-screen (helps multi-attach messages). */
  const scrollPerfStyle = { contentVisibility: 'auto' as const } satisfies CSSProperties

  return (
    <div
      ref={cardRootRef}
      className={cn(
        'relative w-full overflow-hidden rounded-lg bg-muted/50 min-h-[90px]',
        compact && 'min-h-[68px]',
        className
      )}
      style={scrollPerfStyle}
    >
      {showLocalAudioTag ? (
        <audio
          ref={audioRef as RefObject<HTMLAudioElement>}
          src={audioSrc ?? undefined}
          preload={preloadAttr}
          className="hidden"
          onLoadedMetadata={onAudioLoadedMetadata}
          onCanPlay={onAudioCanPlay}
        />
      ) : null}

      <div
        className={cn(
          'relative flex min-h-0 flex-row items-center gap-3 bg-card px-3 py-2',
          compact && 'gap-2 py-1.5'
        )}
      >
        <div
          ref={coverSlotRef}
          className={cn(
            'relative aspect-square shrink-0 overflow-hidden rounded-md bg-muted',
            compact ? 'w-14' : 'w-[72px]'
          )}
        >
          {onOpenAudioPreview ? (
            <button
              type="button"
              className={cn(
                'group/cover relative flex h-full w-full min-h-0 min-w-0 items-stretch overflow-hidden rounded-md p-0 border-0 bg-transparent text-left',
                'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
              )}
              aria-label="Open audio preview"
              onClick={(e) => {
                e.stopPropagation()
                onOpenAudioPreview()
              }}
            >
              {coverBody}
              <span
                className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center rounded-md bg-black/0 transition-colors duration-150 group-hover/cover:bg-black/40"
                aria-hidden
              >
                <AudioLines
                  className={cn(
                    'text-white opacity-0 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] transition-opacity duration-150 group-hover/cover:opacity-100',
                    compact ? 'h-5 w-5' : 'h-6 w-6'
                  )}
                  strokeWidth={2}
                  aria-hidden
                />
              </span>
            </button>
          ) : (
            <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden rounded-md">{coverBody}</div>
          )}
        </div>

        {!showPlayerChrome ? (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-0.5">
              <FilenameEllipsis name={title} className="block text-sm font-medium leading-tight" title={title} />
              <span className="text-xs text-muted-foreground">{size}</span>
            </div>
            {children ? (
              <div className="flex shrink-0 flex-col items-center justify-center gap-1 self-stretch">{children}</div>
            ) : null}
          </>
        ) : (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-1.5">
              <div className="min-w-0">
                <FilenameEllipsis name={title} className="block text-sm font-medium leading-tight" title={title} />
                <span className="text-xs text-muted-foreground">{size}</span>
              </div>

              <div className="flex w-full min-w-0 items-center gap-2">
                <button
                  type="button"
                  disabled={!canPlay}
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 text-foreground',
                    'hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    !canPlay && 'cursor-not-allowed opacity-50',
                    canPlay && 'cursor-pointer'
                  )}
                  aria-label={playing ? 'Pause' : playbackEnded ? 'Replay' : 'Play'}
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePlay()
                  }}
                >
                  {playing ? (
                    <Pause className="h-4 w-4 fill-foreground stroke-none" strokeWidth={0} aria-hidden />
                  ) : playbackEnded ? (
                    <RotateCcw
                      className="h-4 w-4 fill-none stroke-foreground"
                      strokeWidth={2.25}
                      aria-hidden
                    />
                  ) : (
                    <Play
                      className="h-4 w-4 translate-x-[1px] fill-foreground stroke-none"
                      strokeWidth={0}
                      aria-hidden
                    />
                  )}
                </button>

                <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_8ch] items-center gap-x-0">
                  <div
                    ref={waveWrapRef}
                    role={canPlay ? 'slider' : undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(displayProgress * 100)}
                    tabIndex={canPlay ? 0 : undefined}
                    className={cn(
                      'relative min-w-0 w-full rounded-sm touch-none select-none',
                      rowHeightClass,
                      canPlay && 'cursor-grab active:cursor-grabbing'
                    )}
                    style={{ height: waveH }}
                    onPointerDown={canPlay ? onWavePointerDown : undefined}
                    onPointerMove={canPlay ? onWavePointerMove : undefined}
                    onPointerUp={canPlay ? onWavePointerUp : undefined}
                    onPointerCancel={canPlay ? onWavePointerUp : undefined}
                    onKeyDown={
                      canPlay
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

                  <div className="min-w-0 border-l border-border/30 pl-2 text-right tabular-nums text-[10px] leading-none text-muted-foreground whitespace-nowrap">
                    {formatSplitTime(displayCurrentSec, durationSec)}
                  </div>
                </div>
              </div>
            </div>

            {children ? (
              <div className="flex shrink-0 flex-col items-center justify-center gap-1 self-stretch">{children}</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

export const ChatMusicAttachmentCard = memo(ChatMusicAttachmentCardInner)
ChatMusicAttachmentCard.displayName = 'ChatMusicAttachmentCard'
