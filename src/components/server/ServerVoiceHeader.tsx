import { memo } from 'react'
import { Phone, PhoneOff, VolumeX } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import type { PresenceLevel } from '../../contexts/PresenceContext'
import type { Server } from '../../lib/tauri'

function PresenceSquare({ level, size = 'default' }: { level: PresenceLevel; size?: 'default' | 'small' }) {
  const cls =
    level === 'in_call'
      ? 'bg-accent'
      : level === 'active'
        ? 'bg-success'
        : level === 'online'
          ? 'bg-warning'
          : 'bg-muted-foreground'
  const sizeClass = size === 'small' ? 'h-1.5 w-1.5' : 'h-2 w-2'
  return <div className={`${sizeClass} ${cls} ring-2 ring-background`} />
}

export interface ServerVoiceHeaderProps {
  server: Server
  groupChat: { id: string }
  identity: { user_id: string; display_name?: string } | null
  profile: { avatar_data_url?: string | null }
  voiceParticipants: string[]
  webrtcIsInVoice: boolean
  currentRoomId: string | null
  getMemberLevel: (signingPubkey: string, userId: string, isInVoiceForUser: boolean) => PresenceLevel
  isUserInVoice: (userId: string) => boolean
  isUserSpeaking: (userId: string) => boolean
  getRemoteUserPrefs: (userId: string) => { muted: boolean }
  getProfile: (userId: string) => { avatar_data_url?: string | null } | null | undefined
  getInitials: (name: string) => string
  avatarStyleForUser: (userId: string) => React.CSSProperties
  onProfileClick: (userId: string, element: HTMLElement) => void
  onVoiceVolumeMenu: (userId: string, displayName: string, x: number, y: number) => void
  onJoinVoice: () => void
  onLeaveVoice: () => void
}

function ServerVoiceHeaderImpl({
  server,
  groupChat,
  identity,
  profile,
  voiceParticipants,
  webrtcIsInVoice,
  currentRoomId,
  getMemberLevel,
  isUserInVoice,
  isUserSpeaking,
  getRemoteUserPrefs,
  getProfile,
  getInitials,
  avatarStyleForUser,
  onProfileClick,
  onVoiceVolumeMenu,
  onJoinVoice,
  onLeaveVoice,
}: ServerVoiceHeaderProps) {
  const allParticipants =
    identity && webrtcIsInVoice && currentRoomId === groupChat.id && !voiceParticipants.includes(identity.user_id)
      ? [identity.user_id, ...voiceParticipants]
      : voiceParticipants

  if (allParticipants.length === 0) {
    return (
      <div className="border-b-2 border-border p-4 overflow-visible">
        <div className="flex items-center justify-between gap-3 min-h-9">
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-visible" />
          <Button
            variant={webrtcIsInVoice && currentRoomId === groupChat.id ? 'default' : 'outline'}
            size="sm"
            className="h-9 font-light gap-2 shrink-0"
            onClick={webrtcIsInVoice && currentRoomId === groupChat.id ? onLeaveVoice : onJoinVoice}
          >
            {webrtcIsInVoice && currentRoomId === groupChat.id ? (
              <>
                <PhoneOff className="h-4 w-4" />
                Leave voice
              </>
            ) : (
              <>
                <Phone className="h-4 w-4" />
                Join voice
              </>
            )}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="border-b-2 border-border p-4 overflow-visible">
      <div className="flex items-center justify-between gap-3 min-h-9">
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-visible">
          {allParticipants.map((userId) => {
            const member = (server.members ?? []).find((m) => m.user_id === userId)
            const displayName =
              member?.display_name ||
              (userId === identity?.user_id ? identity?.display_name : `User ${userId.slice(0, 8)}`)
            const isSpeaking = isUserSpeaking(userId)
            const level = getMemberLevel(server.signing_pubkey, userId, isUserInVoice(userId))
            const voiceRp = userId === identity?.user_id ? null : getProfile(userId)
            const voiceAvatarUrl = userId === identity?.user_id ? profile.avatar_data_url : voiceRp?.avatar_data_url
            const isRemote = userId !== identity?.user_id
            const prefs = getRemoteUserPrefs(userId)
            return (
              <button
                key={userId}
                type="button"
                className={cn(
                  'relative h-6 w-6 shrink-0 grid place-items-center rounded-none ring-2 will-change-transform transition-all duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06] focus:outline-none overflow-visible',
                  isSpeaking ? 'ring-green-500' : 'ring-background'
                )}
                style={!voiceAvatarUrl ? avatarStyleForUser(userId) : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  onProfileClick(userId, e.currentTarget)
                }}
                onContextMenu={
                  isRemote
                    ? (e) => {
                        e.preventDefault()
                        onVoiceVolumeMenu(userId, displayName ?? '', e.clientX, e.clientY)
                      }
                    : undefined
                }
                aria-label={displayName ?? ''}
                title={isRemote ? `${displayName} — Right-click for volume` : `${displayName} (you)`}
              >
                {voiceAvatarUrl ? (
                  <img src={voiceAvatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[9px] font-mono tracking-wider">{getInitials(displayName ?? '')}</span>
                )}
                <div className="absolute -top-1 left-1/2 -translate-x-1/2">
                  <PresenceSquare level={level} />
                </div>
                {isRemote && prefs.muted && (
                  <div className="absolute inset-0 grid place-items-center bg-black/50" aria-hidden>
                    <VolumeX className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>
            )
          })}
        </div>
        <Button
          variant={webrtcIsInVoice && currentRoomId === groupChat.id ? 'default' : 'outline'}
          size="sm"
          className="h-9 font-light gap-2 shrink-0"
          onClick={webrtcIsInVoice && currentRoomId === groupChat.id ? onLeaveVoice : onJoinVoice}
        >
          {webrtcIsInVoice && currentRoomId === groupChat.id ? (
            <>
              <PhoneOff className="h-4 w-4" />
              Leave voice
            </>
          ) : (
            <>
              <Phone className="h-4 w-4" />
              Join voice
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

export const ServerVoiceHeader = memo(ServerVoiceHeaderImpl)
