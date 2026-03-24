import React, { memo, type RefObject } from 'react'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { Eye, EyeOff, Paperclip, Send, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip } from '../Tooltip'
import { FilenameEllipsis } from '../FilenameEllipsis'
import { FileIcon } from '../FileIcon'
import { formatBytes } from '../../lib/bytes'
import { cn } from '../../lib/utils'
import { isMediaType, getFileTypeFromExt } from '../../lib/fileType'

export interface StagedAttachment {
  staged_id: string
  path: string
  file_name: string
  extension: string
  size_bytes: number
  storage_mode: 'current_path' | 'program_copy'
  spoiler?: boolean
  attachment_id?: string
  ready?: boolean
  preparePercent?: number
}

export interface ServerComposerProps {
  messageInputRef: RefObject<HTMLTextAreaElement | null>
  composerHasText: boolean
  setComposerHasText: (value: boolean | ((prev: boolean) => boolean)) => void
  adjustComposerHeight: () => void
  onDraftChange: (value: string) => void
  canSendMessages: boolean
  beaconStatus: string
  stagedAttachments: StagedAttachment[]
  messageMaxLength: number
  messageInputMaxHeight: number
  onSendMessage: () => void
  onAddAttachment: () => void
  onRemoveStagedAttachment: (stagedId: string) => void
  onToggleStagedSpoiler: (stagedId: string) => void
  onMediaPreview: (opts: {
    type: 'image' | 'video'
    url: string
    fileName: string
    localPath: string
    sizeBytes: number
  }) => void
}

function ServerComposerImpl({
  messageInputRef,
  composerHasText,
  setComposerHasText,
  adjustComposerHeight,
  onDraftChange,
  canSendMessages,
  beaconStatus,
  stagedAttachments,
  messageMaxLength,
  messageInputMaxHeight,
  onSendMessage,
  onAddAttachment,
  onRemoveStagedAttachment,
  onToggleStagedSpoiler,
  onMediaPreview,
}: ServerComposerProps) {
  return (
    <div className="border-t-2 border-border p-4 bg-card/50">
      <form
        className="max-w-6xl mx-auto"
        onSubmit={(e) => {
          e.preventDefault()
          onSendMessage()
        }}
      >
        {stagedAttachments.length > 0 && (
          <div className="mb-3 overflow-x-auto overflow-y-hidden pb-1 [scrollbar-gutter:stable]">
            <div className="flex flex-nowrap gap-2 min-w-max">
              {stagedAttachments.map((att) => {
                const category = att.file_name ? getFileTypeFromExt(att.file_name) : 'default'
                const isMedia = att.file_name && isMediaType(category as Parameters<typeof isMediaType>[0])
                return (
                  <div
                    key={att.staged_id}
                    className="flex items-start gap-2 w-[165px] h-[80px] shrink-0 border-2 border-border bg-card rounded-lg px-2 py-2 overflow-hidden"
                  >
                    <FileIcon
                      fileName={att.file_name}
                      attachmentId={null}
                      savedPath={att.path}
                      onMediaClick={(url, type, _attachmentId, fileName) => {
                        if (isMedia) {
                          onMediaPreview({
                            type: type as 'image' | 'video',
                            url: url ?? convertFileSrc(att.path),
                            fileName: fileName ?? att.file_name,
                            localPath: att.path,
                            sizeBytes: att.size_bytes,
                          })
                        }
                      }}
                      boxSize={48}
                    />
                    <div className="min-w-0 flex-1 flex flex-col gap-1">
                      <FilenameEllipsis name={att.file_name} className="text-xs truncate" />
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">
                          {att.ready
                            ? formatBytes(att.size_bytes)
                            : att.preparePercent != null
                              ? `Preparing ${att.preparePercent}%`
                              : 'Preparing…'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Tooltip content={att.spoiler ? 'Marked as spoiler' : 'Mark as spoiler'} side="top">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn('h-6 w-6', att.spoiler && 'text-amber-500')}
                            onClick={() => onToggleStagedSpoiler(att.staged_id)}
                          >
                            {att.spoiler ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </Tooltip>
                        <Tooltip content="Remove" side="top">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-red-300 hover:text-red-200"
                            onClick={() => onRemoveStagedAttachment(att.staged_id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Tooltip content="Attach file(s)" title="Attach file(s)">
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-11 w-11 shrink-0"
              disabled={!canSendMessages}
              onClick={onAddAttachment}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </Tooltip>
          <textarea
            ref={messageInputRef as React.RefObject<HTMLTextAreaElement>}
            onChange={(e) => {
              const v = e.target.value
              setComposerHasText((prev) => {
                const hasText = v.trim().length > 0
                return prev === hasText ? prev : hasText
              })
              adjustComposerHeight()
              onDraftChange(v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSendMessage()
              }
            }}
            placeholder={
              canSendMessages
                ? ''
                : beaconStatus !== 'connected'
                  ? 'Beacon disconnected - messages unavailable'
                  : 'Messaging unavailable for this connection mode'
            }
            rows={1}
            maxLength={messageMaxLength}
            style={{ maxHeight: messageInputMaxHeight }}
            className="w-full min-h-[44px] resize-none overflow-y-hidden [scrollbar-gutter:stable_both-edges] px-4 py-3 bg-background border border-border rounded-lg text-sm font-light focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
            disabled={!canSendMessages}
          />
          <Tooltip
            content={
              stagedAttachments.length > 0 && stagedAttachments.some((a) => !a.ready)
                ? 'Wait for attachments to finish preparing'
                : 'Send'
            }
          >
            <Button
              type="submit"
              size="sm"
              className="h-11 px-4 gap-2 shrink-0"
              disabled={
                !canSendMessages ||
                (!composerHasText && stagedAttachments.length === 0) ||
                (stagedAttachments.length > 0 && stagedAttachments.some((a) => !a.ready))
              }
            >
              <Send className="h-4 w-4" />
              Send
            </Button>
          </Tooltip>
        </div>
      </form>
    </div>
  )
}

export const ServerComposer = memo(ServerComposerImpl)
