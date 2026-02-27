import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Bell, ChevronLeft, UserPlus, X, Check, XCircle } from 'lucide-react'
import { Button } from './ui/button'
import { useWindowSize } from '../lib/useWindowSize'
import { useNotificationsModal } from '../contexts/NotificationsModalContext'
import { useFriends } from '../contexts/FriendsContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { useServers } from '../contexts/ServersContext'

const FRIENDS_LIST_WIDTH_REM = 12.25
const ROW_HEIGHT = 44
const HEADER_HEIGHT = 40
const MAX_VISIBLE_ROWS = 12
const LIST_VIEW_BOTTOM_GAP = 16

export function NotificationsModal() {
  const { isOpen, anchorRect, anchorRef, closeNotifications } = useNotificationsModal()
  const { width, height } = useWindowSize()
  const effectiveAnchorRect = isOpen
    ? (anchorRef?.current?.getBoundingClientRect() ?? anchorRect)
    : null
  const [view, setView] = useState<'list' | 'friend_requests'>('list')
  const [pendingFilter, setPendingFilter] = useState<'outgoing' | 'incoming'>('incoming')

  const {
    pendingIncoming,
    pendingOutgoing,
    redemptions,
    acceptFriendRequest,
    declineFriendRequest,
    acceptCodeRedemption,
    declineCodeRedemption,
    cancelPendingTo,
  } = useFriends()
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const { servers } = useServers()

  const mergedIncoming = useMemo(() => {
    const byId = new Map<
      string,
      { userId: string; displayName: string; fromRequest: boolean; fromRedemption: boolean }
    >()
    const namePlaceholder = remoteProfiles.hydrated ? 'Unknown' : ''
    for (const r of pendingIncoming) {
      byId.set(r.from_user_id, {
        userId: r.from_user_id,
        displayName:
          remoteProfiles.getProfile(r.from_user_id)?.display_name ?? r.from_display_name ?? namePlaceholder,
        fromRequest: true,
        fromRedemption: false,
      })
    }
    for (const r of redemptions) {
      const existing = byId.get(r.redeemer_user_id)
      byId.set(r.redeemer_user_id, {
        userId: r.redeemer_user_id,
        displayName:
          existing?.displayName ??
          remoteProfiles.getProfile(r.redeemer_user_id)?.display_name ??
          r.redeemer_display_name ??
          namePlaceholder,
        fromRequest: existing?.fromRequest ?? false,
        fromRedemption: true,
      })
    }
    return Array.from(byId.values())
  }, [pendingIncoming, redemptions, remoteProfiles])

  const fallbackNameForUser = (userId: string) => {
    for (const s of servers) {
      const m = s.members.find((mm) => mm.user_id === userId)
      if (m?.display_name) return m.display_name
    }
    return 'Unknown'
  }

  useEffect(() => {
    if (!isOpen) return
    setView('list')
    setPendingFilter('incoming')
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (view === 'friend_requests') setView('list')
        else closeNotifications()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, view, closeNotifications])

  if (!isOpen || !effectiveAnchorRect) return null

  const popupWidthPx = Math.round(FRIENDS_LIST_WIDTH_REM * 16)
  const notificationCount = mergedIncoming.length > 0 ? 1 : 0
  const listContentHeight =
    view === 'list'
      ? Math.max(ROW_HEIGHT, Math.min(notificationCount * ROW_HEIGHT, MAX_VISIBLE_ROWS * ROW_HEIGHT)) +
        (notificationCount > 0 ? LIST_VIEW_BOTTOM_GAP : 0)
      : Math.min(
          Math.max(pendingOutgoing.length, mergedIncoming.length) * ROW_HEIGHT + 36,
          MAX_VISIBLE_ROWS * ROW_HEIGHT
        )
  const popupHeight = Math.min(
    HEADER_HEIGHT + listContentHeight + (view === 'friend_requests' ? 40 : 0),
    height - 24
  )
  const gutter = 10
  const topBarHeight = 96
  let left = Math.round(effectiveAnchorRect.right - popupWidthPx)
  left = Math.max(gutter, Math.min(left, width - popupWidthPx - gutter))
  let top = Math.round(effectiveAnchorRect.bottom + 8)
  if (top + popupHeight > height - gutter) {
    top = Math.round(effectiveAnchorRect.top - popupHeight - 8)
  }
  top = Math.max(topBarHeight, Math.min(top, height - popupHeight - gutter))

  const myDisplayName = identity?.display_name ?? profile?.display_name ?? undefined

  const listItemCount =
    view === 'list'
      ? mergedIncoming.length
      : pendingFilter === 'outgoing'
        ? pendingOutgoing.length
        : mergedIncoming.length
  const contentOverflows = listItemCount > 4
  const contentOverflowClass = contentOverflows ? 'overflow-y-auto' : 'overflow-y-hidden'

  const getInitials = (name: string) => {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase().slice(0, 2)
    return (name.trim().slice(0, 2) || '?').toUpperCase()
  }

  const hashId = (s: string) => {
    let hash = 0
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
    return hash
  }
  const avatarStyleForUser = (userId: string): CSSProperties => {
    const h = hashId(userId) % 360
    return { backgroundColor: `hsl(${h}, 45%, 35%)`, color: '#fff' }
  }

  const popupEl = (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 cursor-default" onMouseDown={closeNotifications} />
      <div
        className="absolute border-2 border-border bg-card/95 shadow-2xl flex flex-col overflow-hidden rounded-none"
        style={{ left, top, width: popupWidthPx, height: popupHeight }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="h-10 shrink-0 border-b border-border/70 px-3 flex items-center gap-1">
          {view === 'friend_requests' ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setView('list')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <h1 className="text-xs font-light tracking-wider uppercase truncate">Friend requests</h1>
            </>
          ) : (
            <>
              <Bell className="h-4 w-4 shrink-0" />
              <h1 className="text-xs font-light tracking-wider uppercase truncate">Notifications</h1>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 ml-auto"
            onClick={closeNotifications}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>

        <div
          className={`flex-1 min-h-0 min-w-0 flex flex-col ${contentOverflowClass} px-3 pt-2 ${
            view === 'list' && mergedIncoming.length > 0 ? 'pb-4' : 'pb-2'
          }`}
        >
          {view === 'list' ? (
            <div className={mergedIncoming.length > 0 ? 'self-start w-full' : 'flex-1 flex items-center justify-center'}>
              {mergedIncoming.length > 0 ? (
                <button
                  type="button"
                  className="w-full px-3 py-2.5 flex items-center gap-2 text-left rounded-md bg-white text-black hover:bg-gray-100 border border-border/50"
                  onClick={() => setView('friend_requests')}
                >
                  <UserPlus className="h-4 w-4 shrink-0 text-black" />
                  <span className="text-xs font-medium truncate text-black">
                    {mergedIncoming.length} new friend request{mergedIncoming.length !== 1 ? 's' : ''}
                  </span>
                </button>
              ) : (
                <p className="text-sm text-muted-foreground">No notifications.</p>
              )}
            </div>
          ) : (
            <>
              <div className="flex gap-1 pb-2 shrink-0">
                <Button
                  variant={pendingFilter === 'incoming' ? 'default' : 'ghost'}
                  size="sm"
                  className="text-xs font-light flex-1"
                  onClick={() => setPendingFilter('incoming')}
                >
                  Incoming
                </Button>
                <Button
                  variant={pendingFilter === 'outgoing' ? 'default' : 'ghost'}
                  size="sm"
                  className="text-xs font-light flex-1"
                  onClick={() => setPendingFilter('outgoing')}
                >
                  Outgoing
                </Button>
              </div>
              <div className="space-y-0.5">
                {pendingFilter === 'outgoing' ? (
                  pendingOutgoing.length === 0 ? (
                    <p className="py-3 text-sm text-muted-foreground">No pending invites you sent.</p>
                  ) : (
                    pendingOutgoing.map((userId) => {
                      const rp = remoteProfiles.getProfile(userId)
                      const displayName = rp?.display_name ?? fallbackNameForUser(userId)
                      return (
                        <div
                          key={userId}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-md min-w-0"
                        >
                          <div
                            className="h-7 w-7 shrink-0 grid place-items-center rounded-none text-[9px] font-mono"
                            style={!rp?.avatar_data_url ? avatarStyleForUser(userId) : undefined}
                          >
                            {rp?.avatar_data_url ? (
                              <img src={rp.avatar_data_url} alt="" className="w-full h-full object-cover" />
                            ) : (
                              getInitials(displayName)
                            )}
                          </div>
                          <span className="text-xs truncate flex-1 min-w-0">{displayName}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-1.5 text-muted-foreground hover:text-destructive shrink-0"
                            onClick={() => cancelPendingTo(userId)}
                          >
                            <XCircle className="h-3 w-3" />
                          </Button>
                        </div>
                      )
                    })
                  )
                ) : mergedIncoming.length === 0 ? (
                  <p className="py-3 text-sm text-muted-foreground">No incoming requests.</p>
                ) : (
                  mergedIncoming.map((entry) => (
                    <div
                      key={entry.userId}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md min-w-0"
                    >
                      <div
                        className="h-7 w-7 shrink-0 grid place-items-center rounded-none text-[9px] font-mono"
                        style={
                          !remoteProfiles.getProfile(entry.userId)?.avatar_data_url
                            ? avatarStyleForUser(entry.userId)
                            : undefined
                        }
                      >
                        {remoteProfiles.getProfile(entry.userId)?.avatar_data_url ? (
                          <img
                            src={remoteProfiles.getProfile(entry.userId)!.avatar_data_url!}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          getInitials(entry.displayName)
                        )}
                      </div>
                      <span className="text-xs truncate flex-1 min-w-0">{entry.displayName}</span>
                      <div className="flex gap-0.5 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-green-600"
                          onClick={async () => {
                            remoteProfiles.applyUpdate({
                              user_id: entry.userId,
                              display_name: entry.displayName,
                              secondary_name: null,
                              show_secondary: false,
                              rev: 1,
                            })
                            if (entry.fromRequest)
                              await acceptFriendRequest(entry.userId, myDisplayName).catch(() => {})
                            if (entry.fromRedemption)
                              await acceptCodeRedemption(entry.userId, myDisplayName).catch(() => {})
                          }}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={async () => {
                            if (entry.fromRequest) await declineFriendRequest(entry.userId).catch(() => {})
                            if (entry.fromRedemption) await declineCodeRedemption(entry.userId).catch(() => {})
                          }}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )

  if (typeof document === 'undefined') return null
  return createPortal(popupEl, document.body)
}
