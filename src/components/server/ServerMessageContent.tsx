import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { Download, Ban, EyeOff, Play, ImageDown, ImageOff, CloudOff, Upload } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip } from '../Tooltip'
import { FilenameEllipsis } from '../FilenameEllipsis'
import { formatBytes } from '../../lib/bytes'
import { cn } from '../../lib/utils'
import { FileIcon, IconForCategory } from '../FileIcon'
import { ImageDownPlay } from '../icons'
import { CustomVideoPlayer } from '../CustomVideoPlayer'
import { ChatMediaSlot, ChatFileRowSlot } from '../ChatMediaSlot'
import { ChatSingleMediaAspect } from '../ChatSingleMediaAspect'
import { isMediaType, getFileTypeFromExt } from '../../lib/fileType'
import {
  CHAT_MEDIA_MAX_W,
  CHAT_MEDIA_MAX_H,
  CHAT_MEDIA_MIN_W,
  getSingleAttachmentSize,
  getSingleAttachmentAspectRatio,
} from '../../lib/chatMessageLayout'
import { buildAttachmentTransferPresentation } from './attachmentTransferPresentation'

const NOT_DOWNLOADED_CARD_NARROW_PX = 110

function NotDownloadedCardByWidth({
  threshold,
  className,
  style,
  narrowContent,
  wideContent,
}: {
  threshold: number
  className?: string
  style?: CSSProperties
  narrowContent: ReactNode
  wideContent: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setNarrow(el.offsetWidth < threshold)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])
  return (
    <div ref={ref} className={className} style={style}>
      {narrow ? narrowContent : wideContent}
    </div>
  )
}

export function ServerMessageContent({ msg, ctx }: { msg: any; ctx: any }) {
  const {
    identity,
    sharedAttachments,
    unsharedAttachmentRecords,
    transferHistory,
    attachmentTransferRows,
    getCachedPathForSha,
    hasAccessibleCompletedDownload,
    attachmentStateLabelFor,
    revealedSpoilerIds,
    setRevealedSpoilerIds,
    server,
    groupChat,
    updateAttachmentAspect,
    requestAttachmentDownload,
    unavailableReasonFor,
    isSharedInServer,
    hasActiveUploadForAttachment,
    justSharedKeys,
    handleShareAgainAttachment,
    setMediaPreview,
    inlinePlayingVideoId,
    setInlinePlayingVideoId,
    videoScrollTargetsRef,
    setInlineVideoShowControls,
    inlineVideoShowControls,
    attachmentStateLabel,
  } = ctx

  return (
    <>
                                        {msg.kind === 'mixed' && msg.attachments?.length ? (
                                            <div className="pt-1 space-y-1.5">
                                              {(() => {
                                                const mediaAttachments = msg.attachments!.filter((a) =>
                                                  isMediaType(getFileTypeFromExt(a.file_name) as Parameters<typeof isMediaType>[0])
                                                )
                                                const otherAttachments = msg.attachments!.filter((a) =>
                                                  !isMediaType(getFileTypeFromExt(a.file_name) as Parameters<typeof isMediaType>[0])
                                                )
                                                return (
                                                  <>
                                              {mediaAttachments.length > 0 ? (
                                              <div
                                                className={cn(
                                                  'grid w-full max-w-full',
                                                  mediaAttachments.length === 1 && 'max-w-[min(100%,28rem)]',
                                                  mediaAttachments.length === 2 && 'grid-cols-2 gap-0.5 max-w-[min(100%,36rem)]',
                                                  mediaAttachments.length >= 3 && 'grid-cols-3 gap-1.5 max-w-[min(100%,32rem)]'
                                                )}
                                              >
                                                {mediaAttachments.map((att) => {
                                                  const count = mediaAttachments.length
                                                  const isSingle = count === 1
                                                  const isOwn = msg.from_user_id === identity?.user_id
                                                  const {
                                                    liveDownload,
                                                    hasPath,
                                                    thumbPath,
                                                    notDownloaded,
                                                    downloadProgress,
                                                    showDownloadProgress,
                                                  } = buildAttachmentTransferPresentation({
                                                    att,
                                                    isOwn,
                                                    attachmentTransferRows,
                                                    transferHistory,
                                                    sharedAttachments,
                                                    unsharedAttachmentRecords,
                                                    hasAccessibleCompletedDownload,
                                                    getCachedPathForSha,
                                                  })
                                                  const stateLabel = attachmentStateLabelFor(att)
                                                  const spoilerRevealed = revealedSpoilerIds.has(`${msg.id}:${att.attachment_id}`) || revealedSpoilerIds.has(msg.id)
                                                  if (att.spoiler && !spoilerRevealed) {
                                                    return isSingle ? (
                                                      <ChatSingleMediaAspect
                                                        key={att.attachment_id}
                                                        msgId={msg.id}
                                                        attachmentId={att.attachment_id}
                                                        att={att}
                                                        isSingle
                                                        signingPubkey={server?.signing_pubkey ?? ''}
                                                        chatId={groupChat?.id ?? ''}
                                                        updateAttachmentAspect={updateAttachmentAspect}
                                                      >
                                                        {({ aspect }) => (
                                                          <button
                                                            type="button"
                                                            onClick={() =>
                                                              setRevealedSpoilerIds((prev) =>
                                                                new Set(prev).add(`${msg.id}:${att.attachment_id}`)
                                                              )
                                                            }
                                                            className="w-full py-4 px-2 bg-muted/80 hover:bg-muted rounded-lg text-center min-h-[12rem]"
                                                            style={{ aspectRatio: getSingleAttachmentAspectRatio(aspect) }}
                                                          >
                                                            <EyeOff className="h-6 w-6 mx-auto mb-1 text-muted-foreground" />
                                                            <span className="text-[10px] text-muted-foreground block">Spoiler</span>
                                                          </button>
                                                        )}
                                                      </ChatSingleMediaAspect>
                                                    ) : (
                                                      <button
                                                        key={att.attachment_id}
                                                        type="button"
                                                        onClick={() =>
                                                          setRevealedSpoilerIds((prev) =>
                                                            new Set(prev).add(`${msg.id}:${att.attachment_id}`)
                                                          )
                                                        }
                                                        className="w-full py-4 px-2 bg-muted/80 hover:bg-muted rounded-lg text-center aspect-square"
                                                      >
                                                        <EyeOff className="h-6 w-6 mx-auto mb-1 text-muted-foreground" />
                                                        <span className="text-[10px] text-muted-foreground block">Spoiler</span>
                                                      </button>
                                                    )
                                                  }
                                                  const category = getFileTypeFromExt(att.file_name)
                                                  const isMedia = isMediaType(category as Parameters<typeof isMediaType>[0])
                                                  if (isSingle) {
                                                    return (
                                                      <ChatSingleMediaAspect
                                                        key={att.attachment_id}
                                                        msgId={msg.id}
                                                        attachmentId={att.attachment_id}
                                                        att={att}
                                                        isSingle
                                                        signingPubkey={server?.signing_pubkey ?? ''}
                                                        chatId={groupChat?.id ?? ''}
                                                        updateAttachmentAspect={updateAttachmentAspect}
                                                      >
                                                        {({ aspect, onImageLoad, onVideoMetadata, onVideoAspect }) => {
                                                          const mixedSingleRatio = getSingleAttachmentAspectRatio(aspect)
                                                          const { w: mixedSingleW } = getSingleAttachmentSize(aspect, CHAT_MEDIA_MAX_W, CHAT_MEDIA_MAX_H)
                                                          return (
                                                            <div
                                                              className={cn(
                                                                'group relative rounded-lg overflow-hidden border border-border/50',
                                                                notDownloaded ? 'bg-muted' : 'bg-muted/30',
                                                                'w-full min-w-0'
                                                              )}
                                                              style={{ width: '100%', minWidth: CHAT_MEDIA_MIN_W, maxWidth: mixedSingleW, aspectRatio: mixedSingleRatio }}
                                                            >
                                                              {notDownloaded ? (
                                                        <NotDownloadedCardByWidth
                                                          threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                          className={cn(
                                                            'relative w-full flex flex-col items-center justify-center gap-1.5 p-2 bg-muted rounded-lg border border-border/50 transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110',
                                                            isSingle ? 'h-full min-h-0 min-w-0' : 'aspect-square'
                                                          )}
                                                          narrowContent={
                                                            <>
                                                              {!liveDownload && (
                                                                <Button
                                                                  type="button"
                                                                  variant="outline"
                                                                  size="icon"
                                                                  className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                  onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                  disabled={stateLabel !== 'Available'}
                                                                  aria-label="Download"
                                                                >
                                                                  {stateLabel === 'Available' ? (
                                                                    <Download className="h-3.5 w-3.5" />
                                                                  ) : (
                                                                    <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                  )}
                                                                </Button>
                                                              )}
                                                              <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                              <span className="text-[9px] text-muted-foreground shrink-0">
                                                                {formatBytes(att.size_bytes)}
                                                              </span>
                                                              {stateLabel === 'Unavailable' && (
                                                                <span className="flex flex-col items-center justify-center gap-0.5">
                                                                  <span className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                    <CloudOff className="h-3 w-3 shrink-0" />
                                                                    Not available
                                                                  </span>
                                                                  {unavailableReasonFor(att) && (
                                                                    <span className="text-[8px] text-muted-foreground/90">
                                                                      {unavailableReasonFor(att)}
                                                                    </span>
                                                                  )}
                                                                </span>
                                                              )}
                                                              {showDownloadProgress && (
                                                                <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                  <div
                                                                    className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                    style={{ width: `${Math.max(2, downloadProgress)}%` }}
                                                                  />
                                                                </div>
                                                              )}
                                                            </>
                                                          }
                                                          wideContent={
                                                            <>
                                                              {!liveDownload && (
                                                                <Button
                                                                  type="button"
                                                                  variant="outline"
                                                                  size="icon"
                                                                  className="absolute top-1.5 right-1.5 h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                  onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                  disabled={stateLabel !== 'Available'}
                                                                  aria-label="Download"
                                                                >
                                                                  {stateLabel === 'Available' ? (
                                                                    <Download className="h-3.5 w-3.5" />
                                                                  ) : (
                                                                    <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                  )}
                                                                </Button>
                                                              )}
                                                              {stateLabel === 'Unavailable' ? (
                                                                <ImageOff className="h-8 w-8 shrink-0 text-muted-foreground" aria-hidden />
                                                              ) : category === 'video' ? (
                                                                <ImageDownPlay className="h-8 w-8 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                                              ) : (
                                                                <ImageDown className="h-8 w-8 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                                              )}
                                                              <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                              <span className="text-[9px] text-muted-foreground shrink-0">
                                                                {formatBytes(att.size_bytes)}
                                                              </span>
                                                              {stateLabel === 'Unavailable' && (
                                                                <span className="flex flex-col items-center justify-center gap-0.5">
                                                                  <span className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                    <CloudOff className="h-3 w-3 shrink-0" />
                                                                    Not available
                                                                  </span>
                                                                  {unavailableReasonFor(att) && (
                                                                    <span className="text-[8px] text-muted-foreground/90">
                                                                      {unavailableReasonFor(att)}
                                                                    </span>
                                                                  )}
                                                                </span>
                                                              )}
                                                              {showDownloadProgress && (
                                                                <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                  <div
                                                                    className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                    style={{ width: `${Math.max(2, downloadProgress)}%` }}
                                                                  />
                                                                </div>
                                                              )}
                                                            </>
                                                          }
                                                        />
                                                      ) : isMedia && hasPath ? (
                                                        category === 'image' ? (
                                                          <div className={cn('relative', isSingle && 'w-full h-full min-h-0')}>
                                                            <button
                                                              type="button"
                                                              className={cn('block w-full focus:outline-none', isSingle && 'h-full min-h-0')}
                                                              onClick={() =>
                                                                setMediaPreview({
                                                                  type: 'image',
                                                                  url: convertFileSrc(hasPath),
                                                                  fileName: att.file_name,
                                                                })
                                                              }
                                                            >
                                                              <ChatMediaSlot
                                                                fillParent={isSingle}
                                                                aspectClass={!isSingle ? 'aspect-square' : undefined}
                                                              >
                                                                <img
                                                                  src={convertFileSrc(hasPath)}
                                                                  alt=""
                                                                  loading="lazy"
                                                                  className="object-cover"
                                                                  onLoad={onImageLoad}
                                                                />
                                                              </ChatMediaSlot>
                                                            </button>
                                                            {isOwn && msg.delivery_status !== 'bundling' && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !hasActiveUploadForAttachment(att) && !justSharedKeys.has(`att:${att.attachment_id}`) && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share again">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation()
                                                                      handleShareAgainAttachment(att, true, hasPath)
                                                                    }}
                                                                  >
                                                                    <Upload className="h-4 w-4" />
                                                                  </Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                            {!isOwn && hasPath && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share in this chat">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation()
                                                                      handleShareAgainAttachment(att, false, hasPath)
                                                                    }}
                                                                  >
                                                                    <Upload className="h-4 w-4" />
                                                                  </Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                          </div>
                                                        ) : (
                                                          <div className={cn('relative', isSingle && 'w-full h-full min-h-0')}>
                                                            {isSingle && inlinePlayingVideoId === att.attachment_id ? (
                                                              <div
                                                                ref={(el) => {
                                                                  videoScrollTargetsRef.current[`${msg.id}-${att.attachment_id}`] = el
                                                                }}
                                                                className={cn(
                                                                  'relative overflow-hidden rounded-lg bg-black w-full',
                                                                  isSingle ? 'h-full min-h-0 max-h-[min(70vh,24rem)]' : 'aspect-square'
                                                                )}
                                                                style={isSingle ? { aspectRatio: mixedSingleRatio } : undefined}
                                                                onMouseEnter={() => setInlineVideoShowControls(true)}
                                                                onMouseLeave={() => setInlineVideoShowControls(false)}
                                                              >
                                                                <CustomVideoPlayer
                                                                  src={convertFileSrc(hasPath)}
                                                                  showControls={inlineVideoShowControls}
                                                                  keepControlsWhenPaused
                                                                  autoPlay
                                                                  getScrollTarget={() => videoScrollTargetsRef.current[`${msg.id}-${att.attachment_id}`] ?? null}
                                                                  onAspectRatio={onVideoAspect}
                                                                  className={cn('w-full h-full rounded-lg', isSingle ? 'object-contain' : 'object-cover')}
                                                                />
                                                              </div>
                                                            ) : (
                                                              <button
                                                                type="button"
                                                                className={cn('relative block w-full focus:outline-none group', isSingle && 'h-full min-h-0')}
                                                                onClick={() => {
                                                                  if (isSingle) {
                                                                    setInlinePlayingVideoId(att.attachment_id)
                                                                  } else {
                                                                    setMediaPreview({
                                                                      type: 'video',
                                                                      url: convertFileSrc(hasPath),
                                                                      fileName: att.file_name,
                                                                    })
                                                                  }
                                                                }}
                                                              >
                                                                <ChatMediaSlot
                                                                  fillParent={isSingle}
                                                                  aspectClass={!isSingle ? 'aspect-square' : undefined}
                                                                >
                                                                  {thumbPath ? (
                                                                    <img
                                                                      src={convertFileSrc(thumbPath)}
                                                                      alt=""
                                                                      loading="lazy"
                                                                      className="object-cover"
                                                                    />
                                                                  ) : (
                                                                    <video
                                                                      src={convertFileSrc(hasPath)}
                                                                      className="object-cover"
                                                                      muted
                                                                      playsInline
                                                                      preload="auto"
                                                                      onLoadedMetadata={onVideoMetadata}
                                                                    />
                                                                  )}
                                                                  {isSingle && category === 'video' && hasPath ? (
                                                                    <video
                                                                      src={convertFileSrc(hasPath)}
                                                                      className="!absolute !w-0 !h-0 !opacity-0 !pointer-events-none !min-w-0 !min-h-0"
                                                                      muted
                                                                      playsInline
                                                                      preload="metadata"
                                                                      onLoadedMetadata={onVideoMetadata}
                                                                    />
                                                                  ) : null}
                                                                </ChatMediaSlot>
                                                                <span className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 pointer-events-none rounded-lg">
                                                                  <span className="w-10 h-10 rounded-md bg-black/50 flex items-center justify-center">
                                                                    <Play className="h-5 w-5 text-white fill-white" />
                                                                  </span>
                                                                </span>
                                                              </button>
                                                            )}
                                                            {isOwn && msg.delivery_status !== 'bundling' && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !hasActiveUploadForAttachment(att) && !justSharedKeys.has(`att:${att.attachment_id}`) && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share again">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation()
                                                                      handleShareAgainAttachment(att, true, hasPath)
                                                                    }}
                                                                  >
                                                                    <Upload className="h-4 w-4" />
                                                                  </Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                            {!isOwn && hasPath && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share in this chat">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation()
                                                                      handleShareAgainAttachment(att, false, hasPath)
                                                                    }}
                                                                  >
                                                                    <Upload className="h-4 w-4" />
                                                                  </Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                          </div>
                                                        )
                                                      ) : null}
                                                      {!notDownloaded && (
                                                        isSingle && category === 'video' ? (
                                                          <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none pt-2 pb-8 px-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b from-black/80 via-black/50 to-transparent" aria-hidden>
                                                            <span className="text-[10px] text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                          </div>
                                                        ) : (
                                                          <div className="absolute inset-0 pointer-events-none flex items-end">
                                                            <div className="w-full bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-8 pb-1 px-1.5 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden>
                                                              <span className="text-[10px] text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                            </div>
                                                          </div>
                                                        )
                                                      )}
                                                            </div>
                                                          )
                                                        }}
                                                      </ChatSingleMediaAspect>
                                                    )
                                                  }
                                                  return (
                                                    <div
                                                      key={att.attachment_id}
                                                      className={cn(
                                                        'group relative rounded-lg overflow-hidden border border-border/50',
                                                        notDownloaded ? 'bg-muted' : 'bg-muted/30',
                                                        'aspect-square'
                                                      )}
                                                    >
                                                      {notDownloaded ? (
                                                        <NotDownloadedCardByWidth
                                                          threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                          className="relative w-full flex flex-col items-center justify-center gap-1.5 p-2 bg-muted rounded-lg border border-border/50 transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110 aspect-square"
                                                          narrowContent={
                                                            <>
                                                              {!liveDownload && (
                                                                <Button type="button" variant="outline" size="icon" className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)} disabled={stateLabel !== 'Available'} aria-label="Download">
                                                                  {stateLabel === 'Available' ? <Download className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" aria-hidden />}
                                                                </Button>
                                                              )}
                                                              <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                              <span className="text-[9px] text-muted-foreground shrink-0">{formatBytes(att.size_bytes)}</span>
                                                              {showDownloadProgress && (
                                                                <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                  <div className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')} style={{ width: `${Math.max(2, downloadProgress)}%` }} />
                                                                </div>
                                                              )}
                                                            </>
                                                          }
                                                          wideContent={
                                                            <>
                                                              {!liveDownload && (
                                                                <Button type="button" variant="outline" size="icon" className="absolute top-1.5 right-1.5 h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)} disabled={stateLabel !== 'Available'} aria-label="Download">
                                                                  {stateLabel === 'Available' ? <Download className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" aria-hidden />}
                                                                </Button>
                                                              )}
                                                              {stateLabel === 'Unavailable' ? <ImageOff className="h-8 w-8 shrink-0 text-muted-foreground" aria-hidden /> : category === 'video' ? <ImageDownPlay className="h-8 w-8 shrink-0 text-muted-foreground" strokeWidth={1.5} /> : <ImageDown className="h-8 w-8 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
                                                              <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                              <span className="text-[9px] text-muted-foreground shrink-0">{formatBytes(att.size_bytes)}</span>
                                                              {showDownloadProgress && (
                                                                <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                  <div className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')} style={{ width: `${Math.max(2, downloadProgress)}%` }} />
                                                                </div>
                                                              )}
                                                            </>
                                                          }
                                                        />
                                                      ) : isMedia && hasPath ? (
                                                        category === 'image' ? (
                                                          <div className="relative w-full h-full min-h-0">
                                                            <button type="button" className="block w-full h-full min-h-0 focus:outline-none" onClick={() => setMediaPreview({ type: 'image', url: convertFileSrc(hasPath), fileName: att.file_name })}>
                                                              <ChatMediaSlot fillParent aspectClass="aspect-square">
                                                                <img src={convertFileSrc(hasPath)} alt="" loading="lazy" className="object-cover" />
                                                              </ChatMediaSlot>
                                                            </button>
                                                            {isOwn && msg.delivery_status !== 'bundling' && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !hasActiveUploadForAttachment(att) && !justSharedKeys.has(`att:${att.attachment_id}`) && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share again">
                                                                  <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={(e) => { e.stopPropagation(); handleShareAgainAttachment(att, true, hasPath) }}><Upload className="h-4 w-4" /></Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                            {!isOwn && hasPath && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share in this chat">
                                                                  <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={(e) => { e.stopPropagation(); handleShareAgainAttachment(att, false, hasPath) }}><Upload className="h-4 w-4" /></Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                          </div>
                                                        ) : (
                                                          <div className="relative w-full h-full min-h-0">
                                                            <button type="button" className="relative block w-full h-full min-h-0 focus:outline-none group" onClick={() => setMediaPreview({ type: 'video', url: convertFileSrc(hasPath), fileName: att.file_name })}>
                                                              <ChatMediaSlot fillParent aspectClass="aspect-square">
                                                                {thumbPath ? (
                                                                  <img src={convertFileSrc(thumbPath)} alt="" loading="lazy" className="object-cover" />
                                                                ) : (
                                                                  <video src={convertFileSrc(hasPath)} className="object-cover" muted playsInline preload="auto" />
                                                                )}
                                                              </ChatMediaSlot>
                                                              <span className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 pointer-events-none rounded-lg">
                                                                <span className="w-10 h-10 rounded-md bg-black/50 flex items-center justify-center">
                                                                  <Play className="h-5 w-5 text-white fill-white" />
                                                                </span>
                                                              </span>
                                                            </button>
                                                            {isOwn && msg.delivery_status !== 'bundling' && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !hasActiveUploadForAttachment(att) && !justSharedKeys.has(`att:${att.attachment_id}`) && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share again">
                                                                  <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={(e) => { e.stopPropagation(); handleShareAgainAttachment(att, true, hasPath) }}><Upload className="h-4 w-4" /></Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                            {!isOwn && hasPath && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share in this chat">
                                                                  <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={(e) => { e.stopPropagation(); handleShareAgainAttachment(att, false, hasPath) }}><Upload className="h-4 w-4" /></Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                          </div>
                                                        )
                                                      ) : null}
                                                    </div>
                                                  )
                                                })}
                                              </div>
                                              ) : null}
                                              {otherAttachments.length > 0 && (
                                                <div className="flex flex-col gap-1 max-w-[min(100%,28rem)]">
                                                  {otherAttachments.map((att) => {
                                                    const isOwn = msg.from_user_id === identity?.user_id
                                                    const {
                                                      hasPath,
                                                      notDownloaded,
                                                      liveDownload,
                                                      downloadProgress,
                                                      showDownloadProgress,
                                                    } = buildAttachmentTransferPresentation({
                                                      att,
                                                      isOwn,
                                                      attachmentTransferRows,
                                                      transferHistory,
                                                      sharedAttachments,
                                                      unsharedAttachmentRecords,
                                                      hasAccessibleCompletedDownload,
                                                      getCachedPathForSha,
                                                    })
                                                    const stateLabel = attachmentStateLabelFor(att)
                                                    const category = getFileTypeFromExt(att.file_name) as Parameters<typeof IconForCategory>[0]['cat']
                                                    return (
                                                      <div
                                                        key={att.attachment_id}
                                                        className={cn(
                                                          'group relative rounded-lg overflow-hidden border border-border/50',
                                                          notDownloaded ? 'bg-muted' : 'bg-muted/30'
                                                        )}
                                                      >
                                                        {notDownloaded ? (
                                                          <NotDownloadedCardByWidth
                                                            threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                            className="relative w-full flex flex-col items-center justify-center gap-1.5 bg-muted transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110 min-h-[56px]"
                                                            narrowContent={
                                                              <>
                                                                {!liveDownload && (
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                    disabled={stateLabel !== 'Available'}
                                                                    aria-label="Download"
                                                                  >
                                                                    {stateLabel === 'Available' ? (
                                                                      <Download className="h-3.5 w-3.5" />
                                                                    ) : (
                                                                      <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                    )}
                                                                  </Button>
                                                                )}
                                                                <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                                <span className="text-[9px] text-muted-foreground shrink-0">{formatBytes(att.size_bytes)}</span>
                                                                {stateLabel === 'Unavailable' && (
                                                                  <span className="flex flex-col items-center justify-center gap-0.5">
                                                                    <span className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                      <CloudOff className="h-3 w-3 shrink-0" />
                                                                      Not available
                                                                    </span>
                                                                    {unavailableReasonFor(att) && (
                                                                      <span className="text-[8px] text-muted-foreground/90">{unavailableReasonFor(att)}</span>
                                                                    )}
                                                                  </span>
                                                                )}
                                                                {showDownloadProgress && (
                                                                  <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                    <div
                                                                      className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                      style={{ width: `${Math.max(2, downloadProgress)}%` }}
                                                                    />
                                                                  </div>
                                                                )}
                                                              </>
                                                            }
                                                            wideContent={
                                                              <>
                                                                <ChatFileRowSlot
                                                                  icon={<IconForCategory cat={category} className="text-muted-foreground" />}
                                                                  title={att.file_name}
                                                                  size={formatBytes(att.size_bytes)}
                                                                >
                                                                  <div className="flex flex-col items-end gap-1 shrink-0">
                                                                    {!liveDownload && (
                                                                      <Button
                                                                        type="button"
                                                                        variant="outline"
                                                                        size="icon"
                                                                        className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                        onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                        disabled={stateLabel !== 'Available'}
                                                                        aria-label="Download"
                                                                      >
                                                                        {stateLabel === 'Available' ? (
                                                                          <Download className="h-3.5 w-3.5" />
                                                                        ) : (
                                                                          <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                        )}
                                                                      </Button>
                                                                    )}
                                                                    {stateLabel === 'Unavailable' && (
                                                                      <span className="text-[9px] text-muted-foreground text-right">Not available</span>
                                                                    )}
                                                                    {showDownloadProgress && (
                                                                      <div className="w-24 h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                        <div
                                                                          className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                          style={{ width: `${Math.max(2, downloadProgress)}%` }}
                                                                        />
                                                                      </div>
                                                                    )}
                                                                  </div>
                                                                </ChatFileRowSlot>
                                                              </>
                                                            }
                                                          />
                                                        ) : (
                                                          <div className="relative">
                                                            <ChatFileRowSlot
                                                              className="border border-border/50"
                                                              icon={<IconForCategory cat={category} className="text-muted-foreground" />}
                                                              title={att.file_name}
                                                              size={formatBytes(att.size_bytes)}
                                                            >
                                                              {isOwn && msg.delivery_status !== 'bundling' && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !hasActiveUploadForAttachment(att) && !justSharedKeys.has(`att:${att.attachment_id}`) && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                                <span className="shrink-0">
                                                                  <Tooltip content="Share again">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, true, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                              {!isOwn && hasPath && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                                <span className="shrink-0">
                                                                  <Tooltip content="Share in this chat">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, false, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                            </ChatFileRowSlot>
                                                          </div>
                                                        )}
                                                      </div>
                                                    )
                                                  })}
                                                </div>
                                              )}
                                              </>
                                                )
                                              })()}
                                              {msg.text ? (
                                                <p className="text-sm whitespace-pre-wrap break-words max-w-[min(100%,36rem)]">{msg.text}</p>
                                              ) : null}
                                            </div>
                                          ) : msg.kind === 'attachment' && msg.attachment ? (
                                            <div className="pt-1">
                                              <div
                                                className={cn(
                                                  'relative rounded-lg transition-all',
                                                  msg.attachment.spoiler && !revealedSpoilerIds.has(msg.id) && 'overflow-hidden'
                                                )}
                                              >
                                                {msg.attachment.spoiler && !revealedSpoilerIds.has(msg.id) ? (
                                                  <button
                                                    type="button"
                                                    onClick={() =>
                                                      setRevealedSpoilerIds((prev) => new Set(prev).add(msg.id))
                                                    }
                                                    className="w-full py-4 px-4 bg-muted/80 hover:bg-muted rounded-lg text-center"
                                                  >
                                                    <EyeOff className="h-5 w-5 mx-auto mb-1.5 text-muted-foreground" />
                                                    <span className="text-xs text-muted-foreground block">
                                                      Spoiler • Click to reveal
                                                    </span>
                                                  </button>
                                                ) : (() => {
                                                  const att = msg.attachment!
                                                  const isOwn = msg.from_user_id === identity?.user_id
                                                  const {
                                                    sharedItem,
                                                    hasPath,
                                                    thumbPath,
                                                    notDownloaded,
                                                    liveDownload,
                                                  } = buildAttachmentTransferPresentation({
                                                    att,
                                                    isOwn,
                                                    attachmentTransferRows,
                                                    transferHistory,
                                                    sharedAttachments,
                                                    unsharedAttachmentRecords,
                                                    hasAccessibleCompletedDownload,
                                                    getCachedPathForSha,
                                                  })
                                                  const previewImagePath = (thumbPath ?? hasPath)!
                                                  const category = getFileTypeFromExt(att.file_name)
                                                  const isMedia = isMediaType(category as Parameters<typeof isMediaType>[0])
                                                  const mediaPreviewPath = category === 'video'
                                                    ? (thumbPath || hasPath)
                                                    : (hasPath || thumbPath)
                                                  const p = liveDownload ? Math.max(0, Math.min(100, Math.round((liveDownload.progress ?? 0) * 100))) : 0
                                                  const showProgress = !!liveDownload && (liveDownload.status === 'transferring' || liveDownload.status === 'completed')
                                                  if (isMedia) {
                                                    return (
                                                      <ChatSingleMediaAspect
                                                        msgId={msg.id}
                                                        attachmentId={att.attachment_id}
                                                        att={att}
                                                        isSingle
                                                        signingPubkey={server?.signing_pubkey ?? ''}
                                                        chatId={groupChat?.id ?? ''}
                                                        updateAttachmentAspect={updateAttachmentAspect}
                                                      >
                                                        {({ aspect, onImageLoad, onVideoMetadata, onVideoAspect }) => {
                                                          const singleAspectRatio = getSingleAttachmentAspectRatio(aspect)
                                                          const { w: singleW } = getSingleAttachmentSize(aspect, CHAT_MEDIA_MAX_W, CHAT_MEDIA_MAX_H)
                                                          return (
                                                      <div className="space-y-1 w-full min-w-0">
                                                        <div
                                                          className={cn(
                                                            'relative rounded-lg overflow-hidden border border-border/50 w-full min-w-0',
                                                            notDownloaded && 'bg-muted'
                                                          )}
                                                          style={{
                                                            width: '100%',
                                                            minWidth: CHAT_MEDIA_MIN_W,
                                                            maxWidth: singleW,
                                                            aspectRatio: singleAspectRatio,
                                                          }}
                                                        >
                                                          {notDownloaded ? (
                                                            <NotDownloadedCardByWidth
                                                              threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                              className="relative w-full h-full min-h-0 min-w-0 flex flex-col items-center justify-center gap-2 p-4 bg-muted rounded-lg transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110"
                                                              narrowContent={
                                                                <>
                                                                  {!liveDownload && (
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={() => attachmentStateLabel === 'Available' && requestAttachmentDownload(msg)}
                                                                      disabled={attachmentStateLabel !== 'Available'}
                                                                      aria-label="Download"
                                                                    >
                                                                      {attachmentStateLabel === 'Available' ? (
                                                                        <Download className="h-4 w-4" />
                                                                      ) : (
                                                                        <Ban className="h-4 w-4" aria-hidden />
                                                                      )}
                                                                    </Button>
                                                                  )}
                                                                  <FilenameEllipsis name={att.file_name} className="text-xs text-foreground truncate max-w-full text-center block" title={att.file_name} />
                                                                  <span className="text-[10px] text-muted-foreground shrink-0">
                                                                    {formatBytes(att.size_bytes)}
                                                                    {att.extension ? ` .${att.extension}` : ''}
                                                                  </span>
                                                                  {attachmentStateLabel === 'Unavailable' && (
                                                                    <span className="flex flex-col items-center justify-center gap-0.5">
                                                                      <span className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                        <CloudOff className="h-3.5 w-3.5 shrink-0" />
                                                                        Not available
                                                                      </span>
                                                                      {unavailableReasonFor(att) && (
                                                                        <span className="text-[9px] text-muted-foreground/90">
                                                                          {unavailableReasonFor(att)}
                                                                        </span>
                                                                      )}
                                                                    </span>
                                                                  )}
                                                                  {showProgress && (
                                                                    <div className="w-full max-w-[200px] h-1.5 bg-foreground/15 overflow-hidden rounded-full">
                                                                      <div
                                                                        className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                        style={{ width: `${Math.max(2, p)}%` }}
                                                                      />
                                                                    </div>
                                                                  )}
                                                                </>
                                                              }
                                                              wideContent={
                                                                <>
                                                                  {!liveDownload && (
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="absolute top-2 right-2 h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={() => attachmentStateLabel === 'Available' && requestAttachmentDownload(msg)}
                                                                      disabled={attachmentStateLabel !== 'Available'}
                                                                      aria-label="Download"
                                                                    >
                                                                      {attachmentStateLabel === 'Available' ? (
                                                                        <Download className="h-4 w-4" />
                                                                      ) : (
                                                                        <Ban className="h-4 w-4" aria-hidden />
                                                                      )}
                                                                    </Button>
                                                                  )}
                                                                  {attachmentStateLabel === 'Unavailable' ? (
                                                                    <ImageOff className="h-12 w-12 shrink-0 text-muted-foreground" aria-hidden />
                                                                  ) : (getFileTypeFromExt(att.file_name) === 'video') ? (
                                                                    <ImageDownPlay className="h-12 w-12 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                                                  ) : (
                                                                    <ImageDown className="h-12 w-12 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                                                  )}
                                                                  <FilenameEllipsis name={att.file_name} className="text-xs text-foreground truncate max-w-full text-center block" title={att.file_name} />
                                                                  <span className="text-[10px] text-muted-foreground shrink-0">
                                                                    {formatBytes(att.size_bytes)}
                                                                    {att.extension ? ` .${att.extension}` : ''}
                                                                  </span>
                                                                  {attachmentStateLabel === 'Unavailable' && (
                                                                    <span className="flex flex-col items-center justify-center gap-0.5">
                                                                      <span className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                        <CloudOff className="h-3.5 w-3.5 shrink-0" />
                                                                        Not available
                                                                      </span>
                                                                      {unavailableReasonFor(att) && (
                                                                        <span className="text-[9px] text-muted-foreground/90">
                                                                          {unavailableReasonFor(att)}
                                                                        </span>
                                                                      )}
                                                                    </span>
                                                                  )}
                                                                  {showProgress && (
                                                                    <div className="w-full max-w-[200px] h-1.5 bg-foreground/15 overflow-hidden rounded-full">
                                                                      <div
                                                                        className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                        style={{ width: `${Math.max(2, p)}%` }}
                                                                      />
                                                                    </div>
                                                                  )}
                                                                </>
                                                              }
                                                            />
                                                          ) : category === 'image' && hasPath ? (
                                                            <div className="relative w-full h-full min-h-0">
                                                              <button
                                                                type="button"
                                                                className="group relative block w-full h-full focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background rounded-lg overflow-hidden min-h-0"
                                                                onClick={() =>
                                                                  setMediaPreview({
                                                                    type: 'image',
                                                                    url: convertFileSrc(hasPath),
                                                                    fileName: att.file_name,
                                                                  })
                                                                }
                                                              >
                                                                <ChatMediaSlot fillParent>
                                                                  <img
                                                                    src={convertFileSrc(previewImagePath)}
                                                                    alt=""
                                                                    loading="lazy"
                                                                    decoding="async"
                                                                    className="object-cover"
                                                                    onLoad={onImageLoad}
                                                                    onError={() => {
                                                                      // no-op: image fallback is handled by parent media slot
                                                                    }}
                                                                  />
                                                                </ChatMediaSlot>
                                                                <div className="absolute inset-0 pointer-events-none flex items-end">
                                                                  <div className="w-full bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-12 pb-2 px-2 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden>
                                                                    <span className="text-xs text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                                  </div>
                                                                </div>
                                                              </button>
                                                              {isOwn && msg.delivery_status !== 'bundling' && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !hasActiveUploadForAttachment(att) && !justSharedKeys.has(`att:${att.attachment_id}`) && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                                <span className="absolute top-2 right-2 z-20">
                                                                  <Tooltip content="Share again">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, true, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-4 w-4" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                              {!isOwn && hasPath && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                                <span className="absolute top-2 right-2 z-20">
                                                                  <Tooltip content="Share in this chat">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, false, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-4 w-4" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                            </div>
                                                          ) : category === 'video' && hasPath ? (
                                                            <div className="relative">
                                                              {inlinePlayingVideoId === att.attachment_id ? (
                                                                <div
                                                                  ref={(el) => {
                                                                    videoScrollTargetsRef.current[`${msg.id}-${att.attachment_id}`] = el
                                                                  }}
                                                                  className="group relative overflow-hidden rounded-lg bg-black w-full h-full min-h-0"
                                                                  onMouseEnter={() => setInlineVideoShowControls(true)}
                                                                  onMouseLeave={() => setInlineVideoShowControls(false)}
                                                                >
                                                                  <CustomVideoPlayer
                                                                    src={convertFileSrc(hasPath)}
                                                                    showControls={inlineVideoShowControls}
                                                                    keepControlsWhenPaused
                                                                    autoPlay
                                                                    getScrollTarget={() => videoScrollTargetsRef.current[`${msg.id}-${att.attachment_id}`] ?? null}
                                                                    onAspectRatio={onVideoAspect}
                                                                    className="w-full h-full object-contain rounded-lg"
                                                                  />
                                                                  <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none pt-2 pb-10 px-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b from-black/80 via-black/50 to-transparent" aria-hidden>
                                                                    <span className="text-xs text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                                  </div>
                                                                </div>
                                                              ) : (
                                                                <button
                                                                  type="button"
                                                                  className="group relative block w-full h-full min-h-0 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background rounded-lg overflow-hidden"
                                                                  onClick={() => setInlinePlayingVideoId(att.attachment_id)}
                                                                >
                                                                  <ChatMediaSlot fillParent>
                                                                    {thumbPath ? (
                                                                      <>
                                                                        <img
                                                                          src={convertFileSrc(thumbPath)}
                                                                          alt=""
                                                                          loading="lazy"
                                                                          className="object-cover"
                                                                        />
                                                                        {category === 'video' && hasPath ? (
                                                                          <video
                                                                            src={convertFileSrc(hasPath)}
                                                                            className="!absolute !w-0 !h-0 !opacity-0 !pointer-events-none !min-w-0 !min-h-0"
                                                                            muted
                                                                            playsInline
                                                                            preload="metadata"
                                                                            onLoadedMetadata={onVideoMetadata}
                                                                            onError={() => {
                                                                              // no-op: metadata probe failures are tolerated
                                                                            }}
                                                                          />
                                                                        ) : null}
                                                                      </>
                                                                    ) : (
                                                                      <video
                                                                        src={convertFileSrc(hasPath)}
                                                                        className="object-cover"
                                                                        muted
                                                                        playsInline
                                                                        preload="metadata"
                                                                        onLoadedMetadata={onVideoMetadata}
                                                                        onError={() => {
                                                                          // no-op: render fallback handled elsewhere
                                                                        }}
                                                                      />
                                                                    )}
                                                                  </ChatMediaSlot>
                                                                  <span className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors pointer-events-none">
                                                                    <span className="w-10 h-10 rounded-md bg-black/50 flex items-center justify-center">
                                                                      <Play className="h-5 w-5 text-white fill-white" />
                                                                    </span>
                                                                  </span>
                                                                  <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none pt-2 pb-10 px-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b from-black/80 via-black/50 to-transparent" aria-hidden>
                                                                    <span className="text-xs text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                                  </div>
                                                                </button>
                                                              )}
                                                              {isOwn && msg.delivery_status !== 'bundling' && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !hasActiveUploadForAttachment(att) && !justSharedKeys.has(`att:${att.attachment_id}`) && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                                <span className="absolute top-2 right-2 z-20">
                                                                  <Tooltip content="Share again">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, true, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-4 w-4" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                              {!isOwn && hasPath && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                                <span className="absolute top-2 right-2 z-20">
                                                                  <Tooltip content="Share in this chat">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, false, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-4 w-4" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                            </div>
                                                          ) : (
                                                            <FileIcon
                                                              fileName={att.file_name}
                                                              attachmentId={!hasPath && (isOwn ? sharedItem?.can_share_now : false) ? att.attachment_id : null}
                                                              savedPath={hasPath ?? undefined}
                                                              thumbnailPath={thumbPath ?? undefined}
                                                              onMediaClick={(url, type, attachmentId, fileName) => {
                                                                setMediaPreview({
                                                                  type: type as 'image' | 'video',
                                                                  url: url ?? (attachmentId ? null : mediaPreviewPath ? convertFileSrc(mediaPreviewPath) : null),
                                                                  attachmentId,
                                                                  fileName: fileName ?? att.file_name,
                                                                })
                                                              }}
                                                              boxSize={120}
                                                            />
                                                          )}
                                                        </div>
                                                        {showProgress && (
                                                          <div className="h-1 bg-foreground/15 overflow-hidden rounded-full max-w-[280px]">
                                                            <div
                                                              className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                              style={{ width: `${Math.max(2, p)}%` }}
                                                            />
                                                          </div>
                                                        )}
                                                        {liveDownload?.status === 'completed' && liveDownload.saved_path && (
                                                          <span className="block text-[9px] text-muted-foreground truncate" title={liveDownload.saved_path}>
                                                            Saved
                                                          </span>
                                                        )}
                                                      </div>
                                                          )
                                                        }}
                                                      </ChatSingleMediaAspect>
                                                    )
                                                  }
                                                  const fileCategory = getFileTypeFromExt(att.file_name) as Parameters<typeof IconForCategory>[0]['cat']
                                                    return (
                                                      <div
                                                        className={cn(
                                                          'group relative rounded-lg overflow-hidden border border-border/50 max-w-[min(100%,28rem)]',
                                                          notDownloaded ? 'bg-muted' : 'bg-muted/30'
                                                        )}
                                                      >
                                                        {notDownloaded ? (
                                                          <NotDownloadedCardByWidth
                                                            threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                            className="relative w-full flex flex-col items-center justify-center gap-1.5 bg-muted rounded-lg transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110 min-h-[56px]"
                                                            narrowContent={
                                                              <>
                                                                <Button
                                                                  type="button"
                                                                  variant="outline"
                                                                  size="icon"
                                                                  className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                  onClick={() => attachmentStateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                  disabled={attachmentStateLabel !== 'Available'}
                                                                  aria-label="Download"
                                                                >
                                                                  {attachmentStateLabel === 'Available' ? (
                                                                    <Download className="h-3.5 w-3.5" />
                                                                  ) : (
                                                                    <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                  )}
                                                                </Button>
                                                                <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                                <span className="text-[9px] text-muted-foreground shrink-0">{formatBytes(att.size_bytes)}</span>
                                                                {attachmentStateLabel === 'Unavailable' && (
                                                                  <span className="flex flex-col items-center justify-center gap-0.5">
                                                                    <span className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                      <CloudOff className="h-3 w-3 shrink-0" />
                                                                      Not available
                                                                    </span>
                                                                    {unavailableReasonFor(att) && (
                                                                      <span className="text-[8px] text-muted-foreground/90">{unavailableReasonFor(att)}</span>
                                                                    )}
                                                                  </span>
                                                                )}
                                                                {showProgress && (
                                                                  <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                    <div
                                                                      className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                      style={{ width: `${Math.max(2, p)}%` }}
                                                                    />
                                                                  </div>
                                                                )}
                                                              </>
                                                            }
                                                            wideContent={
                                                              <ChatFileRowSlot
                                                                icon={<IconForCategory cat={fileCategory} className="text-muted-foreground" />}
                                                                title={att.file_name}
                                                                size={formatBytes(att.size_bytes)}
                                                              >
                                                                <div className="flex flex-col items-end gap-1 shrink-0">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={() => attachmentStateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                    disabled={attachmentStateLabel !== 'Available'}
                                                                    aria-label="Download"
                                                                  >
                                                                    {attachmentStateLabel === 'Available' ? (
                                                                      <Download className="h-3.5 w-3.5" />
                                                                    ) : (
                                                                      <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                    )}
                                                                  </Button>
                                                                  {attachmentStateLabel === 'Unavailable' && (
                                                                    <span className="text-[9px] text-muted-foreground text-right">Not available</span>
                                                                  )}
                                                                  {showProgress && (
                                                                    <div className="w-24 h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                      <div
                                                                        className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                        style={{ width: `${Math.max(2, p)}%` }}
                                                                      />
                                                                    </div>
                                                                  )}
                                                                </div>
                                                              </ChatFileRowSlot>
                                                            }
                                                          />
                                                        ) : (
                                                          <div className="relative">
                                                            <ChatFileRowSlot
                                                              className="border border-border/50"
                                                              icon={<IconForCategory cat={fileCategory} className="text-muted-foreground" />}
                                                              title={att.file_name}
                                                              size={formatBytes(att.size_bytes)}
                                                            >
                                                              {isOwn && msg.delivery_status !== 'bundling' && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !hasActiveUploadForAttachment(att) && !justSharedKeys.has(`att:${att.attachment_id}`) && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                                <span className="shrink-0">
                                                                  <Tooltip content="Share again">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, true, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                              {!isOwn && hasPath && !isSharedInServer(server?.signing_pubkey ?? '', att.sha256 ?? '') && !justSharedKeys.has(`sha:${att.sha256 ?? ''}`) && (
                                                                <span className="shrink-0">
                                                                  <Tooltip content="Share in this chat">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, false, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                            </ChatFileRowSlot>
                                                          </div>
                                                        )}
                                                      </div>
                                                    )
                                                })()}
                                              </div>
                                            </div>
                                          ) : (
                                            <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
                                          )}
    </>
  )
}
