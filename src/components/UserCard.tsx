import { PhoneOff, Settings } from 'lucide-react'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { useWebRTC } from '../contexts/WebRTCContext'
import { useBeacon } from '../contexts/BeaconContext'
import { useActiveServer } from '../contexts/ActiveServerContext'
import { useSidebarWidth } from '../contexts/SidebarWidthContext'
import { useSettingsModal } from '../contexts/SettingsModalContext'
import { useMemo, useRef, useState, useEffect, type CSSProperties } from 'react'
import { Button } from './ui/button'
import { Tooltip } from './Tooltip'

function hashId(s: string) {
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  return hash
}

function initials(name: string) {
  const cleaned = name.trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** Self presence: gray = offline, orange = home, green = in server, blue = in call */
type SelfPresence = 'offline' | 'home' | 'in_server' | 'in_call'

function getSelfPresence(
  signalingConnected: boolean,
  activeSigningPubkey: string | null,
  isInVoice: boolean
): SelfPresence {
  if (!signalingConnected) return 'offline'
  if (isInVoice) return 'in_call'
  if (activeSigningPubkey != null) return 'in_server'
  return 'home'
}

type UserCardProps = {
  /** When true, renders inline in the friends/members sidebar (no resize, full width) */
  embedded?: boolean
  /** When true, shows only avatar (for closed drawer strip) - same height as full for no layout shift */
  compact?: boolean
  /** When true, compact layout for top bar (avatar + name + settings) */
  variant?: 'default' | 'header'
  /** When true (with variant=header), stretches to align avatar with friends list PFPs, settings stays right */
  alignWithFriends?: boolean
  /** When provided, clicking the avatar opens the personal UserProfileCard instead of navigating. Called with anchor rect. */
  onAvatarClick?: (rect: DOMRect) => void
}

export function UserCard({ embedded = false, compact = false, variant = 'default', alignWithFriends = false, onAvatarClick }: UserCardProps) {
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const { isInVoice, leaveVoice } = useWebRTC()
  const { status: beaconStatus } = useBeacon()
  const { activeSigningPubkey } = useActiveServer()
  const { width, setWidth, resetWidth } = useSidebarWidth()
  const { openSettings } = useSettingsModal()
  const resizeHandleRef = useRef<HTMLDivElement>(null)
  const [isResizing, setIsResizing] = useState(false)

  const style: CSSProperties | undefined = useMemo(() => {
    const userId = identity?.user_id
    if (!userId) return undefined
    const h = hashId(userId) % 360
    return {
      backgroundColor: `hsl(${h}, 45%, 35%)`,
      color: '#fff',
    }
  }, [identity?.user_id])

  const displayName = profile.display_name || identity?.display_name || 'Account'
  const signalingConnected = beaconStatus === 'connected'
  const selfPresence = getSelfPresence(signalingConnected, activeSigningPubkey, isInVoice)

  const getStatusText = () => {
    switch (selfPresence) {
      case 'offline':
        return 'Offline'
      case 'home':
        return 'Home'
      case 'in_server':
        return 'In server'
      case 'in_call':
        return 'In voice'
      default:
        return 'Offline'
    }
  }

  const getStatusColor = () => {
    switch (selfPresence) {
      case 'offline':
        return 'text-muted-foreground'
      case 'home':
        return 'text-orange-500'
      case 'in_server':
        return 'text-green-500'
      case 'in_call':
        return 'text-blue-500'
      default:
        return 'text-muted-foreground'
    }
  }

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize)
      // User card is right-anchored; width is distance from cursor to right edge.
      const newWidthEm = (window.innerWidth - e.clientX) / rootFontSize
      setWidth(newWidthEm)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, setWidth])

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resetWidth()
  }

  if (!identity) {
    return null
  }

  const isHeader = variant === 'header'
  const avatarSize = compact ? 'h-8 w-8' : isHeader ? 'h-10 w-10' : 'h-10 w-10'
  const dotSize = compact ? 'w-2 h-2' : 'w-3 h-3'

  if (isHeader) {
    const avatarEl = (
      <div className="relative shrink-0">
        {profile.avatar_data_url ? (
          <img src={profile.avatar_data_url} alt={displayName} className={`${avatarSize} border-2 border-border rounded-none object-cover`} />
        ) : (
          <div className={`${avatarSize} border-2 border-border rounded-none grid place-items-center text-[10px] font-mono tracking-wider`} style={style}>
            {initials(displayName)}
          </div>
        )}
        <div className={`absolute -bottom-0.5 -right-0.5 ${dotSize} border-2 border-background rounded-none bg-background`}>
          <div className={`w-full h-full rounded-none ${selfPresence === 'offline' ? 'bg-gray-500' : selfPresence === 'home' ? 'bg-orange-500' : selfPresence === 'in_server' ? 'bg-green-500' : 'bg-blue-500'}`} />
        </div>
      </div>
    )
    return (
      <div
        className={`flex items-center gap-2 ${alignWithFriends ? 'h-12' : 'h-10'} ${
          alignWithFriends ? 'flex-1 min-w-0' : 'shrink-0'
        }`}
      >
        {onAvatarClick ? (
          <button
            type="button"
            onClick={(e) => onAvatarClick((e.currentTarget as HTMLElement).getBoundingClientRect())}
            className="relative shrink-0 rounded-md will-change-transform transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06] focus:outline-none"
          >
            {avatarEl}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => openSettings('account')}
            className="relative shrink-0 rounded-md will-change-transform transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06] focus:outline-none"
          >
            {avatarEl}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-light truncate">{displayName}</p>
          <p className={`text-xs font-light truncate ${getStatusColor()}`}>{getStatusText()}</p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {isInVoice && (
            <Tooltip content="Leave voice call" side="top">
              <Button variant="ghost" size="icon" onClick={leaveVoice} className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-500/10">
                <PhoneOff className="h-4 w-4" />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="User Settings" side="top">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => openSettings('account')}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`border-border h-[52px] relative shrink-0 flex items-center ${
        embedded
          ? compact
            ? 'w-full justify-center'
            : 'w-full border-2 rounded-md bg-background/70 shadow-sm px-1.5 py-1.5'
          : 'bg-card border-b-2 border-l-2 p-2'
      }`}
      style={embedded ? undefined : { width: `${width}em` }}
    >
      <div className={`flex items-center gap-2 h-full ${compact ? 'justify-center w-full' : ''}`}>
        {/* Avatar */}
        <div className="relative">
          {profile.avatar_data_url ? (
            <img
              src={profile.avatar_data_url}
              alt={displayName}
              className={`${avatarSize} border-2 border-border rounded-none object-cover`}
            />
          ) : (
            <div
              className={`${avatarSize} border-2 border-border rounded-none grid place-items-center text-[10px] font-mono tracking-wider`}
              style={style}
            >
              {initials(displayName)}
            </div>
          )}
          {/* Presence dot: gray = offline, orange = home, green = in server, blue = in call */}
          <div className={`absolute -bottom-0.5 -right-0.5 ${dotSize} border-2 border-background rounded-none bg-background`}>
            <div
              className={`w-full h-full rounded-none ${
                selfPresence === 'offline'
                  ? 'bg-gray-500'
                  : selfPresence === 'home'
                    ? 'bg-orange-500'
                    : selfPresence === 'in_server'
                      ? 'bg-green-500'
                      : 'bg-blue-500'
              }`}
            />
          </div>
        </div>

        {!compact && (
          <>
            {/* Name and Status */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-light truncate">{displayName}</p>
              <p className={`text-xs font-light truncate ${getStatusColor()}`}>
                {getStatusText()}
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1">
              {isInVoice && (
                <Tooltip content="Leave voice call" side="top">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={leaveVoice}
                    className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                  >
                    <PhoneOff className="h-4 w-4" />
                  </Button>
                </Tooltip>
              )}
              <Tooltip content="User Settings" side="top">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => openSettings('account')}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </Tooltip>
            </div>
          </>
        )}
      </div>
      {/* Resize handle - only when not embedded */}
      {!embedded && (
        <div
          ref={resizeHandleRef}
          onMouseDown={handleResizeStart}
          onDoubleClick={handleDoubleClick}
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-primary/50 transition-colors z-10"
        >
          <div className="absolute inset-0 -left-1 w-2" />
        </div>
      )}
    </div>
  )
}
