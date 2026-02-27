import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { cn } from '../lib/utils'

const BUNDLING_DOTS = ['.', '..', '...', '.', '..', '...']

export interface MessageBubbleMessage {
  id: string
  from_user_id: string
  sent_at: string
  delivery_status?: 'pending' | 'delivered' | 'bundling'
  delivered_by?: string[]
  bundling_progress?: number
}

export interface MessageBubbleProps {
  msg: MessageBubbleMessage
  isFirstInGroup: boolean
  displayName: string
  levelColor: string
  hovered: boolean
  onHoverChange: (hovered: boolean) => void
  currentUserId: string | undefined
  lastDeliveredMessageId: string | null
  lastPendingMessageId: string | null
  children: ReactNode
}

/**
 * Shell for a single chat message: layout, spacing, name+time when first in group,
 * and delivery status. Content (text / mixed / attachment) is passed as children.
 */
export function MessageBubble({
  msg,
  isFirstInGroup,
  displayName,
  levelColor,
  hovered,
  onHoverChange,
  currentUserId,
  lastDeliveredMessageId,
  lastPendingMessageId,
  children,
}: MessageBubbleProps) {
  const timeStr = new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const [bundlingDotIdx, setBundlingDotIdx] = useState(0)
  useEffect(() => {
    if (msg.delivery_status !== 'bundling') return
    const id = setInterval(() => setBundlingDotIdx((i) => (i + 1) % BUNDLING_DOTS.length), 400)
    return () => clearInterval(id)
  }, [msg.delivery_status])
  const showDeliveryStatus =
    currentUserId &&
    msg.from_user_id === currentUserId &&
    (msg.delivery_status === 'bundling' || msg.id === lastDeliveredMessageId || msg.id === lastPendingMessageId)

  return (
    <div
      className="group/msg py-px px-1 -mx-1 cursor-default"
      style={{ backgroundColor: hovered ? 'hsl(var(--muted) / 0.875)' : undefined }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      {isFirstInGroup ? (
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={cn('text-sm font-medium', levelColor)}>{displayName}</span>
          <span className="text-[10px] text-muted-foreground">{timeStr}</span>
        </div>
      ) : null}
      <div className={cn(isFirstInGroup ? 'mt-0.5' : '')}>{children}</div>
      {showDeliveryStatus && (
        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-baseline gap-0.5">
          {msg.delivery_status === 'bundling' ? (
            <>
              <span>Bundling</span>
              <span className="inline-block min-w-[1.5em] -ml-px" aria-hidden>{BUNDLING_DOTS[bundlingDotIdx]}</span>
              {msg.bundling_progress != null && msg.bundling_progress > 0 && (
                <span className="tabular-nums">{msg.bundling_progress}%</span>
              )}
            </>
          ) : (
            msg.id === lastDeliveredMessageId ? 'Delivered' : 'Pending'
          )}
          {msg.id === lastPendingMessageId &&
            (msg.delivered_by ?? []).filter((uid) => uid !== currentUserId).length > 0 && (
              <span className="ml-1">
                ({(msg.delivered_by ?? []).filter((uid) => uid !== currentUserId).length} online)
              </span>
            )}
        </div>
      )}
    </div>
  )
}
