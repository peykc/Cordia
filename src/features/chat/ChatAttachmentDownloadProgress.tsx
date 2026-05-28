import { cn } from '../../lib/utils'
import { useLiveDownloadForAttachment } from '../../stores/ephemeralMessagesStore'

type Props = {
  attachmentId: string
  variant?: 'overlay' | 'inline'
  className?: string
  barClassName?: string
}

/** Subscribes to live download progress for one attachment only. */
export function ChatAttachmentDownloadProgress({
  attachmentId,
  variant = 'overlay',
  className,
  barClassName,
}: Props) {
  const liveDownload = useLiveDownloadForAttachment(attachmentId)
  const downloadProgress = liveDownload
    ? Math.max(0, Math.min(100, Math.round((liveDownload.progress ?? 0) * 100)))
    : 0
  const showDownloadProgress =
    !!liveDownload && (liveDownload.status === 'transferring' || liveDownload.status === 'completed')

  if (!showDownloadProgress) return null

  if (variant === 'inline') {
    return (
      <div className={cn('w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full', className)}>
        <div
          className={cn(
            'h-full',
            liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85',
            barClassName
          )}
          style={{ width: `${Math.max(2, downloadProgress)}%` }}
        />
      </div>
    )
  }

  return (
    <div className={cn('absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-black/30', className)}>
      <div
        className={cn(
          'h-full',
          liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85',
          barClassName
        )}
        style={{ width: `${Math.max(2, downloadProgress)}%` }}
      />
    </div>
  )
}
