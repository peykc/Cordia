import { Bell } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip } from './Tooltip'
import { useNotificationsModal } from '../contexts/NotificationsModalContext'
import { useFriends } from '../contexts/FriendsContext'
import { useMemo } from 'react'
import { cn } from '../lib/utils'

/** Steam-style flat olive tile when there are pending friend / redemption notices. */
const STEAM_BELL_ACTIVE =
  'rounded-sm border-0 bg-[#5a6d26] text-white shadow-none hover:bg-[#6a7f2f] hover:text-white active:bg-[#4f5f20] dark:bg-[#637532] dark:hover:bg-[#738a3a] dark:active:bg-[#56682c] focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:ring-offset-0'

export function NotificationCenterButton() {
  const { openNotifications, anchorRef } = useNotificationsModal()
  const { pendingIncoming, redemptions } = useFriends()

  const mergedIncomingCount = useMemo(() => {
    const byId = new Set<string>()
    for (const r of pendingIncoming) byId.add(r.from_user_id)
    for (const r of redemptions) byId.add(r.redeemer_user_id)
    return byId.size
  }, [pendingIncoming, redemptions])

  const hasIncoming = mergedIncomingCount > 0

  return (
    <Tooltip
      content={
        hasIncoming
          ? `Notifications — ${mergedIncomingCount} pending`
          : 'Notifications'
      }
      side="bottom"
    >
      <Button
        ref={anchorRef as React.Ref<HTMLButtonElement>}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={
          hasIncoming
            ? `Notifications, ${mergedIncomingCount} pending`
            : 'Notifications'
        }
        className={cn(
          'h-8 w-8 relative overflow-hidden transition-colors',
          hasIncoming ? STEAM_BELL_ACTIVE : 'rounded-none'
        )}
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          openNotifications(rect)
        }}
      >
        <Bell
          className={cn('h-4 w-4 shrink-0', hasIncoming && 'text-white')}
          strokeWidth={hasIncoming ? 2.25 : 2}
          aria-hidden
        />
      </Button>
    </Tooltip>
  )
}
