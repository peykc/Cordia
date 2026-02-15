import { useMemo } from 'react'
import { ArrowUpDown } from 'lucide-react'
import { Button } from './ui/button'
import { useTransferCenterModal } from '../contexts/TransferCenterModalContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'

export function TransferCenterButton() {
  const { openTransferCenter } = useTransferCenterModal()
  const { attachmentTransfers } = useEphemeralMessages()
  const activeDownloads = useMemo(
    () =>
      attachmentTransfers.filter(
        (t) =>
          t.direction === 'download' &&
          (t.status === 'requesting' || t.status === 'connecting' || t.status === 'transferring')
      ),
    [attachmentTransfers]
  )
  const activeCount = activeDownloads.length
  const averageProgress =
    activeCount > 0
      ? activeDownloads.reduce((sum, t) => sum + Math.max(0, Math.min(1, t.progress || 0)), 0) / activeCount
      : 0

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 relative overflow-hidden rounded-none"
      title="Open transfer center"
      onClick={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        openTransferCenter(rect)
      }}
    >
      {activeCount > 0 && (
        <span
          className="absolute inset-x-0 bottom-0 bg-foreground/25 pointer-events-none"
          style={{ height: `${Math.max(2, Math.round(averageProgress * 100))}%` }}
          aria-hidden="true"
        />
      )}
      <ArrowUpDown className="h-4 w-4" />
      {activeCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[12px] h-3 px-0.5 border border-border bg-card text-[8px] leading-3 text-center pointer-events-none">
          {activeCount > 9 ? '9+' : activeCount}
        </span>
      )}
    </Button>
  )
}

