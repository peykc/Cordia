import { Bell } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip } from './Tooltip'
import { useNotificationsModal } from '../contexts/NotificationsModalContext'
import { useFriends } from '../contexts/FriendsContext'
import { useMemo } from 'react'

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
    <Tooltip content="Notifications" side="bottom">
    <Button
      ref={anchorRef as React.Ref<HTMLButtonElement>}
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 relative overflow-hidden rounded-none"
      onClick={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        openNotifications(rect)
      }}
    >
      <Bell className="h-4 w-4" />
      {hasIncoming && (
        <span
          className="absolute -top-0.5 -right-0.5 min-w-[12px] h-3 px-0.5 border border-border bg-green-500 text-white text-[8px] leading-3 text-center pointer-events-none rounded-sm"
          title={`${mergedIncomingCount} incoming`}
        >
          {mergedIncomingCount > 99 ? '99+' : mergedIncomingCount}
        </span>
      )}
    </Button>
    </Tooltip>
  )
}
