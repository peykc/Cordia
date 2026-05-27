import { memo, useState } from 'react'
import { Plus, Play, Download, Ban, ImageDown, ImageOff, Upload } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Tooltip } from '../Tooltip'
import { ChatMediaSlot } from '../ChatMediaSlot'
import { NotDownloadedCardByWidth } from './NotDownloadedCardByWidth'
import { FilenameEllipsis } from '../FilenameEllipsis'
import { formatBytes } from '../../lib/bytes'
import { ImageDownPlay } from '../icons'
import { getFileTypeFromExt } from '../../lib/fileType'
import { ChatSingleMediaAspect } from '../ChatSingleMediaAspect'
import { CustomVideoPlayer } from '../CustomVideoPlayer'
import { getSingleAttachmentAspectRatio } from '../../lib/chatMessageLayout'
import type { EphemeralAttachmentMeta } from '../../domain/attachments/types'

const NOT_DOWNLOADED_CARD_NARROW_PX = 110

type Props = {
  attachments: EphemeralAttachmentMeta[]
  msg: any
  callbacks: any
  threshold?: number
}

function MediaAttachmentGridInner({
  attachments,
  msg,
  callbacks,
  threshold = 4,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const totalCount = attachments.length
  const hasMore = totalCount > threshold
  
  const visibleAttachments = expanded ? attachments : attachments.slice(0, threshold)
  const remainingCount = totalCount - threshold + 1 

  const {
      identity,
      getAttachmentPresentation,
      openAttachmentPreview,
      attachmentStateLabelFor,
      requestAttachmentDownload,
      handleShareAgainAttachment,
      shareInChatVisible,
  } = callbacks || {}

  const convertFileSrc = (path: string) => (window as any).__TAURI__?.tauri?.convertFileSrc(path) || path

  if (totalCount === 0) return null

  function imageTierPreviewPath(thumbPath: string | undefined, hasPath: string | undefined, count: number): string | undefined {
    if (!thumbPath) return hasPath
    const target = count >= 3 ? 480 : count === 2 ? 576 : 720
    const base = thumbPath.replace(/_(720|576|480)\.jpg$/i, '.jpg')
    const tiered = base.replace(/\.jpg$/i, `_${target}.jpg`)
    return tiered || thumbPath
  }

  const isSingle = totalCount === 1

  return (
    <div
      className={cn(
        'grid w-full max-w-full',
        isSingle && 'max-w-[min(100%,32rem)]',
        !isSingle && !expanded && totalCount === 2 && 'grid-cols-2 gap-0.5 max-w-[min(100%,32rem)]',
        !isSingle && !expanded && totalCount >= 3 && 'grid-cols-2 gap-0.5 max-w-[min(100%,32rem)]',
        expanded && 'grid-cols-3 gap-1.5 max-w-[min(100%,32rem)]'
      )}
    >
      {visibleAttachments.map((att, idx) => {
        const isOwn = msg.from_user_id === identity?.user_id
        const isLastInGrid = !expanded && hasMore && idx === threshold - 1
        const { hasPath, thumbPath, notDownloaded, liveDownload, downloadProgress, showDownloadProgress } = getAttachmentPresentation(att)
        const gridImagePath = imageTierPreviewPath(thumbPath, hasPath, totalCount)
        const category = getFileTypeFromExt(att.file_name)
        const stateLabel = attachmentStateLabelFor(att)

        return (
          <div key={att.attachment_id} className="relative group rounded-lg overflow-hidden border border-border/50">
            {notDownloaded ? (
                <NotDownloadedCardByWidth
                    threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                    className="relative w-full h-full min-h-[120px] flex flex-col items-center justify-center gap-1.5 bg-muted transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110"
                    narrowContent={
                        <>
                        {!liveDownload && (
                            <Button type="button" variant="outline" size="icon" className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)} disabled={stateLabel !== 'Available'} aria-label="Download">
                            {stateLabel === 'Available' ? <Download className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" aria-hidden />}
                            </Button>
                        )}
                        <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block px-2" title={att.file_name} />
                        <span className="text-[9px] text-muted-foreground shrink-0">{formatBytes(att.size_bytes)}</span>
                        {showDownloadProgress && (
                            <div className="w-full max-w-[80px] h-1 bg-foreground/15 overflow-hidden rounded-full">
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
                        {stateLabel === 'Unavailable' ? <ImageOff className="size-8 text-muted-foreground" /> : category === 'video' ? <ImageDownPlay className="size-8 text-muted-foreground" /> : <ImageDown className="size-8 text-muted-foreground" />}
                        <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block px-2" title={att.file_name} />
                        <span className="text-[9px] text-muted-foreground shrink-0">{formatBytes(att.size_bytes)}</span>
                        {showDownloadProgress && (
                            <div className="w-full max-w-[80px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                            <div className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')} style={{ width: `${Math.max(2, downloadProgress)}%` }} />
                            </div>
                        )}
                        </>
                    }
                />
            ) : category === 'image' && hasPath ? (
                <div className="relative w-full h-full min-h-0">
                    <ChatSingleMediaAspect
                        msgId={msg.id}
                        attachmentId={att.attachment_id}
                        att={att}
                        isSingle={isSingle}
                        signingPubkey={callbacks?.server?.signing_pubkey ?? ''}
                        chatId={callbacks?.groupChat?.id ?? ''}
                        updateAttachmentAspect={callbacks?.updateAttachmentAspect}
                    >
                        {({ aspect, onImageLoad }) => (
                            <button 
                                type="button" 
                                className="block w-full h-full min-h-0 focus:outline-none" 
                                onClick={() => openAttachmentPreview('image', convertFileSrc(hasPath), att, hasPath)}
                                style={isSingle ? { aspectRatio: getSingleAttachmentAspectRatio(aspect) } : undefined}
                            >
                                <ChatMediaSlot fillParent aspectClass={isSingle ? undefined : "aspect-square"}>
                                    <img
                                    src={convertFileSrc(gridImagePath || hasPath)}
                                    alt=""
                                    loading="lazy"
                                    decoding="async"
                                    className="object-cover"
                                    onLoad={onImageLoad}
                                    draggable={false}
                                    />
                                </ChatMediaSlot>
                            </button>
                        )}
                    </ChatSingleMediaAspect>
                    {shareInChatVisible(att, isOwn, hasPath) && (
                    <span className="absolute top-1.5 right-1.5 z-20">
                        <Tooltip content={isOwn ? "Share again" : "Share in this chat"}>
                        <Button type="button" variant="outline" size="icon" className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={(e) => { e.stopPropagation(); handleShareAgainAttachment(att, isOwn, hasPath) }}>
                            <Upload className="h-3.5 w-3.5" />
                        </Button>
                        </Tooltip>
                    </span>
                    )}
                </div>
            ) : category === 'video' && hasPath ? (
                <div className="relative w-full h-full min-h-0">
                    <ChatSingleMediaAspect
                        msgId={msg.id}
                        attachmentId={att.attachment_id}
                        att={att}
                        isSingle={isSingle}
                        signingPubkey={callbacks?.server?.signing_pubkey ?? ''}
                        chatId={callbacks?.groupChat?.id ?? ''}
                        updateAttachmentAspect={callbacks?.updateAttachmentAspect}
                    >
                        {({ aspect, onVideoMetadata, onVideoAspect }) => {
                            const showInline = isSingle && callbacks?.inlinePlayingVideoId === att.attachment_id
                            return (
                                <div className="space-y-1 w-full min-w-0">
                                    {showInline ? (
                                        <div 
                                            className="relative overflow-hidden rounded-lg bg-black w-full h-full min-h-0 max-h-[min(70vh,24rem)]"
                                            style={{ aspectRatio: getSingleAttachmentAspectRatio(aspect) }}
                                        >
                                            <CustomVideoPlayer
                                                src={convertFileSrc(hasPath)}
                                                autoPlay
                                                className="w-full h-full object-contain"
                                                onAspectRatio={onVideoAspect}
                                            />
                                        </div>
                                    ) : (
                                        <button 
                                            type="button" 
                                            className="relative block w-full h-full min-h-0 focus:outline-none group" 
                                            onClick={() => {
                                                if (isSingle) {
                                                    callbacks?.setInlinePlayingVideoId(att.attachment_id)
                                                } else {
                                                    openAttachmentPreview('video', convertFileSrc(hasPath), att, hasPath)
                                                }
                                            }}
                                            style={isSingle ? { aspectRatio: getSingleAttachmentAspectRatio(aspect) } : undefined}
                                        >
                                            <ChatMediaSlot fillParent aspectClass={isSingle ? undefined : "aspect-square"}>
                                                {thumbPath ? (
                                                <img src={convertFileSrc(thumbPath)} alt="" loading="lazy" className="object-cover" />
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
                                            </ChatMediaSlot>
                                            <span className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 pointer-events-none transition-colors">
                                                <span className="w-8 h-8 rounded-md bg-black/50 flex items-center justify-center">
                                                <Play className="h-4 w-4 text-white fill-white" />
                                                </span>
                                            </span>
                                        </button>
                                    )}
                                </div>
                            )
                        }}
                    </ChatSingleMediaAspect>
                    {shareInChatVisible(att, isOwn, hasPath) && (
                    <span className="absolute top-1.5 right-1.5 z-20">
                        <Tooltip content={isOwn ? "Share again" : "Share in this chat"}>
                        <Button type="button" variant="outline" size="icon" className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80" onClick={(e) => { e.stopPropagation(); handleShareAgainAttachment(att, isOwn, hasPath) }}>
                            <Upload className="h-3.5 w-3.5" />
                        </Button>
                        </Tooltip>
                    </span>
                    )}
                </div>
            ) : null}

            {isLastInGrid && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/60 hover:bg-black/50 transition-colors backdrop-blur-[2px] rounded-lg"
              >
                <Plus className="size-6 text-white mb-1" />
                <span className="text-sm font-bold text-white">{remainingCount} more</span>
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

export const MediaAttachmentGrid = memo(MediaAttachmentGridInner)
