import { useNavigate } from 'react-router-dom'
import { Plus, Users, Trash2, Star, CornerDownLeft, Copy, X, Check, XCircle, LogIn } from 'lucide-react'
import { Button } from '../components/ui/button'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSignaling } from '../contexts/SignalingContext'
import { SignalingStatus } from '../components/SignalingStatus'
import { UserProfileCard } from '../components/UserProfileCard'
import { createServer, deleteServer, type Server, parseInviteUri, publishServerHintOpaque, publishServerHintMemberLeft, redeemTemporaryInvite } from '../lib/tauri'
import { useIdentity } from '../contexts/IdentityContext'
import { usePresence, type PresenceLevel } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useActiveServer } from '../contexts/ActiveServerContext'
import { useWebRTC } from '../contexts/WebRTCContext'
import { useAccount } from '../contexts/AccountContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useServers } from '../contexts/ServersContext'
import { useFriends } from '../contexts/FriendsContext'

function ServerListPage() {
  const navigate = useNavigate()
  const { identity } = useIdentity()
  const { currentAccountId, accountInfoMap } = useAccount()
  const { getLevel } = usePresence()
  const { signalingUrl, status: signalingStatus } = useSignaling()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const { servers, refreshServers, getServerById } = useServers()
  const voicePresence = useVoicePresence()
  const {
    friends,
    removeFriend,
    isFriend,
    hasPendingOutgoing,
    sendFriendRequest,
    pendingIncoming,
    pendingOutgoing,
    redemptions,
    acceptFriendRequest,
    declineFriendRequest,
    acceptCodeRedemption,
    declineCodeRedemption,
    createFriendCode,
    revokeFriendCode,
    redeemFriendCode,
    myFriendCode,
  } = useFriends()
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Server | null>(null)
  const [serverName, setServerName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [joinError, setJoinError] = useState('')
  const [showJoinInline, setShowJoinInline] = useState(false)
  const [showCreateInline, setShowCreateInline] = useState(false)
  const joinInputRef = useRef<HTMLInputElement | null>(null)
  const createInputRef = useRef<HTMLInputElement | null>(null)
  const [favoriteServerIds, setFavoriteServerIds] = useState<Set<string>>(new Set())
  const [profileCardUserId, setProfileCardUserId] = useState<string | null>(null)
  const [profileCardAnchor, setProfileCardAnchor] = useState<DOMRect | null>(null)
  const [showFriendCodePopover, setShowFriendCodePopover] = useState(false)
  const [friendCodeInput, setFriendCodeInput] = useState('')
  const [friendCodeError, setFriendCodeError] = useState('')
  const [isRedeemingCode, setIsRedeemingCode] = useState(false)
  const [isCreatingCode, setIsCreatingCode] = useState(false)
  const [hoveredServerId, setHoveredServerId] = useState<string | null>(null)
  const [exitingServerId, setExitingServerId] = useState<string | null>(null)
  const exitIconsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fallbackNameForUser = (userId: string) => {
    for (const s of servers) {
      const m = s.members.find(mm => mm.user_id === userId)
      if (m?.display_name) return m.display_name
    }
    return 'Unknown'
  }

  // Servers are now managed by ServersContext, no need to load here

  useEffect(() => {
    return () => {
      if (exitIconsTimeoutRef.current) {
        clearTimeout(exitIconsTimeoutRef.current)
        exitIconsTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (showJoinInline) {
      // Small delay lets the input mount before focusing
      setTimeout(() => joinInputRef.current?.focus(), 0)
    }
  }, [showJoinInline])

  useEffect(() => {
    if (showCreateInline) {
      setTimeout(() => createInputRef.current?.focus(), 0)
    }
  }, [showCreateInline])

  const favoritesStorageKey = `rmmt:favorites:${currentAccountId || 'unknown'}`

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(favoritesStorageKey)
      if (!raw) {
        setFavoriteServerIds(new Set())
        return
      }
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        setFavoriteServerIds(new Set(parsed.filter((x) => typeof x === 'string')))
      } else {
        setFavoriteServerIds(new Set())
      }
    } catch {
      setFavoriteServerIds(new Set())
    }
  }, [favoritesStorageKey])

  const persistFavorites = (next: Set<string>) => {
    try {
      window.localStorage.setItem(favoritesStorageKey, JSON.stringify(Array.from(next)))
    } catch {
      // ignore
    }
  }

  const toggleFavorite = (serverId: string) => {
    setFavoriteServerIds((prev) => {
      const next = new Set(prev)
      if (next.has(serverId)) next.delete(serverId)
      else next.add(serverId)
      persistFavorites(next)
      return next
    })
  }

  // Presence: "Home" (not active in a specific server)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('cordia:active-server-changed', { detail: { signing_pubkey: null } }))
  }, [])

  const getInitials = (name: string) => {
    const cleaned = name.trim()
    if (!cleaned) return '?'
    const parts = cleaned.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }

  const hashId = (s: string) => {
    let hash = 0
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
    return hash
  }

  const avatarStyleForUser = (userId: string): CSSProperties => {
    // Deterministic pastel color using full hue space → minimal collisions and a softer aesthetic.
    const h = hashId(userId) % 360
    return {
      backgroundColor: `hsl(${h} 60% 78%)`,
      color: `hsl(${h} 35% 25%)`,
    }
  }

  const FRIENDS_PRESENCE_KEY = '_friends'
  const PRESENCE_ORDER: Record<PresenceLevel, number> = {
    in_call: 0,
    active: 1,
    online: 2,
    offline: 3,
  }

  const MemberStack = ({ server }: { server: Server }) => {
    const voicePresence = useVoicePresence()
    const { activeSigningPubkey } = useActiveServer()
    const { isInVoice } = useWebRTC()
    const { status: signalingStatus } = useSignaling()
    const avatarPx = 28 // h-7/w-7
    const stepPx = 19    // overlap step (smaller = more overlap)
    const overflowBlockPx = 28 // +N pill same width as avatar
    const separatorWidthPx = 24 // gap + bar between online and offline

    const wrapperRef = useRef<HTMLDivElement>(null)
    const [availableWidthPx, setAvailableWidthPx] = useState(0)

    // Current user's presence from local state (instant); others from server (PresenceContext)
    const getMemberLevel = (m: { user_id: string }): PresenceLevel => {
      if (identity?.user_id && m.user_id === identity.user_id) {
        const signalingConnected = signalingStatus === 'connected'
        if (!signalingConnected) return 'offline'
        if (isInVoice) return 'in_call'
        if (activeSigningPubkey === server.signing_pubkey) return 'active'
        return 'online'
      }
      return getLevel(server.signing_pubkey, m.user_id, voicePresence.isUserInVoice(server.signing_pubkey, m.user_id))
    }

    const sortedMembers = useMemo(() => {
      const total = server.members.length
      if (total === 0) return []
      const withLevel = server.members.map((m, index) => ({
        member: m,
        level: getMemberLevel(m),
        index,
      }))
      withLevel.sort((a, b) => {
        const oa = PRESENCE_ORDER[a.level]
        const ob = PRESENCE_ORDER[b.level]
        if (oa !== ob) return oa - ob
        return a.index - b.index
      })
      return withLevel.map((x) => x.member)
    }, [server.members, server.signing_pubkey, getLevel, voicePresence, identity?.user_id, signalingStatus, activeSigningPubkey, isInVoice])

    const offlineStartIndex = useMemo(() => {
      return sortedMembers.findIndex((m) => getMemberLevel(m) === 'offline')
    }, [sortedMembers, server.signing_pubkey, getLevel, voicePresence, identity?.user_id, signalingStatus, activeSigningPubkey, isInVoice])

    const hasSeparatorInFullList = offlineStartIndex > 0 && offlineStartIndex < sortedMembers.length

    const { visibleCount, extraCount } = useMemo(() => {
      const total = sortedMembers.length
      if (total === 0) return { visibleCount: 0, extraCount: 0 }
      if (availableWidthPx <= 0) {
        const n = Math.min(6, total)
        return { visibleCount: n, extraCount: total - n }
      }
      const sepPx = hasSeparatorInFullList ? separatorWidthPx : 0
      let n = total
      for (; n >= 1; n--) {
        const needPx = avatarPx + (n - 1) * stepPx + (n < total ? overflowBlockPx : 0) + sepPx
        if (needPx <= availableWidthPx) break
      }
      const visibleCount = n < 1 ? 1 : n
      return { visibleCount, extraCount: total - visibleCount }
    }, [sortedMembers.length, availableWidthPx, avatarPx, stepPx, overflowBlockPx, hasSeparatorInFullList, separatorWidthPx])

    const visible = sortedMembers.slice(0, visibleCount)
    const offlineStartInVisible = visible.findIndex((m) => getMemberLevel(m) === 'offline')
    const hasSeparatorInVisible =
      offlineStartInVisible >= 0 && offlineStartInVisible < visible.length
    const itemCount = visible.length + (extraCount > 0 ? 1 : 0)
    const widthPx =
      itemCount > 0
        ? avatarPx + (itemCount - 1) * stepPx + (hasSeparatorInVisible ? separatorWidthPx : 0)
        : avatarPx

    useEffect(() => {
      const el = wrapperRef.current
      if (!el) return
      const ro = new ResizeObserver(() => {
        const w = el.clientWidth
        setAvailableWidthPx((prev) => (w > 0 ? w : prev))
      })
      ro.observe(el)
      if (el.clientWidth > 0) setAvailableWidthPx(el.clientWidth)
      return () => ro.disconnect()
    }, [])

    const PresenceMark = ({ level }: { level: 'active' | 'online' | 'offline' | 'in_call' }) => {
      return (
        <div className="absolute -top-1 left-1/2 -translate-x-1/2">
          {level === 'in_call' ? (
            <div className="h-2 w-2 bg-blue-500 ring-2 ring-background" />
          ) : level === 'active' ? (
            <div className="h-2 w-2 bg-green-500 ring-2 ring-background" />
          ) : level === 'online' ? (
            <div className="h-2 w-2 bg-amber-500 ring-2 ring-background" />
          ) : (
            <div className="h-2 w-2 bg-muted-foreground ring-2 ring-background" />
          )}
        </div>
      )
    }

    const resolveProfile = (userId: string, fallbackName: string) => {
      const isSelf = Boolean(identity?.user_id && identity.user_id === userId)
      if (isSelf) {
        const displayName = profile.display_name ?? identity?.display_name ?? fallbackName
        const secondaryName = profile.show_real_name ? profile.real_name : null
        return { displayName, secondaryName, avatarDataUrl: profile.avatar_data_url }
      }
      const rp = remoteProfiles.getProfile(userId)
      return {
        displayName: rp?.display_name || fallbackName,
        secondaryName: rp?.show_secondary ? rp.secondary_name : null,
        avatarDataUrl: null,
      }
    }

    return (
      <div
        ref={wrapperRef}
        className="w-full min-w-0 flex items-center"
      >
        <div
          className="relative h-7 isolation-isolate shrink-0"
          style={{ width: widthPx }}
        >
        {(() => {
          const renderAvatar = (m: (typeof visible)[0], _i: number, leftPx: number, z: number) => {
            const level = getMemberLevel(m)
            const p = resolveProfile(m.user_id, m.display_name)
            return (
              <div
                key={m.user_id}
                className="absolute top-0 z-[var(--z)] hover:z-50"
                style={{ left: leftPx, ['--z' as any]: z }}
              >
                <div className="relative">
                  <button
                    type="button"
                    className="relative h-7 w-7 grid place-items-center rounded-none ring-2 ring-background will-change-transform transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06] focus:outline-none group/avatar"
                    style={!p.avatarDataUrl ? avatarStyleForUser(m.user_id) : undefined}
                    onClick={(e) => {
                      e.stopPropagation()
                      setProfileCardUserId(m.user_id)
                      setProfileCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
                    }}
                    aria-label={p.displayName}
                  >
                    {p.avatarDataUrl ? (
                      <div className="absolute inset-0 overflow-hidden">
                        <img src={p.avatarDataUrl} alt={p.displayName} className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <span className="text-[10px] font-mono tracking-wider">{getInitials(p.displayName)}</span>
                    )}
                    <PresenceMark level={level} />
                  </button>

                  {/* Tooltip */}
                  <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-popover border-2 border-border rounded-md shadow-lg opacity-0 invisible group-hover/avatar:opacity-100 group-hover/avatar:visible transition-all duration-200 pointer-events-none whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      {level === 'active' ? (
                        <div className="h-2 w-2 bg-green-500" />
                      ) : level === 'online' ? (
                        <div className="h-2 w-2 bg-amber-500" />
                      ) : (
                        <div className="h-2 w-2 bg-muted-foreground" />
                      )}
                      <div className="leading-tight">
                        <p className="text-xs font-light">{p.displayName}</p>
                        {p.secondaryName ? (
                          <p className="text-[11px] text-muted-foreground font-light">{p.secondaryName}</p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          }

          if (hasSeparatorInVisible) {
            const onlineSegment = visible.slice(0, offlineStartInVisible)
            const offlineSegment = visible.slice(offlineStartInVisible)
            return (
              <>
                {onlineSegment.map((m, i) => renderAvatar(m, i, i * stepPx, i))}
                <div
                  key="offline-sep"
                  className="absolute top-0 flex h-7 items-center"
                  style={{
                    left: offlineStartInVisible * stepPx,
                    width: separatorWidthPx,
                    // Center the bar in the visual gap: last online ends at (n-1)*stepPx+avatarPx, first offline starts at n*stepPx+sepWidth
                    marginLeft: (avatarPx - stepPx) + (stepPx + separatorWidthPx - avatarPx) / 2 - 0.5,
                  }}
                  aria-hidden
                >
                  <div className="h-4 w-px shrink-0 bg-muted-foreground/80" aria-hidden />
                </div>
                {offlineSegment.map((m, j) =>
                  renderAvatar(m, j, offlineStartInVisible * stepPx + separatorWidthPx + j * stepPx, offlineStartInVisible + j)
                )}
              </>
            )
          }

          return visible.map((m, i) => renderAvatar(m, i, i * stepPx, i))
        })()}

        {extraCount > 0 && (
          <div
            className="absolute top-0 z-[var(--z)] hover:z-50"
            style={{
              left: hasSeparatorInVisible
                ? offlineStartInVisible * stepPx + separatorWidthPx + (visible.length - offlineStartInVisible) * stepPx
                : visible.length * stepPx,
              ['--z' as any]: visible.length,
            }}
            title={`${extraCount} more`}
          >
            <div className="relative group/avatar">
              <div className="h-7 w-7 grid place-items-center rounded-none text-[10px] font-mono text-muted-foreground bg-muted ring-2 ring-background will-change-transform transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06]">
                +{extraCount}
              </div>
              <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-popover border-2 border-border rounded-md shadow-lg opacity-0 invisible group-hover/avatar:opacity-100 group-hover/avatar:visible transition-all duration-200 pointer-events-none whitespace-nowrap">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 bg-muted-foreground" />
                  <p className="text-xs font-light">{extraCount} more</p>
                </div>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    )
  }


  const sortedServers = [...servers].sort((a, b) => {
    const af = favoriteServerIds.has(a.id) ? 1 : 0
    const bf = favoriteServerIds.has(b.id) ? 1 : 0
    if (af !== bf) return bf - af
    // Stable-ish: fall back to name for deterministic order
    return a.name.localeCompare(b.name)
  })

  const friendAndPendingIds = useMemo(() => {
    const set = new Set(friends)
    pendingOutgoing.forEach((id) => set.add(id))
    return Array.from(set)
  }, [friends, pendingOutgoing])

  // Merge incoming requests and code redemptions by user_id so the same user doesn't appear twice
  const mergedIncoming = useMemo(() => {
    const byId = new Map<
      string,
      { userId: string; displayName: string; fromRequest: boolean; fromRedemption: boolean }
    >()
    for (const r of pendingIncoming) {
      byId.set(r.from_user_id, {
        userId: r.from_user_id,
        displayName:
          remoteProfiles.getProfile(r.from_user_id)?.display_name ?? r.from_display_name ?? 'Unknown',
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
          'Unknown',
        fromRequest: existing?.fromRequest ?? false,
        fromRedemption: true,
      })
    }
    return Array.from(byId.values())
  }, [pendingIncoming, redemptions, remoteProfiles])

  const sortedFriendsWithPresence = useMemo(() => {
    return friendAndPendingIds
      .map(userId => {
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
        const displayName = remoteProfiles.getProfile(userId)?.display_name ?? (() => {
          for (const s of servers) {
            const m = s.members.find(mm => mm.user_id === userId)
            if (m?.display_name) return m.display_name
          }
          return 'Unknown'
        })()
        return { userId, bestLevel, activeServer, displayName }
      })
      .sort((a, b) => {
        const oa = PRESENCE_ORDER[a.bestLevel]
        const ob = PRESENCE_ORDER[b.bestLevel]
        if (oa !== ob) return oa - ob
        return a.displayName.localeCompare(b.displayName)
      })
  }, [friendAndPendingIds, servers, getLevel, voicePresence, remoteProfiles])

  const handleCreateServer = async () => {
    if (!identity || !serverName.trim()) return

    setIsCreating(true)
    try {
      const newServer = await createServer(
        serverName.trim(),
        identity.user_id,
        identity.display_name
      )

      if (signalingStatus === 'connected' && signalingUrl) {
        publishServerHintOpaque(signalingUrl, newServer.id).catch(e => console.warn('Failed to publish server hint:', e))
      }

      await refreshServers()
      // Let WS-based bootstraps (presence + hint subscriptions) know a new server exists.
      window.dispatchEvent(new Event('cordia:servers-updated'))
      setShowCreateDialog(false)
      setShowCreateInline(false)
      setServerName('')
      navigate(`/home/${newServer.id}`, { state: { server: newServer } })
    } catch (error) {
      console.error('Failed to create server:', error)
    } finally {
      setIsCreating(false)
    }
  }

  const handleJoinServer = async () => {
    if (!identity || !inviteCode.trim()) return

    const input = inviteCode.trim()
    setJoinError('')
    setIsCreating(true)

    try {
      let signalingServer = signalingUrl || ''
      let inviteCode: string | null = null

      if (/^rmmt:\/\//i.test(input)) {
        const parsed = parseInviteUri(input)
        if (!parsed) {
          setJoinError('Invalid invite. Paste the full invite link (cordia://...).')
          return
        }

        signalingServer =
          parsed.server.startsWith('ws://') || parsed.server.startsWith('wss://')
            ? parsed.server
            : `wss://${parsed.server}`
        // Temporary invites use cordia://{code}@{server}
        inviteCode = parsed.signingPubkey
      } else {
        if (!signalingServer) {
          setJoinError('No beacon configured.')
          return
        }
        inviteCode = input
      }

      // If we have an invite code, redeem it (this imports server + keys and joins locally)
      if (inviteCode) {
        const updatedServer = await redeemTemporaryInvite(signalingServer, inviteCode, identity.user_id, identity.display_name)

        await refreshServers()
        // Let WS-based bootstraps (presence + hint subscriptions) know a new server exists.
        window.dispatchEvent(new Event('cordia:servers-updated'))
        setShowJoinInline(false)
        setInviteCode('')
        setJoinError('')
        navigate(`/home/${updatedServer.id}`, { state: { server: updatedServer } })
        return
      }
    } catch (error) {
      console.error('Failed to join server:', error)
      setJoinError('Failed to join server. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }

  const handleDeleteServer = (e: React.MouseEvent, serverId: string) => {
    e.stopPropagation()
    const target = servers.find(s => s.id === serverId) || null
    setDeleteTarget(target)
  }

  const confirmDeleteServer = async () => {
    if (!deleteTarget) return
    const serverId = deleteTarget.id

    try {
      setIsCreating(true)
      // Stop WS-based re-import immediately (prevents "0 member ghost server" from coming back).
      window.dispatchEvent(
        new CustomEvent('cordia:server-removed', { detail: { signing_pubkey: deleteTarget.signing_pubkey } })
      )

      // Best-effort: advertise leave to other members (requires symmetric key to encrypt hint).
      // If this fails (e.g. server missing key), we still delete locally so the user can always leave.
      if (identity && signalingStatus === 'connected' && signalingUrl) {
        try {
          await publishServerHintMemberLeft(signalingUrl, serverId, identity.user_id)
        } catch (_) {
          // Ignore: allow delete even when we can't notify the beacon (e.g. missing symmetric key).
        }
      }

      await deleteServer(serverId)
      await refreshServers()
      setDeleteTarget(null)
      window.dispatchEvent(new Event('cordia:servers-updated'))
    } catch (error) {
      console.error('Failed to delete server:', error)
      setJoinError('Failed to delete server. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }


  return (
    <div className="h-full bg-background grid-pattern flex flex-col overflow-hidden">
      <header className="border-b-2 border-border shrink-0">
        <div className="w-full flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <div className="w-px h-6 bg-foreground/20"></div>
            <h1 className="text-sm font-light tracking-wider uppercase">Home</h1>
          </div>
          <div className="flex items-center gap-2">
            <SignalingStatus />
          </div>
        </div>
      </header>

      {/* Split-scroll layout: only the houses list scrolls; neighbors stays fixed */}
      {/* NOTE: overflow must be visible so the Join popover can float above this row without being clipped. */}
      <main className="flex-1 overflow-visible min-h-0">
        <div className="p-8 h-full">
          <div className="grid grid-cols-1 md:grid-cols-10 gap-6 items-stretch h-full min-h-0">
            {/* Left: Houses (Neighborhood) */}
            <section className="col-span-1 md:col-span-7 flex flex-col min-h-0 h-full">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-px bg-foreground/20"></div>
                  <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground">Servers</h2>
                </div>
                <div className="relative flex gap-2">
                  <Button
                    onClick={() => {
                      setShowCreateInline(false)
                      setShowJoinInline((v) => !v)
                    }}
                    variant={showJoinInline ? 'outline' : 'default'}
                    size="sm"
                    className="h-9 font-light bg-background text-foreground hover:bg-background/90"
                  >
                    {showJoinInline ? 'Cancel' : 'Join Server'}
                  </Button>
                  <Button
                    onClick={() => {
                      setShowJoinInline(false)
                      setShowCreateInline((v) => !v)
                    }}
                    size="sm"
                    className="bg-foreground text-background hover:bg-foreground/90 h-9 font-light"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {showCreateInline ? 'Cancel' : 'New Server'}
                  </Button>

                  {/* Join popover (does not affect layout) */}
                  {showJoinInline && (
                    <div className="absolute right-0 bottom-full mb-2 z-50 w-[200px] max-w-[calc(100vw-4rem)]">
                      <div className="border-2 border-border bg-card/80 backdrop-blur-sm rounded-lg p-2 shadow-lg">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 px-2 py-1.5 bg-background border border-border rounded-md">
                            <input
                              ref={joinInputRef}
                              type="text"
                              value={inviteCode}
                              onChange={(e) => {
                                setInviteCode(e.target.value)
                                setJoinError('')
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isCreating) {
                                  handleJoinServer()
                                } else if (e.key === 'Escape') {
                                  setShowJoinInline(false)
                                  setInviteCode('')
                                  setJoinError('')
                                }
                              }}
                              placeholder="Invite code"
                              className="w-full bg-transparent outline-none text-[11px] font-mono tracking-wider"
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>
                          <Button
                            onClick={handleJoinServer}
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            disabled={isCreating || !inviteCode.trim()}
                            title="Join"
                          >
                            <CornerDownLeft className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {joinError && <p className="text-xs text-red-500">{joinError}</p>}
                      </div>
                    </div>
                  )}

                  {/* New Server popover (inverse styling, does not affect layout) */}
                  {showCreateInline && (
                    <div className="absolute right-0 bottom-full mb-2 z-50 w-[200px] max-w-[calc(100vw-4rem)]">
                      <div className="border-2 border-background/20 bg-foreground text-background rounded-lg p-2 shadow-lg">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 px-2 py-1.5 bg-background/10 border border-background/20 rounded-md">
                            <input
                              ref={createInputRef}
                              type="text"
                              value={serverName}
                              onChange={(e) => setServerName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isCreating) {
                                  handleCreateServer()
                                } else if (e.key === 'Escape') {
                                  setShowCreateInline(false)
                                  setServerName('')
                                }
                              }}
                              placeholder="Server name"
                              maxLength={40}
                              className="w-full bg-transparent outline-none text-[11px] font-mono tracking-wider text-background placeholder:text-background/60"
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={handleCreateServer}
                            disabled={isCreating || !serverName.trim()}
                            className="h-8 w-8 shrink-0 grid place-items-center border border-background/20 bg-background/10 hover:bg-background/20 disabled:opacity-50"
                            title="Create"
                          >
                            <CornerDownLeft className="h-3.5 w-3.5 text-background" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Servers list (scrolls) */}
              <div className="mt-6 flex-1 min-h-0 overflow-y-auto pr-1">
                {servers.length === 0 ? (
                  <div className="border-2 border-border bg-card/50 rounded-lg p-8">
                    <div className="max-w-md space-y-4">
                      <h3 className="text-2xl font-light tracking-tight">No servers yet</h3>
                      <p className="text-muted-foreground text-sm leading-relaxed font-light">
                        Create or join a server to start voice chatting with your members.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-4 pb-2 min-w-0">
                    {sortedServers.map((server) => (
                      (() => {
                        const isFav = favoriteServerIds.has(server.id)
                        const cardBorder = isFav ? 'border-amber-500/70' : 'border-border'
                        return (
                      <div key={server.id} className="relative group/card min-w-0">
                        <div
                          onClick={() => navigate(`/home/${server.id}`, { state: { server } })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              navigate(`/home/${server.id}`, { state: { server } })
                            }
                          }}
                          onMouseEnter={() => {
                            if (exitIconsTimeoutRef.current) {
                              clearTimeout(exitIconsTimeoutRef.current)
                              exitIconsTimeoutRef.current = null
                            }
                            setExitingServerId(null)
                            setHoveredServerId(server.id)
                          }}
                          onMouseLeave={() => {
                            const wasHovered = hoveredServerId === server.id
                            setHoveredServerId(null)
                            if (wasHovered) {
                              setExitingServerId(server.id)
                              exitIconsTimeoutRef.current = setTimeout(() => {
                                exitIconsTimeoutRef.current = null
                                setExitingServerId(null)
                              }, 200)
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          className={`w-full p-6 border-2 ${cardBorder} bg-card hover:bg-accent/50 transition-colors text-left rounded-lg min-w-0 overflow-hidden`}
                        >
                          <div className="relative flex items-center justify-between gap-6 min-w-0">
                            <div className="space-y-2 min-w-0 flex-1">
                              <h3 className="text-lg font-light tracking-tight truncate">{server.name}</h3>
                              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {server.members.length} {server.members.length === 1 ? 'member' : 'members'}
                                </span>
                                <span>{server.chats.length} {server.chats.length === 1 ? 'chat' : 'chats'}</span>
                              </div>
                              {server.members.length > 0 && (
                                <div className="pt-1 min-w-0">
                                  <MemberStack server={server} />
                                </div>
                              )}
                            </div>
                            <div
                              className={`flex flex-col items-center justify-center gap-2 shrink-0 transition-opacity duration-200 ${
                                hoveredServerId === server.id
                                  ? 'opacity-100'
                                  : exitingServerId === server.id
                                    ? 'opacity-0 pointer-events-none'
                                    : 'absolute right-6 top-6 opacity-0 pointer-events-none'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleFavorite(server.id)
                                }}
                                className={`h-9 w-9 grid place-items-center rounded-md transition-opacity hover:bg-amber-500/10 ${
                                  isFav ? 'text-amber-500' : 'text-muted-foreground hover:text-amber-500'
                                }`}
                                title={isFav ? 'Unfavorite' : 'Favorite'}
                              >
                                <Star className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => handleDeleteServer(e, server.id)}
                                className="h-9 w-9 grid place-items-center rounded-md hover:bg-destructive/20 text-destructive transition-opacity"
                                title="Leave and delete server"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                        )
                      })()
                    ))}
                  </div>
                )}
              </div>
            </section>
            {/* Right: Friends */}
            <aside className="hidden md:block md:col-span-3 h-full min-h-0 flex flex-col">
              <div className="border-2 border-border bg-card/50 rounded-lg p-4 flex flex-col min-h-0 h-full">
                <div className="flex items-center justify-between shrink-0">
                  <h3 className="text-xs font-light tracking-wider uppercase text-muted-foreground">Friends</h3>
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setShowFriendCodePopover((v) => !v)}
                      title="Friend code"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                    {showFriendCodePopover && (
                      <div className="absolute right-0 top-full mt-1 z-50 w-72 border-2 border-border bg-card rounded-lg p-3 shadow-lg space-y-3">
                        {myFriendCode ? (
                          <>
                            <p className="text-xs text-muted-foreground font-light">Your code</p>
                            <div className="flex items-center gap-2">
                              <code className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm font-mono tracking-wider truncate">
                                {myFriendCode}
                              </code>
                              <Button
                                variant="outline"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                onClick={() => {
                                  navigator.clipboard.writeText(myFriendCode ?? '')
                                }}
                                title="Copy"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="outline"
                                size="icon"
                                className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                                onClick={async () => {
                                  await revokeFriendCode()
                                }}
                                title="Revoke"
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start gap-2 font-light"
                            disabled={isCreatingCode}
                            onClick={async () => {
                              setIsCreatingCode(true)
                              try {
                                await createFriendCode()
                              } catch (e) {
                                console.warn(e)
                              } finally {
                                setIsCreatingCode(false)
                              }
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {isCreatingCode ? 'Creating...' : 'Create friend code'}
                          </Button>
                        )}
                        <div className="border-t border-border pt-2">
                          <p className="text-xs text-muted-foreground font-light mb-1">Add by code</p>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={friendCodeInput}
                              onChange={(e) => {
                                setFriendCodeInput(e.target.value.toUpperCase())
                                setFriendCodeError('')
                              }}
                              placeholder="XXXX-XXXX"
                              className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm font-mono tracking-wider uppercase"
                              spellCheck={false}
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isRedeemingCode || !friendCodeInput.trim()}
                              onClick={async () => {
                                setFriendCodeError('')
                                setIsRedeemingCode(true)
                                try {
                                  await redeemFriendCode(
                                    friendCodeInput.trim(),
                                    profile?.display_name ?? identity?.display_name ?? 'Unknown'
                                  )
                                  setFriendCodeInput('')
                                } catch (e) {
                                  setFriendCodeError(e instanceof Error ? e.message : 'Failed')
                                } finally {
                                  setIsRedeemingCode(false)
                                }
                              }}
                            >
                              {isRedeemingCode ? '...' : 'Add'}
                            </Button>
                          </div>
                          {friendCodeError && (
                            <p className="text-xs text-destructive mt-1">{friendCodeError}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => setShowFriendCodePopover(false)}
                        >
                          Close
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
                  {mergedIncoming.length > 0 && (
                    <div>
                      <p className="text-[11px] font-light tracking-wider uppercase text-muted-foreground mb-1">
                        Incoming
                      </p>
                      <div className="space-y-1">
                        {mergedIncoming.map((entry) => (
                          <div
                            key={entry.userId}
                            className="flex items-center gap-2 py-2 px-2 rounded-md bg-accent/20 min-w-0"
                          >
                            <div
                              className="h-8 w-8 shrink-0 grid place-items-center rounded-none ring-2 ring-background"
                              style={avatarStyleForUser(entry.userId)}
                            >
                              <span className="text-[10px] font-mono tracking-wider">
                                {getInitials(entry.displayName)}
                              </span>
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-light truncate">{entry.displayName}</p>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-green-600"
                                title="Accept"
                                onClick={async () => {
                                  // Seed remote profile so friends list shows correct name (for users not in shared servers)
                                  remoteProfiles.applyUpdate({
                                    user_id: entry.userId,
                                    display_name: entry.displayName,
                                    secondary_name: null,
                                    show_secondary: false,
                                    rev: 1,
                                  })
                                  const myDisplayName = identity?.display_name ?? profile?.display_name ?? undefined
                                  if (entry.fromRequest) await acceptFriendRequest(entry.userId, myDisplayName).catch(() => {})
                                  if (entry.fromRedemption) await acceptCodeRedemption(entry.userId, myDisplayName).catch(() => {})
                                }}
                              >
                                <Check className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive"
                                title="Decline"
                                onClick={async () => {
                                  if (entry.fromRequest) await declineFriendRequest(entry.userId).catch(() => {})
                                  if (entry.fromRedemption) await declineCodeRedemption(entry.userId).catch(() => {})
                                }}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {friends.length === 0 && mergedIncoming.length === 0 && pendingOutgoing.length === 0 ? (
                    <p className="text-sm font-light leading-relaxed text-muted-foreground">
                      Add friends from server members: open their profile and choose Send friend request. Or create a
                      friend code to share.
                    </p>
                  ) : (
                    <div className="space-y-0.5">
                      {pendingOutgoing.length > 0 && (
                        <p className="text-[11px] font-light tracking-wider uppercase text-muted-foreground mb-1">
                          Pending
                        </p>
                      )}
                      {(() => {
                        const offlineStartIndex = sortedFriendsWithPresence.findIndex((f) => f.bestLevel === 'offline')
                        const hasOfflineSep = offlineStartIndex > 0 && offlineStartIndex < sortedFriendsWithPresence.length
                        const onlineFriends = hasOfflineSep
                          ? sortedFriendsWithPresence.slice(0, offlineStartIndex)
                          : sortedFriendsWithPresence
                        const offlineFriends = hasOfflineSep ? sortedFriendsWithPresence.slice(offlineStartIndex) : []
                        const renderRow = ({ userId, bestLevel, activeServer, displayName }: { userId: string; bestLevel: PresenceLevel; activeServer: Server | null; displayName: string }) => {
                          const rp = remoteProfiles.getProfile(userId)
                          const secondaryName = rp?.show_secondary ? rp.secondary_name : null
                          const canJoin = activeServer && getServerById(activeServer.id)
                          const pending = hasPendingOutgoing(userId)
                          return (
                            <div
                              key={userId}
                              className={`flex items-center gap-1.5 h-11 px-1.5 rounded-md hover:bg-accent/30 min-w-0 shrink-0 overflow-visible ${pending ? 'opacity-75' : ''}`}
                            >
                              <button
                                type="button"
                                className={`relative h-7 w-7 shrink-0 grid place-items-center rounded-none ring-2 ring-background focus:outline-none overflow-visible ${pending ? 'grayscale' : ''}`}
                                style={!rp?.avatar_data_url ? avatarStyleForUser(userId) : undefined}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setProfileCardUserId(userId)
                                  setProfileCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
                                }}
                                aria-label={displayName}
                              >
                                {rp?.avatar_data_url ? (
                                  <img src={rp.avatar_data_url} alt="" className="w-full h-full object-cover" />
                                ) : (
                                  <span className="text-[9px] font-mono tracking-wider">{getInitials(displayName)}</span>
                                )}
                                <div className="absolute -top-0.5 left-1/2 -translate-x-1/2">
                                  {bestLevel === 'in_call' ? (
                                    <div className="h-1.5 w-1.5 bg-blue-500 ring-2 ring-background" />
                                  ) : bestLevel === 'active' ? (
                                    <div className="h-1.5 w-1.5 bg-green-500 ring-2 ring-background" />
                                  ) : bestLevel === 'online' ? (
                                    <div className="h-1.5 w-1.5 bg-amber-500 ring-2 ring-background" />
                                  ) : (
                                    <div className="h-1.5 w-1.5 bg-muted-foreground ring-2 ring-background" />
                                  )}
                                </div>
                              </button>
                              <div className="min-w-0 flex-1 min-h-[1.75rem] flex flex-col justify-center">
                                <p className="text-xs font-light truncate">{displayName}</p>
                                {pending ? (
                                  <p className="text-[11px] text-muted-foreground truncate">Pending</p>
                                ) : activeServer ? (
                                  <p className="text-[11px] text-muted-foreground truncate">{activeServer.name}</p>
                                ) : secondaryName ? (
                                  <p className="text-[11px] text-muted-foreground truncate">{secondaryName}</p>
                                ) : null}
                              </div>
                              {canJoin && !pending && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="shrink-0 h-7 px-1.5 text-[11px] font-light"
                                  onClick={() => navigate(`/home/${activeServer!.id}`, { state: { server: activeServer } })}
                                  title={'Join ' + activeServer!.name}
                                >
                                  <LogIn className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          )
                        }
                        return (
                          <>
                            {onlineFriends.map((f) => renderRow(f))}
                            {hasOfflineSep && (
                              <div className="flex w-full items-center py-0.5" aria-hidden>
                                <div className="h-px w-full shrink-0 bg-muted-foreground/60" />
                              </div>
                            )}
                            {offlineFriends.map((f) => renderRow(f))}
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
                {(friends.length > 0 || mergedIncoming.length > 0 || pendingOutgoing.length > 0) && (
                  <p className="mt-2 text-xs font-mono text-muted-foreground shrink-0">
                    {sortedFriendsWithPresence.filter((f) => f.bestLevel !== 'offline').length} online
                  </p>
                )}
              </div>
            </aside>
          </div>
        </div>
      </main>

      {showCreateDialog && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border-2 border-border rounded-lg p-6 max-w-md w-full space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-light tracking-tight">Create Server</h2>
              <div className="w-8 h-px bg-foreground/20"></div>
            </div>
            <div className="space-y-2">
              <label htmlFor="server-name" className="text-sm text-muted-foreground font-light">
                Server Name
              </label>
              <input
                id="server-name"
                type="text"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreateServer()
                  } else if (e.key === 'Escape') {
                    setShowCreateDialog(false)
                  }
                }}
                placeholder="My Server"
                maxLength={40}
                className="w-full px-4 py-2 bg-background border border-border rounded-md text-sm font-light focus:outline-none focus:ring-2 focus:ring-primary"
                autoFocus
              />
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  setShowCreateDialog(false)
                  setServerName('')
                }}
                variant="outline"
                className="flex-1 h-10 font-light"
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateServer}
                className="flex-1 h-10 bg-foreground text-background hover:bg-foreground/90 font-light"
                disabled={isCreating || !serverName.trim()}
              >
                {isCreating ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border-2 border-border rounded-lg p-6 max-w-md w-full space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-light tracking-tight">Leave Server</h2>
              <div className="w-8 h-px bg-foreground/20"></div>
            </div>

            <p className="text-sm text-muted-foreground font-light leading-relaxed">
              Leave and delete <span className="text-foreground">{deleteTarget.name}</span> from this device?
            </p>

            <div className="flex gap-3">
              <Button
                onClick={() => setDeleteTarget(null)}
                variant="outline"
                className="flex-1 h-10 font-light"
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmDeleteServer}
                className="flex-1 h-10 bg-destructive text-destructive-foreground hover:bg-destructive/90 font-light"
                disabled={isCreating}
              >
                {isCreating ? 'Leaving...' : 'Leave'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <UserProfileCard
        open={Boolean(profileCardUserId)}
        anchorRect={profileCardAnchor}
        onClose={() => {
          setProfileCardUserId(null)
          setProfileCardAnchor(null)
        }}
        avatarDataUrl={
          profileCardUserId
            ? identity?.user_id === profileCardUserId
              ? profile.avatar_data_url
              : remoteProfiles.getProfile(profileCardUserId)?.avatar_data_url ?? null
            : null
        }
        fallbackColorStyle={profileCardUserId ? avatarStyleForUser(profileCardUserId) : undefined}
        initials={getInitials(
          profileCardUserId
            ? identity?.user_id === profileCardUserId
              ? profile.display_name ?? identity?.display_name ?? ''
              : remoteProfiles.getProfile(profileCardUserId)?.display_name ?? fallbackNameForUser(profileCardUserId)
            : ''
        )}
        displayName={
          profileCardUserId
            ? identity?.user_id === profileCardUserId
              ? profile.display_name ?? identity?.display_name ?? ''
              : remoteProfiles.getProfile(profileCardUserId)?.display_name ?? fallbackNameForUser(profileCardUserId)
            : ''
        }
        secondaryName={
          profileCardUserId
            ? identity?.user_id === profileCardUserId
              ? profile.show_real_name
                ? profile.real_name
                : null
              : remoteProfiles.getProfile(profileCardUserId)?.show_secondary
                ? remoteProfiles.getProfile(profileCardUserId)?.secondary_name ?? null
                : null
            : null
        }
        accountCreatedAt={
          profileCardUserId
            ? identity?.user_id === profileCardUserId && currentAccountId
              ? accountInfoMap[currentAccountId]?.created_at ?? null
              : remoteProfiles.getProfile(profileCardUserId)?.account_created_at ?? null
            : null
        }
        isSelf={identity?.user_id === profileCardUserId}
        isFriend={profileCardUserId ? isFriend(profileCardUserId) : false}
        isPendingOutgoing={profileCardUserId ? hasPendingOutgoing(profileCardUserId) : false}
        onSendFriendRequest={
          profileCardUserId && !isFriend(profileCardUserId) && !hasPendingOutgoing(profileCardUserId)
            ? () => sendFriendRequest(profileCardUserId, profile?.display_name ?? identity?.display_name)
            : undefined
        }
        onRemoveFriend={profileCardUserId ? () => removeFriend(profileCardUserId) : undefined}
      />
    </div>
  )
}

export default ServerListPage

