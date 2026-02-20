import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, Copy, Check, PhoneOff, Phone, Send, Paperclip, Download, Eye, EyeOff, Trash2, Play, Plus, Minus, X, Volume2, VolumeX } from 'lucide-react'
import { open, confirm } from '@tauri-apps/api/dialog'
import { listen } from '@tauri-apps/api/event'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { Button } from '../components/ui/button'
import { loadServer, type Server, fetchAndImportServerHintOpaque, createTemporaryInvite, revokeActiveInvite, getFileMetadata, registerAttachmentFromPath, getAttachmentRecord } from '../lib/tauri'
import { UserProfileCard } from '../components/UserProfileCard'
import { UserCard } from '../components/UserCard'
import { useIdentity } from '../contexts/IdentityContext'
import { useProfile } from '../contexts/ProfileContext'
import { useRemoteProfiles } from '../contexts/RemoteProfilesContext'
import { useFriends } from '../contexts/FriendsContext'
import { useAccount } from '../contexts/AccountContext'
import { useWebRTC } from '../contexts/WebRTCContext'
import { Slider } from '../components/ui/slider'
import { Label } from '../components/ui/label'
import { BeaconStatus } from '../components/BeaconStatus'
import { useBeacon } from '../contexts/BeaconContext'
import { TransferCenterButton } from '../components/TransferCenterButton'
import { NotificationCenterButton } from '../components/NotificationCenterButton'
import { FilenameEllipsis } from '../components/FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { usePresence, type PresenceLevel } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useSpeaking } from '../contexts/SpeakingContext'
import { useActiveServer } from '../contexts/ActiveServerContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { cn } from '../lib/utils'
import { getDraft, setDraft, clearDraft } from '../lib/messageDrafts'
import { FileIcon } from '../components/FileIcon'
import { MediaPreviewModal } from '../components/MediaPreviewModal'
import { isMediaType, getFileTypeFromExt } from '../lib/fileType'

/** Strip to 8-char code for display/copy (XXXX-XXXX), same pattern as friend code. */
function normalizeInviteCode(code: string): string {
  return (code ?? '').replace(/\W/g, '').toUpperCase().slice(0, 8)
}

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
  const {
    joinVoice,
    leaveVoice,
    isInVoice: webrtcIsInVoice,
    currentRoomId,
    setRemoteUserVolume,
    setRemoteUserMuted,
    getRemoteUserPrefs,
  } = useWebRTC()
  const {
    getMessages,
    openServerChat,
    sendMessage,
    sendAttachmentMessage,
    requestAttachmentDownload,
    attachmentTransfers,
    transferHistory,
    sharedAttachments,
    hasAccessibleCompletedDownload,
  } = useEphemeralMessages()
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
  const [showInviteCodePopover, setShowInviteCodePopover] = useState(false)
  const [revealInviteCode, setRevealInviteCode] = useState(false)
  const [inviteCodeButtonRect, setInviteCodeButtonRect] = useState<DOMRect | null>(null)
  const inviteCodeButtonRef = useRef<HTMLButtonElement>(null)
  const [profileCardUserId, setProfileCardUserId] = useState<string | null>(null)
  const [profileCardAnchor, setProfileCardAnchor] = useState<DOMRect | null>(null)
  const [voiceVolumeMenu, setVoiceVolumeMenu] = useState<{ userId: string; displayName: string; x: number; y: number } | null>(null)
  const voiceVolumeMenuRef = useRef<HTMLDivElement>(null)
  const [messageDraft, setMessageDraft] = useState('')
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const wasAtBottomRef = useRef(true)
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null)
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftValueRef = useRef('')

  type StagedAttachment = {
    staged_id: string
    path: string
    file_name: string
    extension: string
    size_bytes: number
    storage_mode: 'current_path' | 'program_copy'
    spoiler?: boolean
  }
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([])
  const [mediaPreview, setMediaPreview] = useState<{
    type: 'image' | 'video'
    url: string | null
    attachmentId?: string
    fileName?: string
  } | null>(null)
  const [revealedSpoilerIds, setRevealedSpoilerIds] = useState<Set<string>>(new Set())

  const MESSAGE_INPUT_MAX_HEIGHT = 100
  const DRAFT_SAVE_DEBOUNCE_MS = 300
  const MESSAGE_MAX_LENGTH = 2500

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
      backgroundColor: `hsl(${h}, 45%, 35%)`,
      color: '#fff',
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

  // Close voice volume menu on click outside
  useEffect(() => {
    if (!voiceVolumeMenu) return
    const onMouseDown = (e: MouseEvent) => {
      if (voiceVolumeMenuRef.current && !voiceVolumeMenuRef.current.contains(e.target as Node)) {
        setVoiceVolumeMenu(null)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [voiceVolumeMenu])

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

  const waitForAttachmentReady = (attachmentId: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const unlistenRef = { current: null as (() => void) | null }
      listen<{ attachment_id: string; ok: boolean; error?: string }>('cordia:attachment-ready', (event) => {
        if (event.payload?.attachment_id !== attachmentId) return
        unlistenRef.current?.()
        if (event.payload.ok) resolve()
        else reject(new Error(event.payload?.error ?? 'Attachment preparation failed'))
      }).then((fn) => {
        unlistenRef.current = fn
      })
    })

  const handleSendMessage = async () => {
    if (!server || !groupChat || !identity || !canSendMessages) return
    const text = messageDraft.trim().slice(0, MESSAGE_MAX_LENGTH)
    if (!text && stagedAttachments.length === 0) return

    setMessageDraft('')
    if (currentAccountId) clearDraft(currentAccountId, server.signing_pubkey)
    const toSend = [...stagedAttachments]
    setStagedAttachments([])

    try {
      if (text) {
        await sendMessage({
          serverId: server.id,
          signingPubkey: server.signing_pubkey,
          chatId: groupChat.id,
          fromUserId: identity.user_id,
          text,
        })
      }
      for (const att of toSend) {
        const registered = await registerAttachmentFromPath(att.path, att.storage_mode)
        await waitForAttachmentReady(registered.attachment_id)
        const rec = await getAttachmentRecord(registered.attachment_id)
        if (!rec?.sha256) throw new Error('Attachment not ready')
        await sendAttachmentMessage({
          serverId: server.id,
          signingPubkey: server.signing_pubkey,
          chatId: groupChat.id,
          fromUserId: identity.user_id,
          attachment: {
            attachment_id: rec.attachment_id,
            file_name: rec.file_name,
            extension: rec.extension,
            size_bytes: rec.size_bytes,
            sha256: rec.sha256,
            spoiler: att.spoiler ?? false,
          },
        })
      }
    } catch (error) {
      console.warn('Failed to send:', error)
      setMessageDraft(text)
      setStagedAttachments(toSend)
    }
  }

  const handleAddAttachment = async () => {
    if (!server || !groupChat || !identity || !canSendMessages) return
    try {
      const selected = await open({
        title: 'Select attachment(s)',
        multiple: true,
      })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length === 0) return
      const copyToCordia = await confirm(
        `Copy ${paths.length} file(s) into Cordia storage when sending?`,
        { title: 'Attachment storage', okLabel: 'Copy to Cordia', cancelLabel: 'Keep current path' }
      )
      const storage_mode = copyToCordia ? 'program_copy' : 'current_path'
      for (const p of paths) {
        const meta = await getFileMetadata(p)
        setStagedAttachments((prev) => [
          ...prev,
          {
            staged_id: `${p}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            path: p,
            file_name: meta.file_name,
            extension: meta.extension,
            size_bytes: meta.size_bytes,
            storage_mode,
            spoiler: false,
          },
        ])
      }
    } catch (error) {
      console.warn('Failed to add attachment:', error)
    }
  }

  const handleRemoveStagedAttachment = (stagedId: string) => {
    setStagedAttachments((prev) => prev.filter((a) => a.staged_id !== stagedId))
  }

  const handleToggleStagedSpoiler = (stagedId: string) => {
    setStagedAttachments((prev) =>
      prev.map((a) => (a.staged_id === stagedId ? { ...a, spoiler: !a.spoiler } : a))
    )
  }

  useEffect(() => {
    if (!server || !groupChat) return
    openServerChat(server.id, server.signing_pubkey, groupChat.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id, server?.signing_pubkey, groupChat?.id])

  // Restore per-server draft when entering or switching servers; clear staged attachments
  useEffect(() => {
    setStagedAttachments([])
    if (!server?.signing_pubkey || !currentAccountId) return
    const draft = getDraft(currentAccountId, server.signing_pubkey)
    setMessageDraft(draft)
    draftValueRef.current = draft
  }, [server?.signing_pubkey, currentAccountId])

  // Flush draft to sessionStorage on unmount (e.g. navigate away)
  useEffect(() => {
    return () => {
      if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current)
      if (server?.signing_pubkey && currentAccountId) {
        setDraft(currentAccountId, server.signing_pubkey, draftValueRef.current)
      }
    }
  }, [server?.signing_pubkey, currentAccountId])

  // Auto-resize message input (Discord-style: grow up to max, then scroll)
  // requestAnimationFrame coalesces rapid updates (e.g. key repeat) to avoid layout thrashing
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = messageInputRef.current
      if (!el) return
      el.style.height = 'auto'
      const capped = Math.min(el.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT)
      el.style.height = `${capped}px`
      const isScrollable = el.scrollHeight > MESSAGE_INPUT_MAX_HEIGHT
      el.style.overflowY = isScrollable ? 'auto' : 'hidden'
      // Only scroll to bottom when caret is at end (typing new lines at end). Don't jump when editing in the middle.
      if (isScrollable && el.selectionStart === el.value.length) {
        el.scrollTop = el.scrollHeight
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [messageDraft])

  useEffect(() => {
    wasAtBottomRef.current = true
  }, [serverId, groupChat?.id])

  useEffect(() => {
    if (!groupChat || !chatScrollRef.current || chatMessages.length === 0) return
    if (!wasAtBottomRef.current) return
    const el = chatScrollRef.current
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [chatMessages, groupChat?.id])

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
            <NotificationCenterButton />
            <TransferCenterButton />
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
                  <div className="min-w-0" />
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
                        const voiceRp = userId === identity?.user_id ? null : remoteProfiles.getProfile(userId)
                        const voiceAvatarUrl = userId === identity?.user_id ? profile.avatar_data_url : voiceRp?.avatar_data_url
                        const isRemote = userId !== identity?.user_id
                        const prefs = getRemoteUserPrefs(userId)
                        return (
                          <button
                            key={userId}
                            type="button"
                            className={cn(
                              "relative h-6 w-6 shrink-0 grid place-items-center rounded-none ring-2 will-change-transform transition-all duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06] focus:outline-none overflow-hidden",
                              isSpeaking ? "ring-green-500" : "ring-background"
                            )}
                            style={!voiceAvatarUrl ? avatarStyleForUser(userId) : undefined}
                            onClick={(e) => {
                              e.stopPropagation()
                              setProfileCardUserId(userId)
                              setProfileCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
                            }}
                            onContextMenu={isRemote ? (e) => {
                              e.preventDefault()
                              setVoiceVolumeMenu({ userId, displayName, x: e.clientX, y: e.clientY })
                            } : undefined}
                            aria-label={displayName}
                            title={isRemote ? `${displayName} — Right-click for volume` : `${displayName} (you)`}
                          >
                            {voiceAvatarUrl ? (
                              <img src={voiceAvatarUrl} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <span className="text-[9px] font-mono tracking-wider">{getInitials(displayName)}</span>
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
                  )
                })()}
              </div>

              {/* Text Chat Area */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div
                  ref={chatScrollRef}
                  className="flex-1 overflow-y-auto p-4 pt-2"
                  onScroll={() => {
                    const el = chatScrollRef.current
                    if (!el) return
                    const threshold = 80
                    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
                  }}
                >
                  <div className="max-w-6xl mx-auto">
                    {chatMessages.length === 0 && (
                      <div className="flex justify-center py-12">
                        <p className="text-sm text-muted-foreground font-light">
                          Welcome to <span className="text-foreground font-normal">{server.name}</span> — your group chat.
                        </p>
                      </div>
                    )}
                    {chatMessages.length > 0 && (() => {
                      type ChatItem = { type: 'day'; dateStr: string } | { type: 'group'; userId: string; messages: typeof chatMessages }
                      const items: ChatItem[] = []
                      let lastDateStr: string | null = null
                      let currentGroup: { userId: string; messages: typeof chatMessages } | null = null

                      const flushGroup = () => {
                        if (currentGroup && currentGroup.messages.length > 0) {
                          items.push({ type: 'group', userId: currentGroup.userId, messages: currentGroup.messages })
                          currentGroup = null
                        }
                      }

                      const formatDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

                      const FIVE_MIN_MS = 5 * 60 * 1000
                      for (const msg of chatMessages) {
                        const msgDate = new Date(msg.sent_at)
                        const dateStr = formatDay(msgDate)
                        if (dateStr !== lastDateStr) {
                          flushGroup()
                          lastDateStr = dateStr
                          items.push({ type: 'day', dateStr })
                        }
                        const prevMsg = currentGroup?.messages[currentGroup.messages.length - 1]
                        const isContinuation = currentGroup
                          && currentGroup.userId === msg.from_user_id
                          && prevMsg
                          && (msgDate.getTime() - new Date(prevMsg.sent_at).getTime()) < FIVE_MIN_MS
                        if (!isContinuation) {
                          flushGroup()
                          currentGroup = { userId: msg.from_user_id, messages: [msg] }
                        } else {
                          currentGroup!.messages.push(msg)
                        }
                      }
                      flushGroup()

                      let lastDeliveredMessageId: string | null = null
                      let lastPendingMessageId: string | null = null
                      for (const msg of chatMessages) {
                        if (msg.from_user_id !== identity?.user_id) continue
                        if (msg.delivery_status === 'delivered') lastDeliveredMessageId = msg.id
                        else lastPendingMessageId = msg.id
                      }

                      return (
                        <div className="space-y-2">
                          {items.map((item, idx) => {
                            if (item.type === 'day') {
                              return (
                                <div key={`day-${idx}`} className="flex items-center gap-3 py-2" aria-hidden>
                                  <div className="h-px flex-1 bg-muted-foreground/50" />
                                  <span className="text-xs text-muted-foreground shrink-0">{item.dateStr}</span>
                                  <div className="h-px flex-1 bg-muted-foreground/50" />
                                </div>
                              )
                            }
                            const { userId, messages } = item
                            const displayName = userId === identity?.user_id ? (identity?.display_name ?? 'You') : fallbackNameForUser(userId)
                            const rp = userId === identity?.user_id ? null : remoteProfiles.getProfile(userId)
                            const avatarUrl = userId === identity?.user_id ? profile.avatar_data_url : rp?.avatar_data_url
                            const memberLevel = getMemberLevel(server.signing_pubkey, userId, voicePresence.isUserInVoice(server.signing_pubkey, userId))
                            const levelColor = memberLevel === 'in_call' ? 'text-blue-500' : memberLevel === 'active' ? 'text-green-500' : memberLevel === 'online' ? 'text-amber-500' : 'text-muted-foreground'
                            return (
                              <div key={`group-${idx}-${messages[0]?.id}`} className="flex gap-2">
                                <div className="shrink-0 w-8 flex flex-col items-center pt-0.5 self-start sticky top-0 z-10 bg-background pb-1">
                                  <div className="relative overflow-visible will-change-transform transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06]">
                                    <div className="absolute -left-1 top-1/2 -translate-y-1/2 z-10">
                                      <PresenceSquare level={memberLevel} />
                                    </div>
                                    <button
                                      type="button"
                                      className="relative h-8 w-8 grid place-items-center rounded-none ring-2 ring-background shrink-0 focus:outline-none overflow-hidden"
                                      style={!avatarUrl ? avatarStyleForUser(userId) : undefined}
                                      onClick={(e) => {
                                        setProfileCardUserId(userId)
                                        setProfileCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
                                      }}
                                      aria-label={displayName}
                                    >
                                      {avatarUrl ? (
                                        <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                                      ) : (
                                        <span className="text-[9px] font-mono tracking-wider">{getInitials(displayName)}</span>
                                      )}
                                    </button>
                                  </div>
                                </div>
                                <div className="min-w-0 flex-1 flex flex-col">
                                  {messages.map((msg, msgIdx) => {
                                    const isFirstInGroup = msgIdx === 0
                                    const attachmentTransferRows = msg.kind === 'attachment' && msg.attachment
                                      ? attachmentTransfers.filter(
                                          (t) => t.message_id === msg.id || t.attachment_id === msg.attachment?.attachment_id
                                        )
                                      : []
                                    const alreadyDownloadedAccessible = msg.kind === 'attachment' && msg.attachment
                                      ? hasAccessibleCompletedDownload(msg.attachment.attachment_id)
                                      : false
                                    const hasActiveDownload = attachmentTransferRows.some(
                                      (t) =>
                                        t.direction === 'download' &&
                                        t.status !== 'completed' &&
                                        t.status !== 'failed' &&
                                        t.status !== 'rejected'
                                    )
                                    const hostOnlineForAttachment = msg.kind === 'attachment'
                                      ? getLevel(server.signing_pubkey, msg.from_user_id, voicePresence.isUserInVoice(server.signing_pubkey, msg.from_user_id)) !== 'offline'
                                      : false
                                    const senderSharedReady = msg.kind === 'attachment' && msg.attachment
                                      ? sharedAttachments.some((s) => s.attachment_id === msg.attachment?.attachment_id && s.can_share_now)
                                      : false
                                    const attachmentStateLabel = msg.kind === 'attachment' && msg.attachment
                                      ? alreadyDownloadedAccessible
                                        ? 'Cached'
                                        : msg.from_user_id === identity?.user_id
                                          ? senderSharedReady
                                            ? 'Available'
                                            : 'Unavailable'
                                          : hostOnlineForAttachment
                                            ? 'Available'
                                            : 'Unavailable'
                                      : null
                                    const timeStr = new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                    return (
                                      <div
                                        key={msg.id}
                                        className="group/msg py-px px-1 -mx-1 rounded transition-colors cursor-default"
                                        style={{ backgroundColor: hoveredMsgId === msg.id ? 'hsl(var(--muted) / 0.85)' : undefined }}
                                        onMouseEnter={() => setHoveredMsgId(msg.id)}
                                        onMouseLeave={() => setHoveredMsgId(null)}
                                      >
                                        {isFirstInGroup ? (
                                          <div className="flex items-baseline gap-2 flex-wrap">
                                            <span className={cn('text-sm font-medium', levelColor)}>{displayName}</span>
                                            <span className="text-[10px] text-muted-foreground">
                                              {timeStr}
                                            </span>
                                          </div>
                                        ) : null}
                                        <div className={cn(isFirstInGroup ? 'mt-0.5' : '')}>
                                          {msg.kind === 'attachment' && msg.attachment ? (
                                            <div className="py-2">
                                              <div
                                                className={cn(
                                                  'relative rounded-lg transition-all',
                                                  msg.attachment.spoiler && !revealedSpoilerIds.has(msg.id) && 'overflow-hidden'
                                                )}
                                              >
                                                {msg.attachment.spoiler && !revealedSpoilerIds.has(msg.id) ? (
                                                  <button
                                                    type="button"
                                                    onClick={() =>
                                                      setRevealedSpoilerIds((prev) => new Set(prev).add(msg.id))
                                                    }
                                                    className="w-full py-4 px-4 bg-muted/80 hover:bg-muted rounded-lg text-center"
                                                  >
                                                    <EyeOff className="h-5 w-5 mx-auto mb-1.5 text-muted-foreground" />
                                                    <span className="text-xs text-muted-foreground block">
                                                      Spoiler • Click to reveal
                                                    </span>
                                                  </button>
                                                ) : (() => {
                                                  const att = msg.attachment!
                                                  const isOwn = msg.from_user_id === identity?.user_id
                                                  const sharedItem = sharedAttachments.find((s) => s.attachment_id === att.attachment_id)
                                                  const completedDownload = transferHistory.find(
                                                    (h) => h.direction === 'download' && h.attachment_id === att.attachment_id && h.status === 'completed' && h.saved_path
                                                  )
                                                  const liveDownload = attachmentTransferRows.find(
                                                    (t) => t.direction === 'download' && (t.status === 'transferring' || t.status === 'requesting' || t.status === 'connecting')
                                                  )
                                                  const hasPath = isOwn ? sharedItem?.file_path : completedDownload?.saved_path
                                                  const thumbPath = isOwn ? sharedItem?.thumbnail_path : undefined
                                                  const category = getFileTypeFromExt(att.file_name)
                                                  const isMedia = isMediaType(category as Parameters<typeof isMediaType>[0])
                                                  const mediaPreviewPath = category === 'video'
                                                    ? (thumbPath || hasPath)
                                                    : (hasPath || thumbPath)
                                                  const notDownloaded = !isOwn && !alreadyDownloadedAccessible && !hasPath
                                                  const p = liveDownload ? Math.max(0, Math.min(100, Math.round((liveDownload.progress ?? 0) * 100))) : 0
                                                  const showProgress = !!liveDownload && (liveDownload.status === 'transferring' || liveDownload.status === 'completed')
                                                  const CHAT_MEDIA_MAX_W = 320
                                                  const CHAT_MEDIA_MAX_H = 240
                                                  if (isMedia) {
                                                    return (
                                                      <div className="space-y-1">
                                                        <div
                                                          className={cn(
                                                            'relative rounded-lg overflow-hidden border border-border/50',
                                                            notDownloaded && 'bg-muted/60'
                                                          )}
                                                          style={{
                                                            maxWidth: CHAT_MEDIA_MAX_W,
                                                            maxHeight: CHAT_MEDIA_MAX_H,
                                                            ...(notDownloaded ? { width: 280, aspectRatio: '16/9', minHeight: 158 } : { width: 'fit-content', minWidth: 160, minHeight: 120 }),
                                                          }}
                                                        >
                                                          {notDownloaded ? (
                                                            <button
                                                              type="button"
                                                              className="w-full h-full min-h-[140px] flex items-center justify-center transition-colors hover:bg-muted/80"
                                                              style={{ aspectRatio: '16/9' }}
                                                              title={attachmentStateLabel === 'Available' ? 'Click to download' : 'Not downloaded'}
                                                              onClick={attachmentStateLabel === 'Available' ? () => requestAttachmentDownload(msg) : undefined}
                                                              disabled={attachmentStateLabel !== 'Available'}
                                                            >
                                                              <Download className="h-12 w-12 text-white" />
                                                            </button>
                                                          ) : category === 'image' && hasPath ? (
                                                            <button
                                                              type="button"
                                                              className="block w-full overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
                                                              onClick={() =>
                                                                setMediaPreview({
                                                                  type: 'image',
                                                                  url: convertFileSrc(hasPath),
                                                                  fileName: att.file_name,
                                                                })
                                                              }
                                                            >
                                                              <img
                                                                src={convertFileSrc(hasPath)}
                                                                alt=""
                                                                className="max-w-full max-h-[240px] w-auto h-auto object-contain block"
                                                              />
                                                            </button>
                                                          ) : category === 'video' && hasPath ? (
                                                            <button
                                                              type="button"
                                                              className="relative block w-full overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background group"
                                                              onClick={() =>
                                                                setMediaPreview({
                                                                  type: 'video',
                                                                  url: convertFileSrc(hasPath),
                                                                  fileName: att.file_name,
                                                                })
                                                              }
                                                            >
                                                              {thumbPath ? (
                                                                <img
                                                                  src={convertFileSrc(thumbPath)}
                                                                  alt=""
                                                                  className="max-w-full max-h-[240px] w-auto h-auto object-contain block"
                                                                />
                                                              ) : (
                                                                <video
                                                                  src={convertFileSrc(hasPath)}
                                                                  className="max-w-full max-h-[240px] w-auto h-auto object-contain block"
                                                                  muted
                                                                  playsInline
                                                                  preload="metadata"
                                                                />
                                                              )}
                                                              <span className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors pointer-events-none">
                                                                <span className="w-12 h-12 rounded-md bg-black/50 flex items-center justify-center">
                                                                  <Play className="h-6 w-6 text-white fill-white" />
                                                                </span>
                                                              </span>
                                                            </button>
                                                          ) : (
                                                            <FileIcon
                                                              fileName={att.file_name}
                                                              attachmentId={!hasPath && (isOwn ? sharedItem?.can_share_now : false) ? att.attachment_id : null}
                                                              savedPath={hasPath ?? undefined}
                                                              thumbnailPath={thumbPath ?? undefined}
                                                              onMediaClick={(url, type, attachmentId, fileName) => {
                                                                setMediaPreview({
                                                                  type: type as 'image' | 'video',
                                                                  url: url ?? (attachmentId ? null : mediaPreviewPath ? convertFileSrc(mediaPreviewPath) : null),
                                                                  attachmentId,
                                                                  fileName: fileName ?? att.file_name,
                                                                })
                                                              }}
                                                              boxSize={120}
                                                            />
                                                          )}
                                                        </div>
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                          <FilenameEllipsis name={att.file_name} className="text-xs truncate" />
                                                          <span className="text-[10px] text-muted-foreground shrink-0">
                                                            {formatBytes(att.size_bytes)}
                                                            {att.extension ? ` .${att.extension}` : ''}
                                                          </span>
                                                        </div>
                                                        {showProgress && (
                                                          <div className="h-1 bg-foreground/15 overflow-hidden rounded-full max-w-[280px]">
                                                            <div
                                                              className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                              style={{ width: `${Math.max(2, p)}%` }}
                                                            />
                                                          </div>
                                                        )}
                                                        {liveDownload?.status === 'completed' && liveDownload.saved_path && (
                                                          <span className="block text-[9px] text-muted-foreground truncate" title={liveDownload.saved_path}>
                                                            Saved
                                                          </span>
                                                        )}
                                                      </div>
                                                    )
                                                  }
                                                  return (
                                                    <div
                                                      className={cn(
                                                        'flex gap-2 items-start border border-border/50 bg-card/60 rounded-lg px-2 py-1.5 max-w-[280px]',
                                                        notDownloaded && 'opacity-70 bg-muted/60'
                                                      )}
                                                    >
                                                      {notDownloaded ? (
                                                        <button
                                                          type="button"
                                                          className={cn(
                                                            'shrink-0 w-10 h-10 flex items-center justify-center rounded bg-muted/80 transition-colors',
                                                            attachmentStateLabel === 'Available' && 'hover:bg-muted cursor-pointer'
                                                          )}
                                                          title={attachmentStateLabel === 'Available' ? 'Click to download' : 'Not downloaded'}
                                                          onClick={attachmentStateLabel === 'Available' ? () => requestAttachmentDownload(msg) : undefined}
                                                          disabled={attachmentStateLabel !== 'Available'}
                                                        >
                                                          <Download className="h-5 w-5 text-white" />
                                                        </button>
                                                      ) : (
                                                        <FileIcon
                                                          fileName={att.file_name}
                                                          attachmentId={!hasPath && (isOwn ? sharedItem?.can_share_now : false) ? att.attachment_id : null}
                                                          savedPath={hasPath ?? undefined}
                                                          thumbnailPath={thumbPath ?? undefined}
                                                          onMediaClick={(url, type, attachmentId, fileName) => {
                                                            if (isMedia) {
                                                              setMediaPreview({
                                                                type: type as 'image' | 'video',
                                                                url: url ?? (attachmentId ? null : mediaPreviewPath ? convertFileSrc(mediaPreviewPath) : null),
                                                                attachmentId,
                                                                fileName: fileName ?? att.file_name,
                                                              })
                                                            }
                                                          }}
                                                          boxSize={40}
                                                        />
                                                      )}
                                                      <div className="min-w-0 flex-1 py-0.5">
                                                        <FilenameEllipsis name={att.file_name} className="block text-xs truncate leading-4" />
                                                        <div className="text-[10px] text-muted-foreground truncate">
                                                          {formatBytes(att.size_bytes)}
                                                          {att.extension ? ` .${att.extension}` : ''}
                                                        </div>
                                                        {showProgress && (
                                                          <div className="mt-1 h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                            <div
                                                              className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                              style={{ width: `${Math.max(2, p)}%` }}
                                                            />
                                                          </div>
                                                        )}
                                                        {liveDownload?.status === 'completed' && liveDownload.saved_path && (
                                                          <span className="block text-[9px] text-muted-foreground truncate mt-0.5" title={liveDownload.saved_path}>
                                                            Saved
                                                          </span>
                                                        )}
                                                      </div>
                                                      <div className="shrink-0 flex flex-col gap-0.5 justify-center">
                                                        {!notDownloaded && !isOwn && !alreadyDownloadedAccessible && !hasActiveDownload && attachmentStateLabel === 'Available' && (
                                                          <Button
                                                            type="button"
                                                            variant="outline"
                                                            size="icon"
                                                            className="h-7 w-7"
                                                            onClick={() => requestAttachmentDownload(msg)}
                                                            title="Download"
                                                          >
                                                            <Download className="h-3.5 w-3.5" />
                                                          </Button>
                                                        )}
                                                      </div>
                                                    </div>
                                                  )
                                                })()}
                                              </div>
                                            </div>
                                          ) : (
                                            <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
                                          )}
                                        </div>
                                        {msg.from_user_id === identity?.user_id && (msg.id === lastDeliveredMessageId || msg.id === lastPendingMessageId) && (
                                          <div className="text-[10px] text-muted-foreground mt-0.5">
                                            {msg.id === lastDeliveredMessageId ? 'Delivered' : 'Pending'}
                                            {msg.id === lastPendingMessageId && (msg.delivered_by ?? []).filter((uid) => uid !== identity?.user_id).length > 0 && (
                                              <span className="ml-1">({(msg.delivered_by ?? []).filter((uid) => uid !== identity?.user_id).length} online)</span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}
                  </div>
                </div>

                <div className="border-t-2 border-border p-4 bg-card/50">
                  {mediaPreview && (
                    <MediaPreviewModal
                      type={mediaPreview.type}
                      url={mediaPreview.url}
                      attachmentId={mediaPreview.attachmentId}
                      fileName={mediaPreview.fileName}
                      onClose={() => {
                        if (mediaPreview.url?.startsWith('blob:')) URL.revokeObjectURL(mediaPreview.url)
                        setMediaPreview(null)
                      }}
                    />
                  )}
                  <form
                    className="max-w-6xl mx-auto"
                    onSubmit={(e) => {
                      e.preventDefault()
                      handleSendMessage()
                    }}
                  >
                    {stagedAttachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {stagedAttachments.map((att) => {
                          const category = att.file_name ? getFileTypeFromExt(att.file_name) : 'default'
                          const isMedia = att.file_name && isMediaType(category as Parameters<typeof isMediaType>[0])
                          return (
                            <div
                              key={att.staged_id}
                              className="flex items-start gap-2 w-[165px] h-[80px] shrink-0 border-2 border-border bg-card rounded-lg px-2 py-2 overflow-hidden"
                            >
                              <FileIcon
                                fileName={att.file_name}
                                attachmentId={null}
                                savedPath={att.path}
                                onMediaClick={(url, type, _attachmentId, fileName) => {
                                  if (isMedia) {
                                    setMediaPreview({
                                      type: type as 'image' | 'video',
                                      url: url ?? convertFileSrc(att.path),
                                      attachmentId: undefined,
                                      fileName: fileName ?? att.file_name,
                                    })
                                  }
                                }}
                                boxSize={48}
                              />
                              <div className="min-w-0 flex-1 flex flex-col gap-1">
                                <FilenameEllipsis name={att.file_name} className="text-xs truncate" />
                                <div className="flex items-center gap-1">
                                  <span className="text-[10px] text-muted-foreground">{formatBytes(att.size_bytes)}</span>
                                </div>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className={cn('h-6 w-6', att.spoiler && 'text-amber-500')}
                                    onClick={() => handleToggleStagedSpoiler(att.staged_id)}
                                    title={att.spoiler ? 'Marked as spoiler' : 'Mark as spoiler'}
                                  >
                                    {att.spoiler ? (
                                      <EyeOff className="h-3.5 w-3.5" />
                                    ) : (
                                      <Eye className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-red-300 hover:text-red-200"
                                    onClick={() => handleRemoveStagedAttachment(att.staged_id)}
                                    title="Remove"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-11 w-11 shrink-0"
                        disabled={!canSendMessages}
                        onClick={handleAddAttachment}
                        title="Attach file(s)"
                      >
                        <Paperclip className="h-4 w-4" />
                      </Button>
                      <textarea
                        ref={messageInputRef}
                        value={messageDraft}
                        onChange={(e) => {
                          const v = e.target.value
                          setMessageDraft(v)
                          draftValueRef.current = v
                          if (server && currentAccountId) {
                            if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current)
                            draftSaveTimeoutRef.current = setTimeout(() => {
                              setDraft(currentAccountId, server.signing_pubkey, v)
                              draftSaveTimeoutRef.current = null
                            }, DRAFT_SAVE_DEBOUNCE_MS)
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            handleSendMessage()
                          }
                        }}
                        placeholder={
                          canSendMessages
                            ? ''
                            : beaconStatus !== 'connected'
                              ? 'Beacon disconnected - messages unavailable'
                              : 'Messaging unavailable for this connection mode'
                        }
                        rows={1}
                        maxLength={MESSAGE_MAX_LENGTH}
                        style={{ maxHeight: MESSAGE_INPUT_MAX_HEIGHT }}
                        className="w-full min-h-[44px] resize-none overflow-y-hidden [scrollbar-gutter:stable_both-edges] px-4 py-3 bg-background border border-border rounded-lg text-sm font-light focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
                        disabled={!canSendMessages}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="h-11 px-4 gap-2 shrink-0"
                        disabled={
                          !canSendMessages ||
                          (messageDraft.trim().length === 0 && stagedAttachments.length === 0)
                        }
                      >
                        <Send className="h-4 w-4" />
                        Send
                      </Button>
                    </div>
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

        {/* Right Sidebar - Members List (same width as friends list: 12.25rem) */}
        <div className="w-[12.25rem] shrink-0 border-l-2 border-border bg-card/50 flex flex-col">
          <div className="p-4 pt-5 space-y-2 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between shrink-0 h-8">
              <h2 className="text-xs font-light tracking-wider uppercase text-muted-foreground px-2 leading-none">
                Members — {(server.members ?? []).length}
              </h2>
              <div>
                <Button
                  ref={inviteCodeButtonRef}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    if (showInviteCodePopover) {
                      setShowInviteCodePopover(false)
                      setRevealInviteCode(false)
                      setInviteCodeButtonRect(null)
                    } else {
                      const rect = inviteCodeButtonRef.current?.getBoundingClientRect()
                      setInviteCodeButtonRect(rect ?? null)
                      setShowInviteCodePopover(true)
                    }
                  }}
                  title={showInviteCodePopover ? 'Close invite code' : 'Invite code'}
                >
                  {showInviteCodePopover ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-0.5">
              {(server.members ?? []).map((member) => {
                const rp = remoteProfiles.getProfile(member.user_id)
                const displayName = member.display_name
                const level = getMemberLevel(
                  server.signing_pubkey,
                  member.user_id,
                  voicePresence.isUserInVoice(server.signing_pubkey, member.user_id)
                )
                return (
                  <button
                    key={member.user_id}
                    type="button"
                    className="flex gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors w-full text-left min-w-0 overflow-visible"
                    onClick={(e) => {
                      setProfileCardUserId(member.user_id)
                      setProfileCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
                    }}
                  >
                    <div
                      className="relative h-7 w-7 shrink-0 grid place-items-center rounded-none ring-2 ring-background will-change-transform transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06] overflow-visible"
                      style={!rp?.avatar_data_url ? avatarStyleForUser(member.user_id) : undefined}
                    >
                      {rp?.avatar_data_url ? (
                        <img src={rp.avatar_data_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[9px] font-mono tracking-wider">{getInitials(displayName)}</span>
                      )}
                      <div className="absolute -top-1 left-1/2 -translate-x-1/2">
                        <PresenceSquare level={level} />
                      </div>
                    </div>
                    <div className="min-w-0 flex-1 flex flex-col justify-center">
                      <p className="text-xs font-light truncate">{displayName}</p>
                      {rp?.show_secondary && rp.secondary_name ? (
                        <p className="text-[11px] text-muted-foreground truncate">{rp.secondary_name}</p>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Invite code popover portal - renders outside sidebar to avoid clipping by chat */}
      {showInviteCodePopover &&
        inviteCodeButtonRect &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[99]"
              onMouseDown={() => {
                setShowInviteCodePopover(false)
                setRevealInviteCode(false)
                setInviteCodeButtonRect(null)
              }}
              aria-hidden
            />
            <div
              className="fixed z-[100] w-56 border-2 border-border bg-card rounded-lg p-3 shadow-lg space-y-3"
              style={{
                top: inviteCodeButtonRect.bottom + 4,
                right: window.innerWidth - inviteCodeButtonRect.right,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="pb-2 border-b border-border">
                <p className="text-xs text-muted-foreground font-light mb-1">Server invite</p>
                {!server?.has_symmetric_key ? (
                  <p className="text-xs text-muted-foreground">This server cannot create invites (missing key).</p>
                ) : !getActiveInviteUri() ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-start gap-2 font-light bg-white text-black border-white hover:bg-white/90 hover:text-black"
                    disabled={isCreatingInvite || beaconStatus !== 'connected' || !beaconUrl}
                    onClick={async () => {
                      setIsCreatingInvite(true)
                      try {
                        await handleCreateInvite()
                      } catch (e) {
                        console.warn(e)
                      } finally {
                        setIsCreatingInvite(false)
                      }
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {isCreatingInvite ? 'Creating…' : 'Create invite code'}
                  </Button>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground font-light">Your code</p>
                    <button
                      type="button"
                      onClick={() => setRevealInviteCode((v) => !v)}
                      className="w-full text-left"
                    >
                      <div className="flex items-center gap-2">
                        <div className="relative flex items-center gap-1 flex-1 min-w-0">
                          <code className={cn('min-w-[6.5ch] text-sm font-mono tracking-wider uppercase text-center', revealInviteCode ? '' : 'blur-sm select-none text-muted-foreground/80')}>
                            {normalizeInviteCode(getActiveInviteCode() ?? '').slice(0, 4)}
                          </code>
                          <span className="text-muted-foreground font-mono select-none" aria-hidden>-</span>
                          <code className={cn('min-w-[6.5ch] text-sm font-mono tracking-wider uppercase text-center', revealInviteCode ? '' : 'blur-sm select-none text-muted-foreground/80')}>
                            {normalizeInviteCode(getActiveInviteCode() ?? '').slice(4, 8)}
                          </code>
                          {!revealInviteCode && (
                            <div className="absolute inset-0 flex items-center justify-center z-20">
                              <span className="text-[11px] text-black font-light bg-white px-2 py-0.5 rounded-sm flex items-center gap-1.5 shrink-0">
                                <EyeOff className="h-3 w-3" strokeWidth={2} />
                                Reveal
                              </span>
                            </div>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={(e) => {
                            e.stopPropagation()
                            const code = getActiveInviteCode()
                            if (code) {
                              navigator.clipboard.writeText(normalizeInviteCode(code))
                              setCopiedInvite(true)
                              setTimeout(() => setCopiedInvite(false), 2000)
                            }
                          }}
                          title="Copy"
                        >
                          {copiedInvite ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                          onClick={async (e) => {
                            e.stopPropagation()
                            await handleRevokeInvite()
                          }}
                          title="Revoke"
                          disabled={isRevokingInvite}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </button>
                  </>
                )}
              </div>
            </div>
          </>,
          document.body
        )}

      {voiceVolumeMenu &&
        createPortal(
          <div
            ref={voiceVolumeMenuRef}
            className="fixed z-[100] w-56 rounded-md border border-border bg-background p-3 shadow-lg"
            style={{ left: Math.min(voiceVolumeMenu.x, window.innerWidth - 224), top: Math.min(voiceVolumeMenu.y, window.innerHeight - 140) }}
          >
            <p className="text-xs font-medium text-muted-foreground truncate mb-2" title={voiceVolumeMenu.displayName}>
              {voiceVolumeMenu.displayName}
            </p>
            <div className="space-y-3">
              <div>
                <Label className="text-xs">User volume</Label>
                <Slider
                  min={0}
                  max={2}
                  step={0.1}
                  value={getRemoteUserPrefs(voiceVolumeMenu.userId).volume}
                  onValueChange={(v) => setRemoteUserVolume(voiceVolumeMenu.userId, v)}
                  className="mt-1"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Mute (local)</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1"
                  onClick={() => setRemoteUserMuted(voiceVolumeMenu.userId, !getRemoteUserPrefs(voiceVolumeMenu.userId).muted)}
                >
                  {getRemoteUserPrefs(voiceVolumeMenu.userId).muted ? (
                    <VolumeX className="h-3.5 w-3.5" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )}
                  {getRemoteUserPrefs(voiceVolumeMenu.userId).muted ? 'Unmute' : 'Mute'}
                </Button>
              </div>
            </div>
          </div>,
          document.body
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
