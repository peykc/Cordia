import { useEffect, useState, type CSSProperties } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, Copy, Check, PhoneOff, Phone, Send, Paperclip, Download } from 'lucide-react'
import { open } from '@tauri-apps/api/dialog'
import { Button } from '../components/ui/button'
import { loadServer, type Server, fetchAndImportServerHintOpaque, createTemporaryInvite, revokeActiveInvite, registerAttachmentFromPath } from '../lib/tauri'
import { UserProfileCard } from '../components/UserProfileCard'
import { UserCard } from '../components/UserCard'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useFriends } from '../contexts/FriendsContext'
import { useAccount } from '../contexts/AccountContext'
import { useWebRTC } from '../contexts/WebRTCContext'
import { BeaconStatus } from '../components/BeaconStatus'
import { useBeacon } from '../contexts/BeaconContext'
import { usePresence, type PresenceLevel } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useSpeaking } from '../contexts/SpeakingContext'
import { useActiveServer } from '../contexts/ActiveServerContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { cn } from '../lib/utils'

function ServerViewPage() {
  const { serverId } = useParams<{ serverId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const { isFriend, hasPendingOutgoing, sendFriendRequest, removeFriend } = useFriends()
  const { currentAccountId, accountInfoMap } = useAccount()
  const { getLevel } = usePresence()
  const { activeSigningPubkey } = useActiveServer()
  const voicePresence = useVoicePresence()
  const { isUserSpeaking } = useSpeaking()
  const { joinVoice, leaveVoice, isInVoice: webrtcIsInVoice, currentRoomId } = useWebRTC()
  const { getMessages, sendMessage, sendAttachmentMessage, requestAttachmentDownload, attachmentTransfers, markMessagesRead } = useEphemeralMessages()
  const { beaconUrl, status: beaconStatus } = useBeacon()
  /** For the current user, presence is instant from local state; for others, use signaling data. */
  const getMemberLevel = (signingPubkey: string, userId: string, isInVoiceForUser: boolean): PresenceLevel => {
    if (identity?.user_id === userId) {
      if (beaconStatus !== 'connected') return 'offline'
      if (isInVoiceForUser) return 'in_call'
      if (activeSigningPubkey === signingPubkey) return 'active'
      return 'online'
    }
    return getLevel(signingPubkey, userId, isInVoiceForUser)
  }
  // Try to get server from navigation state first (preloaded from Home page)
  const [server, setServer] = useState<Server | null>((location.state as { server?: Server })?.server || null)
  const [copiedInvite, setCopiedInvite] = useState(false)
  const [isCreatingInvite, setIsCreatingInvite] = useState(false)
  const [isRevokingInvite, setIsRevokingInvite] = useState(false)
  const [profileCardUserId, setProfileCardUserId] = useState<string | null>(null)
  const [profileCardAnchor, setProfileCardAnchor] = useState<DOMRect | null>(null)
  const [messageDraft, setMessageDraft] = useState('')

  // Single group chat per server (v1: no chat selector)
  const groupChat = server?.chats?.[0] ?? null
  const chatMessages = groupChat ? getMessages(server?.signing_pubkey ?? '', groupChat.id) : []
  const canSendMessages = Boolean(groupChat && server?.connection_mode === 'Signaling' && beaconStatus === 'connected')

  const fallbackNameForUser = (userId: string) => {
    const m = server?.members?.find(mm => mm.user_id === userId)
    return m?.display_name ?? `User ${userId.slice(0, 8)}`
  }

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
    if (beaconStatus === 'connected' && beaconUrl) {
      try {
        const changed = await fetchAndImportServerHintOpaque(beaconUrl, server.signing_pubkey)
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
  }, [server?.signing_pubkey, beaconStatus, beaconUrl])

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
    if (beaconStatus !== 'connected' || !beaconUrl) return

    setIsCreatingInvite(true)
    try {
      // Default: unlimited uses until someone revokes.
      await createTemporaryInvite(beaconUrl, serverId, 0)
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
    if (beaconStatus !== 'connected' || !beaconUrl) return
    setIsRevokingInvite(true)
    try {
      await revokeActiveInvite(beaconUrl, serverId)
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

  const handleJoinVoice = async () => {
    if (!server || !identity || !groupChat) return

    try {
      await joinVoice(groupChat.id, server.id, identity.user_id, server.signing_pubkey)
    } catch (error) {
      console.error('Failed to join voice:', error)
    }
  }

  const handleLeaveVoice = () => {
    leaveVoice()
  }

  const handleSendMessage = async () => {
    if (!server || !groupChat || !identity) return
    const text = messageDraft.trim()
    if (!text || !canSendMessages) return
    try {
      await sendMessage({
        serverId: server.id,
        signingPubkey: server.signing_pubkey,
        chatId: groupChat.id,
        fromUserId: identity.user_id,
        text,
      })
      setMessageDraft('')
    } catch (error) {
      console.warn('Failed to send message:', error)
    }
  }

  const handleSendAttachment = async () => {
    if (!server || !groupChat || !identity || !canSendMessages) return
    try {
      const selected = await open({
        title: 'Select attachment',
        multiple: false,
      })
      if (!selected || Array.isArray(selected)) return
      const useProgramCopy = window.confirm('Store a Cordia-managed copy for reliable future sharing?\nOK = copy into app storage, Cancel = keep current path.')
      const registered = await registerAttachmentFromPath(selected, useProgramCopy ? 'program_copy' : 'current_path')
      await sendAttachmentMessage({
        serverId: server.id,
        signingPubkey: server.signing_pubkey,
        chatId: groupChat.id,
        fromUserId: identity.user_id,
        attachment: {
          attachment_id: registered.attachment_id,
          file_name: registered.file_name,
          extension: registered.extension,
          size_bytes: registered.size_bytes,
          sha256: registered.sha256,
        },
      })
    } catch (error) {
      console.warn('Failed to send attachment:', error)
    }
  }

  useEffect(() => {
    if (!server || !groupChat || !identity) return
    const unreadFromOthers = chatMessages
      .filter((m) => m.from_user_id !== identity.user_id && !(m.read_by ?? []).includes(identity.user_id))
      .map((m) => m.id)
    if (unreadFromOthers.length === 0) return
    markMessagesRead(server.signing_pubkey, groupChat.id, unreadFromOthers)
  }, [server?.signing_pubkey, groupChat?.id, identity?.user_id, chatMessages, markMessagesRead])

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
            <BeaconStatus />
            <UserCard
              variant="header"
              onAvatarClick={(rect) => {
                setProfileCardUserId(identity?.user_id ?? null)
                setProfileCardAnchor(rect)
              }}
            />
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content - Group Chat */}
        <div className="flex-1 flex flex-col min-w-0">
          {groupChat ? (
            <>
              {/* Group Chat Header with Voice */}
              <div className="border-b-2 border-border p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-light tracking-tight">{server.name}</h2>
                  <Button
                    variant={webrtcIsInVoice && currentRoomId === groupChat.id ? "default" : "outline"}
                    size="sm"
                    className="h-9 font-light gap-2"
                    onClick={webrtcIsInVoice && currentRoomId === groupChat.id ? handleLeaveVoice : handleJoinVoice}
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
                {/* Voice participants in header */}
                {groupChat && (() => {
                  const voiceParticipants = voicePresence.getVoiceParticipants(server.signing_pubkey, groupChat.id)
                  const allParticipants = identity && webrtcIsInVoice && currentRoomId === groupChat.id && !voiceParticipants.includes(identity.user_id)
                    ? [identity.user_id, ...voiceParticipants]
                    : voiceParticipants
                  if (allParticipants.length === 0) return null
                  return (
                    <div className="flex items-center gap-2 mt-2">
                      {allParticipants.map((userId) => {
                        const member = (server.members ?? []).find(m => m.user_id === userId)
                        const displayName = member?.display_name || (userId === identity?.user_id ? identity?.display_name : `User ${userId.slice(0, 8)}`)
                        const isSpeaking = isUserSpeaking(userId)
                        const level = getMemberLevel(server.signing_pubkey, userId, voicePresence.isUserInVoice(server.signing_pubkey, userId))
                        return (
                          <button
                            key={userId}
                            type="button"
                            className={cn(
                              "relative h-6 w-6 shrink-0 grid place-items-center rounded-none ring-2 will-change-transform transition-all duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06] focus:outline-none group/avatar",
                              isSpeaking ? "ring-green-500" : "ring-background"
                            )}
                            style={avatarStyleForUser(userId)}
                            onClick={(e) => {
                              e.stopPropagation()
                              setProfileCardUserId(userId)
                              setProfileCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
                            }}
                            aria-label={displayName}
                            title={`${displayName}${userId === identity?.user_id ? ' (you)' : ''}`}
                          >
                            <span className="text-[9px] font-mono tracking-wider">{getInitials(displayName)}</span>
                            <div className="absolute -top-1 left-1/2 -translate-x-1/2">
                              <PresenceSquare level={level} />
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>

              {/* Text Chat Area */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="max-w-4xl mx-auto space-y-4">
                    <div className="p-4 border-2 border-border rounded-lg bg-card/50">
                      <p className="text-sm text-muted-foreground font-light">
                        Welcome to <span className="text-foreground font-normal">{server.name}</span> — your group chat.
                      </p>
                    </div>
                    {chatMessages.map((msg) => {
                      const mine = msg.from_user_id === identity?.user_id
                      const attachmentTransferRows = msg.kind === 'attachment' && msg.attachment
                        ? attachmentTransfers.filter(
                            (t) => t.message_id === msg.id || t.attachment_id === msg.attachment?.attachment_id
                          )
                        : []
                      const name = mine ? 'You' : fallbackNameForUser(msg.from_user_id)
                      const readBy = (msg.read_by ?? []).filter((uid) => uid !== identity?.user_id)
                      const deliveredBy = (msg.delivered_by ?? []).filter((uid) => uid !== identity?.user_id)
                      const statusLabel = msg.delivery_status === 'read'
                        ? `Read ${readBy.length > 0 ? readBy.length : ''}`.trim()
                        : msg.delivery_status === 'delivered'
                          ? 'Delivered'
                          : 'Pending'
                      const time = new Date(msg.sent_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                      return (
                        <div
                          key={msg.id}
                          className={cn('flex', mine ? 'justify-end' : 'justify-start')}
                        >
                          <div
                            className={cn(
                              'max-w-[80%] rounded-lg border px-3 py-2',
                              mine
                                ? 'bg-primary/15 border-primary/30'
                                : 'bg-card/70 border-border'
                            )}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-medium">{name}</span>
                              <span className="text-[10px] text-muted-foreground">{time}</span>
                            </div>
                            {msg.kind === 'attachment' && msg.attachment ? (
                              <div className="rounded border border-border/70 bg-background/60 px-2 py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="text-sm truncate">{msg.attachment.file_name}</p>
                                    <p className="text-[10px] text-muted-foreground">
                                      {(msg.attachment.size_bytes / 1024).toFixed(1)} KB
                                      {msg.attachment.extension ? ` • .${msg.attachment.extension}` : ''}
                                    </p>
                                  </div>
                                  {!mine && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="icon"
                                      className="h-7 w-7 shrink-0"
                                      onClick={() => requestAttachmentDownload(msg)}
                                    >
                                      <Download className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                </div>
                                {attachmentTransferRows.length > 0 && (
                                  <div className="mt-2 space-y-1">
                                    {attachmentTransferRows.slice(-2).map((t) => (
                                      <div key={t.request_id} className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                        <span className="truncate">{t.direction === 'upload' ? 'Upload' : 'Download'}</span>
                                        <span>
                                          {t.status === 'transferring' ? `${Math.round(t.progress * 100)}%` : t.status}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
                            )}
                            {mine && (
                              <div className="mt-1 text-[10px] text-muted-foreground relative group/receipt">
                                <span>{statusLabel}</span>
                                {readBy.length > 0 && (
                                  <div className="absolute right-0 bottom-full mb-1 hidden group-hover/receipt:flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 shadow-lg z-20">
                                    {readBy.slice(0, 8).map((uid, idx) => {
                                      const dn = fallbackNameForUser(uid)
                                      return (
                                        <div
                                          key={uid}
                                          className="-ml-1 first:ml-0 h-4 w-4 rounded-none ring-1 ring-background text-[8px] grid place-items-center"
                                          style={{ ...avatarStyleForUser(uid), zIndex: 20 - idx }}
                                          title={dn}
                                        >
                                          {getInitials(dn)}
                                        </div>
                                      )
                                    })}
                                    {readBy.length > 8 && (
                                      <span className="text-[9px] text-muted-foreground">+{readBy.length - 8}</span>
                                    )}
                                  </div>
                                )}
                                {msg.delivery_status !== 'read' && deliveredBy.length > 0 && (
                                  <span className="ml-1 text-[9px] text-muted-foreground">({deliveredBy.length} online)</span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="border-t-2 border-border p-4 bg-card/50">
                  <form
                    className="max-w-4xl mx-auto"
                    onSubmit={(e) => {
                      e.preventDefault()
                      handleSendMessage()
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-11 w-11 shrink-0"
                        disabled={!canSendMessages}
                        onClick={handleSendAttachment}
                        title="Attach file"
                      >
                        <Paperclip className="h-4 w-4" />
                      </Button>
                      <input
                        type="text"
                        value={messageDraft}
                        onChange={(e) => setMessageDraft(e.target.value)}
                        placeholder={
                          canSendMessages
                            ? 'Message (live-only)'
                            : beaconStatus !== 'connected'
                              ? 'Beacon disconnected - messages unavailable'
                              : 'Messaging unavailable for this connection mode'
                        }
                        className="w-full px-4 py-3 bg-background border border-border rounded-lg text-sm font-light focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
                        disabled={!canSendMessages}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="h-11 px-4 gap-2"
                        disabled={!canSendMessages || messageDraft.trim().length === 0}
                      >
                        <Send className="h-4 w-4" />
                        Send
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Encrypted messaging with sender-hosted attachments. Recipients download directly from the original sender while both are online.
                    </p>
                  </form>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-8">
              <p className="text-muted-foreground text-sm font-light">Loading…</p>
            </div>
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
                disabled={isCreatingInvite || beaconStatus !== 'connected' || !beaconUrl}
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
              ? profile.show_real_name ? profile.real_name : null
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

export default ServerViewPage
