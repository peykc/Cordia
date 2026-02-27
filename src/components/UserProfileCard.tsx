import { useEffect, useMemo, type RefObject } from 'react'
import { UserPlus, UserMinus, Clock } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip } from './Tooltip'
import { useWindowSize } from '../lib/useWindowSize'

export function UserProfileCard({
  open,
  anchorRect,
  anchorRef,
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
  /** When set, position is read from this element so the card follows the button (e.g. on resize). */
  anchorRef?: RefObject<HTMLElement | null>
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
  const { width, height } = useWindowSize()
  const effectiveAnchorRect = open
    ? (anchorRef?.current?.getBoundingClientRect() ?? anchorRect)
    : null

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const pos = useMemo(() => {
    if (!open || !effectiveAnchorRect) return null
    const cardW = 180
    const margin = 10
    const left = Math.min(
      Math.max(effectiveAnchorRect.left + effectiveAnchorRect.width / 2 - cardW / 2, margin),
      width - cardW - margin
    )
    const top = Math.min(effectiveAnchorRect.bottom + 10, height - 260 - margin)
    return { left, top, width: cardW }
  }, [open, effectiveAnchorRect, width, height])

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
                className="absolute left-0 bottom-0.0 text-[10px] text-muted-foreground opacity-60 font-light"
                aria-hidden
              >
                <i>Account created: </i><br/> {createdLabel}
              </span>
            ) : null}
            {showFriendAction && (
              <div className="absolute right-0 bottom-0">
                {isFriend && onRemoveFriend ? (
                  <Tooltip content="Remove from friends" side="top">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0 rounded-none font-light text-muted-foreground"
                      onClick={() => {
                        onRemoveFriend()
                        onClose()
                      }}
                    >
                      <UserMinus className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                ) : isPendingOutgoing ? (
                  <Tooltip content="Pending" side="top">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0 rounded-none font-light text-muted-foreground"
                      disabled
                    >
                      <Clock className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                ) : onSendFriendRequest ? (
                  <Tooltip content="Send friend request" side="top">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0 rounded-none font-light"
                      onClick={() => {
                        onSendFriendRequest()
                        onClose()
                      }}
                    >
                      <UserPlus className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
