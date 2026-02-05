import { useEffect, useMemo } from 'react'
import { UserPlus, UserMinus, Clock } from 'lucide-react'
import { Button } from './ui/button'

export function UserProfileCard({
  open,
  anchorRect,
  onClose,
  avatarDataUrl,
  fallbackColorStyle,
  initials,
  displayName,
  secondaryName,
  accountCreatedAt = null,
  isSelf = false,
  isFriend = false,
  isPendingOutgoing = false,
  onSendFriendRequest,
  onRemoveFriend,
}: {
  open: boolean
  anchorRect: DOMRect | null
  onClose: () => void
  avatarDataUrl: string | null
  fallbackColorStyle?: React.CSSProperties
  initials: string
  displayName: string
  secondaryName: string | null
  /** ISO date string; from local account for self, or via DHT for others when available */
  accountCreatedAt?: string | null
  isSelf?: boolean
  isFriend?: boolean
  isPendingOutgoing?: boolean
  onSendFriendRequest?: () => void
  onRemoveFriend?: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const pos = useMemo(() => {
    if (!open || !anchorRect) return null
    const cardW = 180
    const margin = 10
    const left = Math.min(
      Math.max(anchorRect.left + anchorRect.width / 2 - cardW / 2, margin),
      window.innerWidth - cardW - margin
    )
    const top = Math.min(anchorRect.bottom + 10, window.innerHeight - 260 - margin)
    return { left, top, width: cardW }
  }, [open, anchorRect])

  const createdLabel = accountCreatedAt
    ? (() => {
        try {
          const d = new Date(accountCreatedAt)
          if (Number.isNaN(d.getTime())) return null
          return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        } catch {
          return null
        }
      })()
    : null

  const showFriendAction = !isSelf && (onSendFriendRequest || onRemoveFriend || isPendingOutgoing)

  if (!open || !pos) return null

  return (
    <>
      <div className="fixed inset-0 z-50" onMouseDown={onClose} />
      <div
        className="fixed z-50"
        style={{ left: pos.left, top: pos.top, width: pos.width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-2 border-border bg-card/80 backdrop-blur-sm rounded-lg p-3 shadow-lg flex flex-col gap-3 min-h-[200px]">
          {/* Top row: PFP top-left, name to the right */}
          <div className="flex items-start gap-3">
            {avatarDataUrl ? (
              <img
                src={avatarDataUrl}
                alt={displayName}
                className="h-14 w-14 shrink-0 border-2 border-border rounded-none object-cover"
              />
            ) : (
              <div
                className="h-14 w-14 shrink-0 border-2 border-border rounded-none grid place-items-center text-xs font-mono tracking-wider"
                style={fallbackColorStyle}
              >
                {initials}
              </div>
            )}
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-sm font-light truncate">{displayName}</p>
              {secondaryName ? (
                <p className="text-xs text-muted-foreground font-light truncate">{secondaryName}</p>
              ) : null}
            </div>
          </div>

          {/* Bottom: stamp bottom-left, add/remove friend button bottom-right corner */}
          <div className="relative mt-auto pt-3 border-t border-border min-h-[45px]">
            {createdLabel ? (
              <span
                className="absolute left-0 bottom-0.0 text-[10px] text-muted-foreground opacity-60 italic font-light"
                aria-hidden
              >
                Account created: <br/> {createdLabel}
              </span>
            ) : null}
            {showFriendAction && (
              <div className="absolute right-0 bottom-0">
                {isFriend && onRemoveFriend ? (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-none font-light text-muted-foreground"
                    title="Remove from friends"
                    onClick={() => {
                      onRemoveFriend()
                      onClose()
                    }}
                  >
                    <UserMinus className="h-4 w-4" />
                  </Button>
                ) : isPendingOutgoing ? (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-none font-light text-muted-foreground"
                    title="Pending"
                    disabled
                  >
                    <Clock className="h-4 w-4" />
                  </Button>
                ) : onSendFriendRequest ? (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-none font-light"
                    title="Send friend request"
                    onClick={() => {
                      onSendFriendRequest()
                      onClose()
                    }}
                  >
                    <UserPlus className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
