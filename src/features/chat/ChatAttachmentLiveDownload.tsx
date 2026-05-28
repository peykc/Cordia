import type { ReactNode } from 'react'
import type { AttachmentTransferState } from '../../domain/transfers/types'
import { useLiveDownloadForAttachment } from '../../stores/ephemeralMessagesStore'

type LiveDownloadRenderProps = {
  liveDownload: AttachmentTransferState | undefined
  downloadProgress: number
  showDownloadProgress: boolean
}

/** Per-attachment hook host — use as a child component, not inside hook loops at parent level. */
export function ChatAttachmentLiveDownload({
  attachmentId,
  children,
}: {
  attachmentId: string
  children: (props: LiveDownloadRenderProps) => ReactNode
}) {
  const liveDownload = useLiveDownloadForAttachment(attachmentId)
  const downloadProgress = liveDownload
    ? Math.max(0, Math.min(100, Math.round((liveDownload.progress ?? 0) * 100)))
    : 0
  const showDownloadProgress =
    !!liveDownload && (liveDownload.status === 'transferring' || liveDownload.status === 'completed')
  return <>{children({ liveDownload, downloadProgress, showDownloadProgress })}</>
}

/** Hides children while an active download exists for this attachment. */
export function ChatAttachmentHideWhileDownloading({
  attachmentId,
  children,
}: {
  attachmentId: string
  children: ReactNode
}) {
  const liveDownload = useLiveDownloadForAttachment(attachmentId)
  if (liveDownload) return null
  return <>{children}</>
}
