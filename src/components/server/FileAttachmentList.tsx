import { memo, useState } from 'react'
import { ChevronDown, ChevronUp, Download, Ban, CloudOff, Upload } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Tooltip } from '../Tooltip'
import { ChatFileRowSlot } from '../ChatMediaSlot'
import { IconForCategory } from '../FileIcon'
import { formatBytes } from '../../lib/bytes'
import { NotDownloadedCardByWidth } from './NotDownloadedCardByWidth'
import { getFileTypeFromExt } from '../../lib/fileType'
import { FilenameEllipsis } from '../FilenameEllipsis'
import type { EphemeralAttachmentMeta } from '../../domain/attachments/types'

const NOT_DOWNLOADED_CARD_NARROW_PX = 110

type Props = {
  attachments: EphemeralAttachmentMeta[]
  msg: any
  callbacks: any
  threshold?: number
}

function FileAttachmentListInner({
  attachments,
  msg,
  callbacks,
  threshold = 5,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const totalCount = attachments.length
  const hasMore = totalCount > threshold
  const visibleAttachments = expanded ? attachments : attachments.slice(0, threshold)
  const remainingCount = totalCount - threshold

  const {
      identity,
      getAttachmentPresentation,
      requestAttachmentDownload,
      attachmentStateLabelFor,
      unavailableReasonFor,
      handleShareAgainAttachment,
      shareInChatVisible,
  } = callbacks || {}

  if (totalCount === 0) return null

  return (
    <div className="space-y-1 w-full max-w-[min(100%,28rem)]">
      {visibleAttachments.map((att) => {
        const isOwn = msg.from_user_id === identity?.user_id
        const {
          hasPath,
          notDownloaded,
          liveDownload,
          downloadProgress,
          showDownloadProgress,
        } = getAttachmentPresentation(att)
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
                    <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block px-2" title={att.file_name} />
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
                }
              />
            ) : (
              <ChatFileRowSlot
                className="border border-border/50"
                icon={<IconForCategory cat={category} className="text-muted-foreground" />}
                title={att.file_name}
                size={formatBytes(att.size_bytes)}
              >
                {shareInChatVisible(att, isOwn, hasPath) && (
                  <span className="shrink-0">
                    <Tooltip content={isOwn ? "Share again" : "Share in this chat"}>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleShareAgainAttachment(att, isOwn, hasPath)
                        }}
                      >
                        <Upload className="h-3.5 w-3.5" />
                      </Button>
                    </Tooltip>
                  </span>
                )}
              </ChatFileRowSlot>
            )}
          </div>
        )
      })}

      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-center gap-2 w-full py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="size-3" />
              Show {remainingCount} more files
            </>
          )}
        </button>
      )}
    </div>
  )
}

export const FileAttachmentList = memo(FileAttachmentListInner)
