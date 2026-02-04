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
    const cardW = 260
    const margin = 10
    const left = Math.min(
      Math.max(anchorRect.left + anchorRect.width / 2 - cardW / 2, margin),
      window.innerWidth - cardW - margin
    )
    const top = Math.min(anchorRect.bottom + 10, window.innerHeight - 160 - margin)
    return { left, top, width: cardW }
  }, [open, anchorRect])

  if (!open || !pos) return null

  return (
    <>
      <div className="fixed inset-0 z-50" onMouseDown={onClose} />
      <div
        className="fixed z-50"
        style={{ left: pos.left, top: pos.top, width: pos.width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-2 border-border bg-card/80 backdrop-blur-sm rounded-lg p-3 shadow-lg space-y-3">
          <div className="flex items-center gap-3">
            {avatarDataUrl ? (
              <img
                src={avatarDataUrl}
                alt={displayName}
                className="h-12 w-12 border-2 border-border rounded-none object-cover"
              />
            ) : (
              <div
                className="h-12 w-12 border-2 border-border rounded-none grid place-items-center text-[10px] font-mono tracking-wider"
                style={fallbackColorStyle}
              >
                {initials}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-light truncate">{displayName}</p>
              {secondaryName ? (
                <p className="text-xs text-muted-foreground font-light truncate">{secondaryName}</p>
              ) : null}
            </div>
          </div>
          {!isSelf && (onSendFriendRequest || onRemoveFriend || isPendingOutgoing) && (
            <div className="pt-2 border-t border-border">
              {isFriend && onRemoveFriend ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start gap-2 font-light text-muted-foreground"
                  onClick={() => {
                    onRemoveFriend()
                    onClose()
                  }}
                >
                  <UserMinus className="h-3.5 w-3.5" />
                  Remove from friends
                </Button>
              ) : isPendingOutgoing ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm font-light text-muted-foreground">
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  Pending
                </div>
              ) : onSendFriendRequest ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start gap-2 font-light"
                  onClick={() => {
                    onSendFriendRequest()
                    onClose()
                  }}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Send friend request
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

