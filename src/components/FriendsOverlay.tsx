import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { X, LogIn, Search } from 'lucide-react'
import { Button } from './ui/button'
import { useWindowSize } from '../lib/useWindowSize'
import { useFriends } from '../contexts/FriendsContext'
import { usePresence, type PresenceLevel } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useServers } from '../contexts/ServersContext'
import { useNavigate } from 'react-router-dom'
import type { Server } from '../lib/tauri'

const FRIENDS_PRESENCE_KEY = '_friends'
const PRESENCE_ORDER: Record<PresenceLevel, number> = {
  in_call: 0,
  active: 1,
  online: 2,
  offline: 3,
}

type FriendsOverlayProps = {
  isOpen: boolean
  onClose: () => void
  onOpenProfile: (userId: string, rect: DOMRect) => void
  getServerById: (id: string) => Server | undefined
}

export function FriendsOverlay({ isOpen, onClose, onOpenProfile, getServerById }: FriendsOverlayProps) {
  const { width } = useWindowSize()
  const navigate = useNavigate()
  const isFullscreen = width < 540
  const [search, setSearch] = useState('')

  const { friends } = useFriends()
  const { getLevel } = usePresence()
  const voicePresence = useVoicePresence()
  const remoteProfiles = useRemoteProfiles()
  const { servers } = useServers()

  const sortedFriendsWithPresence = useMemo(() => {
    const result = friends
      .map((userId) => {
        let bestLevel: PresenceLevel = 'offline'
        let activeServer: Server | null = null
        for (const server of servers) {
          const inVoice = voicePresence.isUserInVoice(server.signing_pubkey, userId)
          const level = getLevel(server.signing_pubkey, userId, inVoice)
          if (PRESENCE_ORDER[level] < PRESENCE_ORDER[bestLevel]) {
            bestLevel = level
            if (level === 'active' || level === 'in_call') activeServer = server
          } else if ((level === 'active' || level === 'in_call') && !activeServer) {
            activeServer = server
          }
        }
        const friendsLevel = getLevel(FRIENDS_PRESENCE_KEY, userId, false)
        if (PRESENCE_ORDER[friendsLevel] < PRESENCE_ORDER[bestLevel]) {
          bestLevel = friendsLevel
          activeServer = null
        }
        const displayName =
          remoteProfiles.getProfile(userId)?.display_name ??
          (() => {
            for (const s of servers) {
              const m = s.members.find((mm) => mm.user_id === userId)
              if (m?.display_name) return m.display_name
            }
            return remoteProfiles.hydrated ? 'Unknown' : ''
          })()
        return { userId, bestLevel, activeServer, displayName }
      })
      .sort((a, b) => {
        const oa = PRESENCE_ORDER[a.bestLevel]
        const ob = PRESENCE_ORDER[b.bestLevel]
        if (oa !== ob) return oa - ob
        return a.displayName.localeCompare(b.displayName)
      })
    return result
  }, [friends, servers, getLevel, voicePresence, remoteProfiles])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sortedFriendsWithPresence
    return sortedFriendsWithPresence.filter((f) => f.displayName.toLowerCase().includes(q))
  }, [sortedFriendsWithPresence, search])

  const playing = useMemo(() => filtered.filter((f) => f.bestLevel === 'in_call'), [filtered])
  const online = useMemo(
    () => filtered.filter((f) => f.bestLevel === 'active' || f.bestLevel === 'online'),
    [filtered]
  )
  const offline = useMemo(() => filtered.filter((f) => f.bestLevel === 'offline'), [filtered])

  useEffect(() => {
    if (!isOpen) return
    setSearch('')
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

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

  const renderRow = ({
    userId,
    bestLevel,
    activeServer,
    displayName,
  }: {
    userId: string
    bestLevel: PresenceLevel
    activeServer: Server | null
    displayName: string
  }) => {
    const rp = remoteProfiles.getProfile(userId)
    const secondaryName = rp?.show_secondary ? rp.secondary_name : null
    const canJoin = activeServer && getServerById(activeServer.id)
    return (
      <div
        key={userId}
        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent/40 min-w-0"
      >
        <button
          type="button"
          className="relative h-10 w-10 shrink-0 grid place-items-center rounded-none ring-2 ring-background focus:outline-none overflow-hidden"
          style={!rp?.avatar_data_url ? avatarStyleForUser(userId) : undefined}
          onClick={(e) => {
            e.stopPropagation()
            onOpenProfile(userId, (e.currentTarget as HTMLElement).getBoundingClientRect())
          }}
          aria-label={displayName}
        >
          {rp?.avatar_data_url ? (
            <img src={rp.avatar_data_url} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-xs font-mono tracking-wider">{getInitials(displayName)}</span>
          )}
          <div className="absolute -top-0.5 right-0">
            {bestLevel === 'in_call' ? (
              <div className="h-2.5 w-2.5 bg-blue-500 ring-2 ring-background rounded-full" />
            ) : bestLevel === 'active' ? (
              <div className="h-2.5 w-2.5 bg-green-500 ring-2 ring-background rounded-full" />
            ) : bestLevel === 'online' ? (
              <div className="h-2.5 w-2.5 bg-amber-500 ring-2 ring-background rounded-full" />
            ) : (
              <div className="h-2.5 w-2.5 bg-muted-foreground ring-2 ring-background rounded-full" />
            )}
          </div>
        </button>
        <div className="min-w-0 flex-1 flex flex-col justify-center">
          <p className="text-sm font-medium truncate">{displayName}</p>
          {activeServer ? (
            <p className="text-xs text-muted-foreground truncate">{activeServer.name}</p>
          ) : secondaryName ? (
            <p className="text-xs text-muted-foreground truncate">{secondaryName}</p>
          ) : bestLevel === 'offline' ? (
            <p className="text-xs text-muted-foreground">Offline</p>
          ) : null}
        </div>
        {canJoin && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-xs font-light"
            onClick={() => navigate(`/home/${activeServer!.id}`, { state: { server: activeServer } })}
            title={'Join ' + activeServer!.name}
          >
            <LogIn className="h-3.5 w-3.5 mr-1" />
            Join
          </Button>
        )}
      </div>
    )
  }

  const Section = ({
    title,
    list,
  }: {
    title: string
    list: { userId: string; bestLevel: PresenceLevel; activeServer: Server | null; displayName: string }[]
  }) =>
    list.length > 0 ? (
      <div className="shrink-0">
        <h3 className="text-[11px] font-medium tracking-wider uppercase text-muted-foreground px-3 pt-4 pb-1">
          {title}
        </h3>
        <div className="space-y-0.5">
          {list.map((f) => renderRow(f))}
        </div>
      </div>
    ) : null

  const onlineCount = sortedFriendsWithPresence.filter((f) => f.bestLevel !== 'offline').length

  return (
    <div className="absolute top-8 left-0 right-0 bottom-0 z-[60]">
      <div className="absolute inset-0 bg-background/75 backdrop-blur-sm" onMouseDown={onClose} />

      <div
        className={`absolute border-2 border-border bg-card/95 backdrop-blur-md shadow-2xl flex flex-col overflow-hidden ${
          isFullscreen
            ? 'inset-0 rounded-none'
            : 'left-1/2 top-1/2 w-[min(520px,calc(100vw-3rem))] h-[min(560px,calc(100vh-8rem))] max-h-[calc(100%-1rem)] -translate-x-1/2 -translate-y-1/2 rounded-none'
        }`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="h-14 shrink-0 border-b-2 border-border px-4 flex items-center">
          <Button variant="ghost" size="icon" className="h-8 w-8 mr-2" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
          <div className="w-px h-6 bg-foreground/20 mr-3" />
          <h1 className="text-sm font-light tracking-wider uppercase">Friends</h1>
        </header>

        <div className="p-3 border-b border-border/70">
          <p className="text-xs text-muted-foreground font-medium mb-2">
            Your friends {onlineCount} / {friends.length}
          </p>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search friends by name"
              className="w-full pl-8 pr-3 py-2 bg-background border border-border rounded-md text-sm font-light focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground text-center">
              {search.trim() ? 'No friends match your search.' : 'No friends yet.'}
            </p>
          ) : (
            <>
              <Section title="In a server / in call" list={playing} />
              <Section title="Online" list={online} />
              <Section title="Offline" list={offline} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
