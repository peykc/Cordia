import { useEffect, useState, useRef, type CSSProperties } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, Copy, Check, PhoneOff, Plus, Trash2, Phone } from 'lucide-react'
import { Button } from '../components/ui/button'
import { loadServer, addRoom, removeChat, type Server, type Chat, fetchAndImportServerHintOpaque, publishServerHintOpaque, createTemporaryInvite, revokeActiveInvite } from '../lib/tauri'
import { useIdentity } from '../contexts/IdentityContext'
import { useWebRTC } from '../contexts/WebRTCContext'
import { SignalingStatus } from '../components/SignalingStatus'
import { useSignaling } from '../contexts/SignalingContext'
import { usePresence, type PresenceLevel } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useSpeaking } from '../contexts/SpeakingContext'
import { useSidebarWidth } from '../contexts/SidebarWidthContext'
import { useActiveServer } from '../contexts/ActiveServerContext'
import { cn } from '../lib/utils'

function ServerViewPage() {
  const { serverId } = useParams<{ serverId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { identity } = useIdentity()
  const { getLevel } = usePresence()
  const { activeSigningPubkey } = useActiveServer()
  const voicePresence = useVoicePresence()
  const { isUserSpeaking } = useSpeaking()
  const { joinVoice, leaveVoice, isInVoice: webrtcIsInVoice, currentRoomId } = useWebRTC()
  const { signalingUrl, status: signalingStatus } = useSignaling()
  const { width, setWidth, resetWidth } = useSidebarWidth()

  /** For the current user, presence is instant from local state; for others, use signaling data. */
  const getMemberLevel = (signingPubkey: string, userId: string, isInVoiceForUser: boolean): PresenceLevel => {
    if (identity?.user_id === userId) {
      if (signalingStatus !== 'connected') return 'offline'
      if (isInVoiceForUser) return 'in_call'
      if (activeSigningPubkey === signingPubkey) return 'active'
      return 'online'
    }
    return getLevel(signingPubkey, userId, isInVoiceForUser)
  }
  const roomPaneResizeHandleRef = useRef<HTMLDivElement>(null)
  const [isResizing, setIsResizing] = useState(false)
  // Try to get server from navigation state first (preloaded from Home page)
  const [server, setServer] = useState<Server | null>((location.state as { server?: Server })?.server || null)
  const [copiedInvite, setCopiedInvite] = useState(false)
  const [currentChat, setCurrentChat] = useState<Chat | null>(null)
  const [hoveredChatId, setHoveredChatId] = useState<string | null>(null)
  const [showCreateChatDialog, setShowCreateChatDialog] = useState(false)
  const [chatName, setChatName] = useState('')
  const [chatDescription, setChatDescription] = useState('')
  const [isCreatingChat, setIsCreatingChat] = useState(false)
  const [isCreatingInvite, setIsCreatingInvite] = useState(false)
  const [isRevokingInvite, setIsRevokingInvite] = useState(false)
  const [deleteChatTarget, setDeleteChatTarget] = useState<Chat | null>(null)
  const [isDeletingChat, setIsDeletingChat] = useState(false)
  const [deleteChatError, setDeleteChatError] = useState('')

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
    const h = hashId(userId) % 360
    return {
      backgroundColor: `hsl(${h} 60% 78%)`,
      color: `hsl(${h} 35% 25%)`,
    }
  }

  const PresenceSquare = ({ level, size = 'default' }: { level: 'active' | 'online' | 'offline' | 'in_call'; size?: 'default' | 'small' }) => {
    const cls =
      level === 'in_call'
        ? 'bg-blue-500'
        : level === 'active'
          ? 'bg-green-500'
          : level === 'online'
            ? 'bg-amber-500'
            : 'bg-muted-foreground'
    const sizeClass = size === 'small' ? 'h-1.5 w-1.5' : 'h-2 w-2'
    return <div className={`${sizeClass} ${cls} ring-2 ring-background`} />
  }

  // Sync with beacon in background (non-blocking)
  const syncWithSignalingServer = async () => {
    if (!server || !serverId) return

    // Only sync if signaling is connected
    if (signalingStatus === 'connected' && signalingUrl) {
      try {
        const changed = await fetchAndImportServerHintOpaque(signalingUrl, server.signing_pubkey)
        if (changed) {
          // Reload server data if it changed
          const updatedServer = await loadServer(serverId)
          setServer(updatedServer)
        }
      } catch (e) {
        console.warn('[ServerView] Failed to refresh server hint:', e)
      }
    }
  }

  useEffect(() => {
    if (!serverId) {
      navigate('/home')
      return
    }

    // If we don't have server data from navigation state, load it from disk
    if (!server) {
      loadServerData()
    } else {
      // We have server data, but still sync with beacon in background
      syncWithSignalingServer()
    }

    // Reload server data when window gains focus (e.g., alt-tabbing between instances)
    const handleFocus = () => {
      console.log('[ServerView] Window focused - reloading server data')
      loadServerData()
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [serverId])

  // Sync with beacon when server or signaling status changes (background, non-blocking)
  useEffect(() => {
    if (server && serverId) {
      syncWithSignalingServer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.signing_pubkey, signalingStatus, signalingUrl])

  // Presence: mark this server as "active" while the user is viewing it.
  useEffect(() => {
    if (!server?.signing_pubkey) return
    window.dispatchEvent(
      new CustomEvent('cordia:active-server-changed', { detail: { signing_pubkey: server.signing_pubkey } })
    )
    return () => {
      window.dispatchEvent(new CustomEvent('cordia:active-server-changed', { detail: { signing_pubkey: null } }))
    }
  }, [server?.signing_pubkey])

  // Resize handler for room pane
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize)
      const newWidthEm = e.clientX / rootFontSize
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

  const loadServerData = async () => {
    if (!serverId) return

    try {
      // Load local first for fast UI
      const loadedServer = await loadServer(serverId)
      setServer(loadedServer)

      // Sync with beacon in background (non-blocking)
      syncWithSignalingServer()
    } catch (error) {
      console.error('Failed to load server:', error)
      navigate('/home')
    }
  }

  const copyInviteCode = () => {
    if (!server) return
    const code = getActiveInviteCode()
    if (!code) return
    // Copy just the code. Join UI will use the user's configured signaling server under the hood.
    navigator.clipboard.writeText(code)
    setCopiedInvite(true)
    setTimeout(() => setCopiedInvite(false), 2000)
  }

  const getActiveInviteUri = (): string | null => {
    if (!server) return null
    const uri = server.active_invite_uri || null
    const expiresAt = server.active_invite_expires_at ? new Date(server.active_invite_expires_at) : null
    if (!uri) return null
    // If expires_at isn't present (older data), treat it as active until revoked.
    if (expiresAt && Date.now() > expiresAt.getTime()) return null
    return uri
  }

  const getActiveInviteCode = (): string | null => {
    const uri = getActiveInviteUri()
    if (!uri) return null
    // Backend uses cordia://CODE@host; accept cordia:// or legacy rmmt://
    const parsed = uri.trim().match(/^(?:cordia|rmmt):\/\/([^@]+)@/i)
    return parsed ? parsed[1] : null
  }

  const handleCreateInvite = async () => {
    if (!serverId || !server) return
    if (signalingStatus !== 'connected' || !signalingUrl) return

    setIsCreatingInvite(true)
    try {
      // Default: unlimited uses until someone revokes.
      await createTemporaryInvite(signalingUrl, serverId, 0)
      const updated = await loadServer(serverId)
      setServer(updated)
    } catch (e) {
      console.warn('Failed to create invite:', e)
    } finally {
      setIsCreatingInvite(false)
    }
  }

  const handleRevokeInvite = async () => {
    if (!serverId) return
    if (signalingStatus !== 'connected' || !signalingUrl) return
    setIsRevokingInvite(true)
    try {
      await revokeActiveInvite(signalingUrl, serverId)
      const updated = await loadServer(serverId)
      setServer(updated)
    } catch (e) {
      console.warn('Failed to revoke invite:', e)
    } finally {
      setIsRevokingInvite(false)
    }
  }

  // When server hints are imported via WS sync, refresh our local view.
  useEffect(() => {
    if (!serverId) return
    const onServersUpdated = () => {
      loadServer(serverId).then(setServer).catch(() => {})
    }
    window.addEventListener('cordia:servers-updated', onServersUpdated)
    return () => window.removeEventListener('cordia:servers-updated', onServersUpdated)
  }, [serverId])

  const handleSelectChat = (chat: Chat) => {
    if (currentChat?.id === chat.id) return

    // Don't leave voice when just viewing a different chat
    // Voice will only be left if user explicitly clicks "Leave Voice" or joins a different chat
    setCurrentChat(chat)
    console.log('Opened chat:', chat.name)
  }

  const handleJoinVoice = async (chat: Chat) => {
    if (!server || !identity) return

    try {
      await joinVoice(chat.id, server.id, identity.user_id, server.signing_pubkey)
      console.log('Joined voice in chat:', chat.name)
    } catch (error) {
      console.error('Failed to join voice:', error)
    }
  }

  const handleLeaveVoice = () => {
    leaveVoice()
    console.log('Left voice')
  }

  const handleCreateChat = async () => {
    if (!serverId || !chatName.trim()) return

    setIsCreatingChat(true)
    try {
      const updatedServer = await addRoom(
        serverId,
        chatName.trim(),
        chatDescription.trim() || null
      )
      setServer(updatedServer)

      // Publish updated hint (chats changed)
      if (signalingStatus === 'connected' && signalingUrl) {
        publishServerHintOpaque(signalingUrl, updatedServer.id).catch(e => console.warn('Failed to publish server hint:', e))
      }

      setShowCreateChatDialog(false)
      setChatName('')
      setChatDescription('')
    } catch (error) {
      console.error('Failed to create chat:', error)
    } finally {
      setIsCreatingChat(false)
    }
  }

  const handleDeleteChatClick = (e: React.MouseEvent, chat: Chat) => {
    e.stopPropagation()
    setDeleteChatError('')
    setDeleteChatTarget(chat)
  }

  const confirmDeleteChat = async () => {
    if (!serverId || !server || !deleteChatTarget) return
    setIsDeletingChat(true)
    setDeleteChatError('')

    try {
      // If we're currently in this chat's voice channel, disconnect first.
      if (currentChat?.id === deleteChatTarget.id && webrtcIsInVoice) {
        leaveVoice()
      }

      const updatedServer = await removeChat(serverId, deleteChatTarget.id)
      setServer(updatedServer)

      if (currentChat?.id === deleteChatTarget.id) {
        setCurrentChat(null)
      }

      // Publish updated hint (chats changed) so WS subscribers refresh.
      if (signalingStatus === 'connected' && signalingUrl) {
        publishServerHintOpaque(signalingUrl, updatedServer.id).catch(e => console.warn('Failed to publish server hint:', e))
      }

      setDeleteChatTarget(null)
      window.dispatchEvent(new Event('cordia:servers-updated'))
    } catch (e) {
      console.error('Failed to delete chat:', e)
      setDeleteChatError('Failed to delete chat. Please try again.')
    } finally {
      setIsDeletingChat(false)
    }
  }

  if (!server) {
    return (
      <div className="h-full bg-background flex items-center justify-center">
        <p className="text-muted-foreground text-sm font-light">Server not found</p>
      </div>
    )
  }

  return (
    <div className="h-full bg-background flex flex-col">
      <header className="border-b-2 border-border">
        <div className="w-full flex h-16 items-center justify-between px-6 min-w-0">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <button
              onClick={() => navigate('/home')}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="w-px h-6 bg-foreground/20 shrink-0"></div>
            <h1 className="text-sm font-light tracking-wider uppercase truncate min-w-0">{server.name}</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <SignalingStatus />
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - Rooms List */}
        <div className="shrink-0 border-r-2 border-border bg-card/50 flex flex-col relative" style={{ width: `${width}em` }}>
          {/* Resize handle */}
          <div
            ref={roomPaneResizeHandleRef}
            onMouseDown={handleResizeStart}
            onDoubleClick={handleDoubleClick}
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 transition-colors z-10"
            title="Drag to resize, double-click to reset"
          >
            <div className="absolute inset-0 -right-1 w-2" />
          </div>
          <div className="p-4 flex flex-col h-full">
            <div className="space-y-2">
              <div className="flex items-center justify-between px-2">
                <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground">
                  Chats
                </h2>
                <button
                  onClick={() => setShowCreateChatDialog(true)}
                  className="p-1 rounded transition-colors hover:bg-accent/50 text-muted-foreground hover:text-foreground"
                  title="Create new chat"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
              <div className="space-y-1">
                {(server.chats ?? []).map((chat) => {
                  const voiceParticipants = voicePresence.getVoiceParticipants(server.signing_pubkey, chat.id)
                  // Include self if in voice in this chat
                  const allParticipants = identity && webrtcIsInVoice && currentRoomId === chat.id && !voiceParticipants.includes(identity.user_id)
                    ? [identity.user_id, ...voiceParticipants]
                    : voiceParticipants
                  const isSelected = currentChat?.id === chat.id

                  return (
                    <div key={chat.id}>
                      <div
                        onClick={() => handleSelectChat(chat)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            handleSelectChat(chat)
                          }
                        }}
                        onMouseEnter={() => setHoveredChatId(chat.id)}
                        onMouseLeave={() => setHoveredChatId(null)}
                        role="button"
                        tabIndex={0}
                        className={`w-full px-3 py-2 rounded-md transition-colors text-left group min-w-0 overflow-hidden ${
                          isSelected
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-accent/50'
                        }`}
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className="text-lg shrink-0">#</span>
                            <span className="text-sm font-light truncate">{chat.name}</span>
                          </div>
                          {(() => {
                            const inThisChat = webrtcIsInVoice && currentRoomId === chat.id
                            const showJoin = !inThisChat && hoveredChatId === chat.id
                            const isHovered = hoveredChatId === chat.id
                            const showIcons = inThisChat || showJoin || isHovered
                            return (
                              <div className={`flex items-center gap-2 transition-all duration-200 ${
                                showIcons ? 'w-auto' : 'w-0 overflow-hidden'
                              }`}>
                                {/* Phone icon for joining/leaving voice - visible when in call, hover-only otherwise */}
                                <button
                                  type="button"
                                  title={inThisChat ? "Leave voice" : "Join voice"}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (inThisChat) {
                                      handleLeaveVoice()
                                    } else {
                                      handleJoinVoice(chat)
                                    }
                                  }}
                                  className={`p-1 rounded transition-colors shrink-0 ${
                                    isSelected
                                      ? 'hover:bg-primary-foreground/10 text-primary-foreground/80 hover:text-primary-foreground'
                                      : 'hover:bg-accent/70 text-muted-foreground hover:text-foreground'
                                  }`}
                                >
                                  {inThisChat ? <PhoneOff className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                                </button>
                                <button
                                  type="button"
                                  title="Delete chat"
                                  onClick={(e) => handleDeleteChatClick(e, chat)}
                                  className={`p-1 rounded transition-colors shrink-0 ${
                                    isSelected
                                      ? 'hover:bg-primary-foreground/10 text-primary-foreground/80 hover:text-primary-foreground'
                                      : 'hover:bg-destructive/20 text-destructive'
                                  }`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            )
                          })()}
                        </div>
                      </div>

                      {/* Voice Participants */}
                      {allParticipants.length > 0 && (
                        <div className={`px-3 pb-2 ${isSelected ? 'pt-1' : 'pt-0'}`}>
                          {isSelected ? (
                            // Expanded view for selected chat
                            <div className="space-y-1">
                              {allParticipants.map((userId) => {
                                const member = (server.members ?? []).find(m => m.user_id === userId)
                                const displayName = member?.display_name || (userId === identity?.user_id ? identity.display_name : `User ${userId.slice(0, 8)}`)
                                const isSelf = userId === identity?.user_id
                                const level = getMemberLevel(
                                  server.signing_pubkey,
                                  userId,
                                  voicePresence.isUserInVoice(server.signing_pubkey, userId)
                                )
                                const isSpeaking = isUserSpeaking(userId)

                                return (
                                  <div key={userId} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/30 transition-colors">
                                    <div className="relative">
                                      <div
                                        className={cn(
                                          "w-6 h-6 grid place-items-center rounded-none text-[10px] font-mono tracking-wider ring-2 transition-all",
                                          isSpeaking ? "ring-green-500 ring-2" : "ring-background"
                                        )}
                                        style={avatarStyleForUser(userId)}
                                        title={displayName}
                                      >
                                        {getInitials(displayName)}
                                      </div>
                                      <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2">
                                        <PresenceSquare level={level} size="small" />
                                      </div>
                                    </div>
                                    <span className="text-xs font-light truncate">
                                      {displayName}{isSelf ? ' (you)' : ''}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          ) : (
                            // Stacked view for non-selected chats
                            (() => {
                              const maxVisible = 6
                              const avatarPx = 20 // h-5/w-5
                              const stepPx = 14   // overlap step
                              const visible = allParticipants.slice(0, maxVisible)
                              const extraCount = Math.max(0, allParticipants.length - maxVisible)
                              const itemCount = visible.length + (extraCount > 0 ? 1 : 0)
                              const widthPx = itemCount > 0 ? avatarPx + (itemCount - 1) * stepPx : avatarPx

                              return (
                                <div
                                  className="relative h-5 isolation-isolate"
                                  style={{ width: widthPx }}
                                >
                                  {visible.map((userId, i) => {
                                    const member = (server.members ?? []).find(m => m.user_id === userId)
                                    const displayName = member?.display_name || (userId === identity?.user_id ? identity?.display_name : `User ${userId.slice(0, 8)}`)
                                    const level = getMemberLevel(
                                      server.signing_pubkey,
                                      userId,
                                      voicePresence.isUserInVoice(server.signing_pubkey, userId)
                                    )
                                    const isSpeaking = isUserSpeaking(userId)

                                    return (
                                      <div
                                        key={userId}
                                        className="absolute top-0 z-[var(--z)]"
                                        style={{ left: i * stepPx, ['--z' as any]: i }}
                                      >
                                        <div className="relative">
                                          <div
                                            className={cn(
                                              "h-5 w-5 grid place-items-center rounded-none ring-2 transition-all",
                                              isSpeaking ? "ring-green-500 ring-2" : "ring-background"
                                            )}
                                            style={avatarStyleForUser(userId)}
                                            title={displayName}
                                          >
                                            <span className="text-[8px] font-mono tracking-wider">{getInitials(displayName)}</span>
                                          </div>
                                          <div className="absolute -top-0.5 left-1/2 -translate-x-1/2">
                                            <PresenceSquare level={level} size="small" />
                                          </div>
                                        </div>
                                      </div>
                                    )
                                  })}
                                  {extraCount > 0 && (
                                    <div
                                      className="absolute top-0 z-[var(--z)]"
                                      style={{ left: visible.length * stepPx, ['--z' as any]: visible.length }}
                                    >
                                      <div className="h-5 w-5 grid place-items-center rounded-none ring-2 ring-background bg-muted text-muted-foreground">
                                        <span className="text-[8px] font-mono">+{extraCount}</span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )
                            })()
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

          </div>
        </div>

        {/* Main Content - Text Chat + Optional Voice */}
        <div className="flex-1 flex flex-col">
          {!currentChat ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-md w-full space-y-6 text-center">
                <div className="w-12 h-px bg-foreground/20 mx-auto"></div>
                <h2 className="text-xl font-light tracking-tight">Select a chat</h2>
                <p className="text-muted-foreground text-sm leading-relaxed font-light">
                  Choose a chat from the sidebar to start chatting with your members.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Chat Header */}
              <div className="border-b-2 border-border p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl font-light">#</span>
                    <div className="space-y-1">
                      <h2 className="text-lg font-light tracking-tight">{currentChat.name}</h2>
                      {currentChat.description && (
                        <p className="text-xs text-muted-foreground">{currentChat.description}</p>
                      )}
                    </div>
                  </div>
                  {/* Join Voice button removed - now in sidebar on hover */}
                </div>
              </div>

              {/* Text Chat Area */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="max-w-4xl mx-auto space-y-4">
                    {/* Welcome Message */}
                    <div className="p-4 border-2 border-border rounded-lg bg-card/50">
                      <p className="text-sm text-muted-foreground font-light">
                        Welcome to <span className="text-foreground font-normal">#{currentChat.name}</span>
                        {currentChat.description && ` — ${currentChat.description}`}
                      </p>
                    </div>
                    {/* TODO: Actual messages will go here */}
                  </div>
                </div>

                {/* Message Input */}
                <div className="border-t-2 border-border p-4 bg-card/50">
                  <div className="max-w-4xl mx-auto">
                    <input
                      type="text"
                      placeholder={`Message #${currentChat.name}`}
                      className="w-full px-4 py-3 bg-background border border-border rounded-lg text-sm font-light focus:outline-none focus:ring-2 focus:ring-primary"
                      disabled
                    />
                    <p className="text-xs text-muted-foreground mt-2">
                      Text chat coming soon. Voice chat is the priority!
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right Sidebar - Members List */}
        <div className="w-64 border-l-2 border-border bg-card/50 flex flex-col">
          <div className="p-4 space-y-2 flex-1 overflow-y-auto">
            <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground px-2">
              Members — {(server.members ?? []).length}
            </h2>
            <div className="space-y-1">
              {(server.members ?? []).map((member) => (
                <div
                  key={member.user_id}
                  className="px-3 py-2 rounded-md hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <div
                        className="w-8 h-8 grid place-items-center rounded-none text-[10px] font-mono tracking-wider ring-2 ring-background"
                        style={avatarStyleForUser(member.user_id)}
                        title={member.display_name}
                      >
                        {getInitials(member.display_name)}
                      </div>
                      {/* Presence badge "attached" to the avatar */}
                      <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2">
                        <PresenceSquare level={getMemberLevel(
                          server.signing_pubkey,
                          member.user_id,
                          voicePresence.isUserInVoice(server.signing_pubkey, member.user_id)
                        )} />
                      </div>
                    </div>
                    <span className="text-sm font-light truncate">{member.display_name}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Invite Section */}
          <div className="p-4 border-t-2 border-border">
            <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground px-2 mb-3">
              Invite
            </h2>
            {!server?.has_symmetric_key ? (
              <p className="text-xs text-muted-foreground px-2">
                This server cannot create invites (missing key). You can still leave it from Home.
              </p>
            ) : !getActiveInviteUri() ? (
              <Button
                onClick={handleCreateInvite}
                size="sm"
                className="h-9 font-light w-full"
                disabled={isCreatingInvite || signalingStatus !== 'connected' || !signalingUrl}
              >
                {isCreatingInvite ? 'Creating…' : 'Create invite'}
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 px-3 py-2 bg-background border border-border rounded-md">
                    <code className="text-xs font-mono break-all">{getActiveInviteCode() || ''}</code>
                  </div>
                  <Button
                    onClick={copyInviteCode}
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                  >
                    {copiedInvite ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <Button
                  onClick={handleRevokeInvite}
                  variant="outline"
                  size="sm"
                  className="h-9 font-light w-full"
                  disabled={isRevokingInvite}
                >
                  {isRevokingInvite ? 'Revoking…' : 'Revoke invite'}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create Chat Dialog */}
      {showCreateChatDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border-2 border-border rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-lg font-light mb-4">Create New Chat</h2>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-light block mb-2">Chat Name</label>
                <input
                  type="text"
                  value={chatName}
                  onChange={(e) => setChatName(e.target.value)}
                  maxLength={25}
                  className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm"
                  placeholder="general, voice-chat, etc."
                  autoFocus
                />
              </div>

              <div>
                <label className="text-sm font-light block mb-2">Description (optional)</label>
                <input
                  type="text"
                  value={chatDescription}
                  onChange={(e) => setChatDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm"
                  placeholder="What's this chat for?"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <Button
                onClick={() => {
                  setShowCreateChatDialog(false)
                  setChatName('')
                  setChatDescription('')
                }}
                variant="outline"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateChat}
                disabled={!chatName.trim() || isCreatingChat}
                className="flex-1"
              >
                {isCreatingChat ? 'Creating...' : 'Create Chat'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Chat Modal */}
      {deleteChatTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md border-2 border-border bg-background rounded-lg p-6 space-y-4">
            <div className="space-y-2">
              <h2 className="text-lg font-light tracking-tight">Delete chat?</h2>
              <p className="text-sm text-muted-foreground font-light leading-relaxed">
                This will remove <span className="text-foreground font-normal">#{deleteChatTarget.name}</span> for everyone in this server.
              </p>
              {deleteChatError && (
                <p className="text-sm text-red-500 font-light">{deleteChatError}</p>
              )}
            </div>
            <div className="flex gap-3 pt-2">
              <Button
                variant="outline"
                className="flex-1 h-10 font-light"
                onClick={() => setDeleteChatTarget(null)}
                disabled={isDeletingChat}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 h-10 font-light bg-red-600 hover:bg-red-700 text-white"
                onClick={confirmDeleteChat}
                disabled={isDeletingChat}
              >
                {isDeletingChat ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ServerViewPage
