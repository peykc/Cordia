import { memo, useState } from 'react'
import { ChevronDown, ChevronUp, Download, Ban, CloudOff } from 'lucide-react'
import { ChatMusicAttachmentCard } from '../ChatMusicAttachmentCard'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { formatBytes } from '../../lib/bytes'
import { NotDownloadedCardByWidth } from './NotDownloadedCardByWidth' // I should move this to a shared file too
import type { EphemeralAttachmentMeta } from '../../domain/attachments/types'

const NOT_DOWNLOADED_CARD_NARROW_PX = 110

type Props = {
  attachments: EphemeralAttachmentMeta[]
  msg: any
  callbacks: any
  threshold?: number
}

function AudioAttachmentGroupInner({
  attachments,
  msg,
  callbacks,
  threshold = 3,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const totalCount = attachments.length
  const hasMore = totalCount > threshold
  const visibleAttachments = expanded ? attachments : attachments.slice(0, threshold)
  const remainingCount = totalCount - threshold

  const {
      getAttachmentPresentation,
      openAudioPreview,
      attachmentStateLabelFor,
      requestAttachmentDownload,
      unavailableReasonFor,
  } = callbacks || {}

  const convertFileSrc = (path: string) => (window as any).__TAURI__?.tauri?.convertFileSrc(path) || path

  function musicCoverSrc(att: EphemeralAttachmentMeta, thumbPath: string | undefined): string | undefined {
    if (thumbPath) return convertFileSrc(thumbPath)
    return att.music_cover_data_url
  }

  function chatMusicAudioSrc(hasPath: string | undefined | null): string | null {
    return hasPath ? convertFileSrc(hasPath) : null
  }

  if (totalCount === 0) return null

  return (
    <div className="space-y-1.5 w-full max-w-[min(100%,28rem)]">
      {visibleAttachments.map((att) => {
        const {
          hasPath,
          thumbPath,
          notDownloaded,
          liveDownload,
          downloadProgress,
          showDownloadProgress,
        } = getAttachmentPresentation(att)

        const stateLabel = attachmentStateLabelFor(att)

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
                    <div className="text-[10px] text-foreground truncate w-full text-center block px-2">
                       {att.file_name}
                    </div>
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
                  <ChatMusicAttachmentCard
                    audioSrc={chatMusicAudioSrc(hasPath)}
                    waveformSeed={att.attachment_id}
                    waveformPeaks={att.waveform_peaks}
                    audioDurationSecs={att.audio_duration_secs}
                    coverSrc={musicCoverSrc(att, thumbPath)}
                    attachmentId={att.attachment_id}
                    localMediaPathForCover={hasPath ?? undefined}
                    onOpenAudioPreview={hasPath ? () => openAudioPreview(att, hasPath) : undefined}
                    title={att.file_name}
                    size={formatBytes(att.size_bytes)}
                    compact={totalCount > 1}
                  >
                    <div className="flex flex-col items-center justify-center gap-1 shrink-0">
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
                        <span className="text-[9px] text-muted-foreground text-center">Not available</span>
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
                  </ChatMusicAttachmentCard>
                }
              />
            ) : (
              <ChatMusicAttachmentCard
                className="border border-border/50"
                audioSrc={chatMusicAudioSrc(hasPath)}
                waveformSeed={att.attachment_id}
                waveformPeaks={att.waveform_peaks}
                audioDurationSecs={att.audio_duration_secs}
                coverSrc={musicCoverSrc(att, thumbPath)}
                attachmentId={att.attachment_id}
                localMediaPathForCover={hasPath ?? undefined}
                onOpenAudioPreview={hasPath ? () => openAudioPreview(att, hasPath) : undefined}
                title={att.file_name}
                size={formatBytes(att.size_bytes)}
                compact={totalCount > 1}
              />
            )}
          </div>
        )
      })}

      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "group flex items-center justify-center gap-2 w-full py-2.5 rounded-lg border border-dashed border-border/60 bg-muted/20 hover:bg-muted/40 transition-all duration-200",
            "text-xs font-medium text-muted-foreground hover:text-foreground"
          )}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3.5 transition-transform group-hover:-translate-y-0.5" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5 transition-transform group-hover:translate-y-0.5" />
              Show {remainingCount} more audio files
            </>
          )}
        </button>
      )}
    </div>
  )
}

export const AudioAttachmentGroup = memo(AudioAttachmentGroupInner)
