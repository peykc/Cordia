import { Link, useNavigate } from 'react-router-dom'
import { Plus, Settings, Users, Trash2, Star, CornerDownLeft } from 'lucide-react'
import { Button } from '../components/ui/button'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSignaling } from '../contexts/SignalingContext'
import { SignalingStatus } from '../components/SignalingStatus'
import { ProfileAvatarChip } from '../components/ProfileAvatarChip'
import { UserProfileCard } from '../components/UserProfileCard'
import { listHouses, createHouse, deleteHouse, type House, parseInviteUri, publishHouseHintOpaque, publishHouseHintMemberLeft, redeemTemporaryInvite } from '../lib/tauri'
import { useIdentity } from '../contexts/IdentityContext'
import { usePresence } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useAccount } from '../contexts/AccountContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useWebRTC } from '../contexts/WebRTCContext'

function HouseListPage() {
  const navigate = useNavigate()
  const { identity } = useIdentity()
  const { currentAccountId } = useAccount()
  const { getLevel } = usePresence()
  const { peers } = useWebRTC()
  const { signalingUrl, status: signalingStatus } = useSignaling()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const [houses, setHouses] = useState<House[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<House | null>(null)
  const [houseName, setHouseName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [joinError, setJoinError] = useState('')
  const [showJoinInline, setShowJoinInline] = useState(false)
  const [showCreateInline, setShowCreateInline] = useState(false)
  const joinInputRef = useRef<HTMLInputElement | null>(null)
  const createInputRef = useRef<HTMLInputElement | null>(null)
  const [favoriteHouseIds, setFavoriteHouseIds] = useState<Set<string>>(new Set())
  const [profileCardUserId, setProfileCardUserId] = useState<string | null>(null)
  const [profileCardAnchor, setProfileCardAnchor] = useState<DOMRect | null>(null)

  const fallbackNameForUser = (userId: string) => {
    for (const h of houses) {
      const m = h.members.find(mm => mm.user_id === userId)
      if (m?.display_name) return m.display_name
    }
    return 'Unknown'
  }

  useEffect(() => {
    loadHouses()

    // If another part of the app syncs houses (e.g. on login), refresh the list.
    const onHousesUpdated = () => {
      loadHouses()
    }
    window.addEventListener('roommate:houses-updated', onHousesUpdated)

    return () => {
      window.removeEventListener('roommate:houses-updated', onHousesUpdated)
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
        setFavoriteHouseIds(new Set())
        return
      }
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        setFavoriteHouseIds(new Set(parsed.filter((x) => typeof x === 'string')))
      } else {
        setFavoriteHouseIds(new Set())
      }
    } catch {
      setFavoriteHouseIds(new Set())
    }
  }, [favoritesStorageKey])

  const persistFavorites = (next: Set<string>) => {
    try {
      window.localStorage.setItem(favoritesStorageKey, JSON.stringify(Array.from(next)))
    } catch {
      // ignore
    }
  }

  const toggleFavorite = (houseId: string) => {
    setFavoriteHouseIds((prev) => {
      const next = new Set(prev)
      if (next.has(houseId)) next.delete(houseId)
      else next.add(houseId)
      persistFavorites(next)
      return next
    })
  }

  // Presence: "Neighborhood" (not active in a specific house)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('roommate:active-house-changed', { detail: { signing_pubkey: null } }))
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

  const MemberStack = ({ house }: { house: House }) => {
    const voicePresence = useVoicePresence()
    const maxVisible = 6
    const avatarPx = 28 // h-7/w-7
    const stepPx = 19    // overlap step (smaller = more overlap)

    const visible = house.members.slice(0, maxVisible)
    const extraCount = Math.max(0, house.members.length - maxVisible)
    const itemCount = visible.length + (extraCount > 0 ? 1 : 0)
    const widthPx = itemCount > 0 ? avatarPx + (itemCount - 1) * stepPx : avatarPx

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
        className="relative h-7 isolation-isolate"
        style={{ width: widthPx }}
      >
        {visible.map((m, i) => (
          (() => {
            const level = getLevel(house.signing_pubkey, m.user_id, voicePresence.isUserInVoice(house.signing_pubkey, m.user_id))
            const p = resolveProfile(m.user_id, m.display_name)
            return (
          <div
            key={m.user_id}
            className="absolute top-0 z-[var(--z)] hover:z-50"
            style={{ left: i * stepPx, ['--z' as any]: i }}
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
          })()
        ))}

        {extraCount > 0 && (
          <div
            className="absolute top-0 z-[var(--z)] hover:z-50"
            style={{ left: visible.length * stepPx, ['--z' as any]: visible.length }}
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
    )
  }

  const loadHouses = async () => {
    try {
      const loadedHouses = await listHouses()
      setHouses(loadedHouses)
    } catch (error) {
      console.error('Failed to load houses:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const sortedHouses = [...houses].sort((a, b) => {
    const af = favoriteHouseIds.has(a.id) ? 1 : 0
    const bf = favoriteHouseIds.has(b.id) ? 1 : 0
    if (af !== bf) return bf - af
    // Stable-ish: fall back to name for deterministic order
    return a.name.localeCompare(b.name)
  })

  const handleCreateHouse = async () => {
    if (!identity || !houseName.trim()) return

    setIsCreating(true)
    try {
      const newHouse = await createHouse(
        houseName.trim(),
        identity.user_id,
        identity.display_name
      )

      if (signalingStatus === 'connected' && signalingUrl) {
        publishHouseHintOpaque(signalingUrl, newHouse.id).catch(e => console.warn('Failed to publish house hint:', e))
      }

      setHouses([...houses, newHouse])
      // Let WS-based bootstraps (presence + hint subscriptions) know a new house exists.
      window.dispatchEvent(new Event('roommate:houses-updated'))
      setShowCreateDialog(false)
      setShowCreateInline(false)
      setHouseName('')
      navigate(`/houses/${newHouse.id}`)
    } catch (error) {
      console.error('Failed to create house:', error)
    } finally {
      setIsCreating(false)
    }
  }

  const handleJoinHouse = async () => {
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
          setJoinError('Invalid invite. Paste the full invite link (rmmt://...).')
          return
        }

        signalingServer =
          parsed.server.startsWith('ws://') || parsed.server.startsWith('wss://')
            ? parsed.server
            : `wss://${parsed.server}`
        // Temporary invites use rmmt://{code}@{server}
        inviteCode = parsed.signingPubkey
      } else {
        if (!signalingServer) {
          setJoinError('No signaling server configured.')
          return
        }
        inviteCode = input
      }

      // If we have an invite code, redeem it (this imports house + keys and joins locally)
      if (inviteCode) {
        const updatedHouse = await redeemTemporaryInvite(signalingServer, inviteCode, identity.user_id, identity.display_name)

        setHouses(prev => {
          const exists = prev.some(h => h.id === updatedHouse.id)
          return exists ? prev.map(h => (h.id === updatedHouse.id ? updatedHouse : h)) : [...prev, updatedHouse]
        })
        // Let WS-based bootstraps (presence + hint subscriptions) know a new house exists.
        window.dispatchEvent(new Event('roommate:houses-updated'))
        setShowJoinInline(false)
        setInviteCode('')
        setJoinError('')
        navigate(`/houses/${updatedHouse.id}`)
        return
      }
    } catch (error) {
      console.error('Failed to join house:', error)
      setJoinError('Failed to join house. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }

  const handleDeleteHouse = (e: React.MouseEvent, houseId: string) => {
    e.stopPropagation()
    const target = houses.find(h => h.id === houseId) || null
    setDeleteTarget(target)
  }

  const confirmDeleteHouse = async () => {
    if (!deleteTarget) return
    const houseId = deleteTarget.id

    try {
      setIsCreating(true)
      // Stop WS-based re-import immediately (prevents "0 member ghost house" from coming back).
      window.dispatchEvent(
        new CustomEvent('roommate:house-removed', { detail: { signing_pubkey: deleteTarget.signing_pubkey } })
      )

      // Best-effort: advertise leave to other members.
      if (identity && signalingStatus === 'connected' && signalingUrl) {
        // IMPORTANT: publish BEFORE deleting locally (encryption needs the local symmetric key)
        await publishHouseHintMemberLeft(signalingUrl, houseId, identity.user_id)
      }

      // Delete locally last (so the leave broadcast can be encrypted)
      await deleteHouse(houseId)
      setHouses(prev => prev.filter(h => h.id !== houseId))
      setDeleteTarget(null)
      window.dispatchEvent(new Event('roommate:houses-updated'))
    } catch (error) {
      console.error('Failed to delete house:', error)
      setJoinError('Failed to delete house. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }

  if (isLoading) {
    return (
      <div className="h-full bg-background grid-pattern flex items-center justify-center">
        <p className="text-muted-foreground text-sm font-light">Loading houses...</p>
      </div>
    )
  }

  return (
    <div className="h-full bg-background grid-pattern flex flex-col overflow-hidden">
      <header className="border-b-2 border-border shrink-0">
        <div className="w-full flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <div className="w-px h-6 bg-foreground/20"></div>
            <h1 className="text-sm font-light tracking-wider uppercase">Neighborhood</h1>
          </div>
          <div className="flex items-center gap-2">
            <SignalingStatus />
            <ProfileAvatarChip />
            <Link to="/settings">
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <Settings className="h-4 w-4" />
              </Button>
            </Link>
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
                  <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground">Houses</h2>
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
                    {showJoinInline ? 'Cancel' : 'Join House'}
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
                    {showCreateInline ? 'Cancel' : 'New House'}
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
                                  handleJoinHouse()
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
                            onClick={handleJoinHouse}
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

                  {/* New House popover (inverse styling, does not affect layout) */}
                  {showCreateInline && (
                    <div className="absolute right-0 bottom-full mb-2 z-50 w-[200px] max-w-[calc(100vw-4rem)]">
                      <div className="border-2 border-background/20 bg-foreground text-background rounded-lg p-2 shadow-lg">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 px-2 py-1.5 bg-background/10 border border-background/20 rounded-md">
                            <input
                              ref={createInputRef}
                              type="text"
                              value={houseName}
                              onChange={(e) => setHouseName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isCreating) {
                                  handleCreateHouse()
                                } else if (e.key === 'Escape') {
                                  setShowCreateInline(false)
                                  setHouseName('')
                                }
                              }}
                              placeholder="House name"
                              className="w-full bg-transparent outline-none text-[11px] font-mono tracking-wider text-background placeholder:text-background/60"
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={handleCreateHouse}
                            disabled={isCreating || !houseName.trim()}
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

              {/* Houses list (scrolls) */}
              <div className="mt-6 flex-1 min-h-0 overflow-y-auto pr-1">
                {houses.length === 0 ? (
                  <div className="border-2 border-border bg-card/50 rounded-lg p-8">
                    <div className="max-w-md space-y-4">
                      <h3 className="text-2xl font-light tracking-tight">No houses yet</h3>
                      <p className="text-muted-foreground text-sm leading-relaxed font-light">
                        Create or join a house to start voice chatting with your roommates.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-4 pb-2">
                    {sortedHouses.map((house) => (
                      (() => {
                        const isFav = favoriteHouseIds.has(house.id)
                        const cardBorder = isFav ? 'border-amber-500/70' : 'border-border'
                        return (
                      <div key={house.id} className="relative group/card">
                        <div
                          onClick={() => navigate(`/houses/${house.id}`)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              navigate(`/houses/${house.id}`)
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          className={`w-full p-6 border-2 ${cardBorder} bg-card hover:bg-accent/50 transition-colors text-left rounded-lg`}
                        >
                          <div className="flex items-center justify-between gap-6">
                            <div className="space-y-2">
                              <h3 className="text-lg font-light tracking-tight">{house.name}</h3>
                              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {house.members.length} {house.members.length === 1 ? 'member' : 'members'}
                                </span>
                                <span>{house.rooms.length} {house.rooms.length === 1 ? 'room' : 'rooms'}</span>
                              </div>
                              {house.members.length > 0 && (
                                <div className="pt-1">
                                  <div className="flex items-center">
                                    <MemberStack house={house} />
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col items-center justify-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleFavorite(house.id)
                                }}
                                className={`opacity-0 group-hover/card:opacity-100 h-9 w-9 grid place-items-center rounded-md transition-opacity hover:bg-amber-500/10 ${
                                  isFav ? 'text-amber-500' : 'text-muted-foreground hover:text-amber-500'
                                }`}
                                title={isFav ? 'Unfavorite' : 'Favorite'}
                              >
                                <Star className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => handleDeleteHouse(e, house.id)}
                                className="opacity-0 group-hover/card:opacity-100 h-9 w-9 grid place-items-center rounded-md hover:bg-destructive/20 text-destructive transition-opacity"
                                title="Leave and delete house"
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

            {/* Right: Neighbors (placeholder) */}
            <aside className="hidden md:block md:col-span-3 h-full min-h-0">
              <div className="border-2 border-border bg-card/50 rounded-lg p-4">
                <div className="space-y-2">
                  <h3 className="text-xs font-light tracking-wider uppercase text-muted-foreground">Neighbors</h3>
                  <p className="text-sm font-light leading-relaxed text-muted-foreground">
                    Friends list is coming soon. This panel will show who’s online and what house they’re in.
                  </p>
                </div>
                <div className="mt-4 border border-border/60 bg-background/40 rounded-md p-3">
                  <p className="text-xs font-mono text-muted-foreground">0 online</p>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </main>

      {showCreateDialog && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border-2 border-border rounded-lg p-6 max-w-md w-full space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-light tracking-tight">Create House</h2>
              <div className="w-8 h-px bg-foreground/20"></div>
            </div>
            <div className="space-y-2">
              <label htmlFor="house-name" className="text-sm text-muted-foreground font-light">
                House Name
              </label>
              <input
                id="house-name"
                type="text"
                value={houseName}
                onChange={(e) => setHouseName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreateHouse()
                  } else if (e.key === 'Escape') {
                    setShowCreateDialog(false)
                  }
                }}
                placeholder="My House"
                className="w-full px-4 py-2 bg-background border border-border rounded-md text-sm font-light focus:outline-none focus:ring-2 focus:ring-primary"
                autoFocus
              />
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  setShowCreateDialog(false)
                  setHouseName('')
                }}
                variant="outline"
                className="flex-1 h-10 font-light"
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateHouse}
                className="flex-1 h-10 bg-foreground text-background hover:bg-foreground/90 font-light"
                disabled={isCreating || !houseName.trim()}
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
              <h2 className="text-xl font-light tracking-tight">Leave House</h2>
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
                onClick={confirmDeleteHouse}
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
        avatarDataUrl={profileCardUserId && identity?.user_id === profileCardUserId ? profile.avatar_data_url : null}
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
      />
    </div>
  )
}

export default HouseListPage

