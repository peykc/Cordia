import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, Copy, Check, PhoneOff, Phone, Send, Paperclip, Download, Ban, Eye, EyeOff, Trash2, Play, Plus, Minus, X, Volume2, VolumeX, ImageDown, ImageOff, CloudOff, Upload } from 'lucide-react'
import { open, confirm } from '@tauri-apps/api/dialog'
import { listen } from '@tauri-apps/api/event'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { Button } from '../components/ui/button'
import { loadServer, type Server, fetchAndImportServerHintOpaque, createTemporaryInvite, revokeActiveInvite, getFileMetadata, registerAttachmentFromPath, getAttachmentRecord, shareAttachmentAgain } from '../lib/tauri'
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
import { Tooltip } from '../components/Tooltip'
import { FilenameEllipsis } from '../components/FilenameEllipsis'
import { formatBytes } from '../lib/bytes'
import { usePresence, type PresenceLevel } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useSpeaking } from '../contexts/SpeakingContext'
import { useActiveServer } from '../contexts/ActiveServerContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { cn } from '../lib/utils'
import { getDraft, setDraft, clearDraft } from '../lib/messageDrafts'
import { FileIcon, IconForCategory } from '../components/FileIcon'
import { ImageDownPlay } from '../components/icons'
import { CustomVideoPlayer } from '../components/CustomVideoPlayer'
import { ChatMediaSlot, ChatFileRowSlot } from '../components/ChatMediaSlot'
import { useMediaPreview } from '../contexts/MediaPreviewContext'
import { isMediaType, getFileTypeFromExt } from '../lib/fileType'

/** Get intrinsic dimensions for a media URL so we can store aspect on the message (shimmer correct on load). */
function getMediaDimensions(
  url: string,
  category: 'image' | 'video'
): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (category === 'image') {
      const img = new Image()
      img.onload = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          resolve({ w: img.naturalWidth, h: img.naturalHeight })
        } else resolve(null)
      }
      img.onerror = () => resolve(null)
      img.src = url
      return
    }
    const video = document.createElement('video')
    const onDone = (w: number, h: number) => {
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('error', onErr)
      video.src = ''
      resolve(w > 0 && h > 0 ? { w, h } : null)
    }
    const onMeta = () => onDone(video.videoWidth, video.videoHeight)
    const onErr = () => onDone(0, 0)
    video.addEventListener('loadedmetadata', onMeta, { once: true })
    video.addEventListener('error', onErr, { once: true })
    video.preload = 'metadata'
    video.src = url
  })
}

/** Strip to 8-char code for display/copy (XXXX-XXXX), same pattern as friend code. */
function normalizeInviteCode(code: string): string {
  return (code ?? '').replace(/\W/g, '').toUpperCase().slice(0, 8)
}

const NOT_DOWNLOADED_CARD_NARROW_PX = 110

/** Wraps content and measures width; when < threshold, children receive narrow=true (swap download btn to center, hide ImageDown). */
function NotDownloadedCardByWidth({
  threshold,
  className,
  style,
  narrowContent,
  wideContent,
}: {
  threshold: number
  className?: string
  style?: CSSProperties
  narrowContent: ReactNode
  wideContent: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setNarrow(el.offsetWidth < threshold)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])
  return (
    <div ref={ref} className={className} style={style}>
      {narrow ? narrowContent : wideContent}
    </div>
  )
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
    sendMixedMessage,
    requestAttachmentDownload,
    attachmentTransfers,
    transferHistory,
    sharedAttachments,
    hasAccessibleCompletedDownload,
    refreshSharedAttachments,
    notifyAttachmentReshared,
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
  const profileCardAnchorRef = useRef<HTMLElement | null>(null)
  const [voiceVolumeMenu, setVoiceVolumeMenu] = useState<{ userId: string; displayName: string; x: number; y: number } | null>(null)
  const voiceVolumeMenuRef = useRef<HTMLDivElement>(null)
  const [messageDraft, setMessageDraft] = useState('')
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const chatScrollBottomAnchorRef = useRef<HTMLDivElement | null>(null)
  const wasAtBottomRef = useRef(true)
  /** Refs to video container elements so we can scroll the active one into view when exiting fullscreen. */
  const videoScrollTargetsRef = useRef<Record<string, HTMLDivElement | null>>({})
  /** When set, this single-attachment video plays inline in chat (no overlay). */
  const [inlinePlayingVideoId, setInlinePlayingVideoId] = useState<string | null>(null)
  const [inlineVideoShowControls, setInlineVideoShowControls] = useState(false)
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
  const { setMediaPreview } = useMediaPreview()
  const [revealedSpoilerIds, setRevealedSpoilerIds] = useState<Set<string>>(new Set())
  const [unsharedAttachmentRecords, setUnsharedAttachmentRecords] = useState<Record<string, Awaited<ReturnType<typeof getAttachmentRecord>>>>({})
  const fetchedUnsharedIdsRef = useRef<Set<string>>(new Set())
  /** Aspect ratio per single-attachment (msg.id + attachment_id) so container/shimmer follow media ratio. */
  const [singleAttachmentAspect, setSingleAttachmentAspect] = useState<Record<string, { w: number; h: number }>>({})

  const MESSAGE_INPUT_MAX_HEIGHT = 100
  const DRAFT_SAVE_DEBOUNCE_MS = 300
  const MESSAGE_MAX_LENGTH = 2500

  // Single group chat per server (v1: no chat selector)
  const groupChat = server?.chats?.[0] ?? null
  const chatMessages = groupChat ? getMessages(server?.signing_pubkey ?? '', groupChat.id) : []

  // Load attachment records for own messages that are no longer in shared list (unshared) so we can still show the file
  useEffect(() => {
    if (!identity?.user_id || !chatMessages.length) return
    const ids = new Set<string>()
    for (const msg of chatMessages) {
      const list = msg.attachments ?? (msg.attachment ? [msg.attachment] : [])
      for (const att of list) {
        if (msg.from_user_id === identity.user_id && !sharedAttachments.some((s) => s.attachment_id === att.attachment_id)) {
          ids.add(att.attachment_id)
        }
      }
    }
    ids.forEach((id) => {
      if (fetchedUnsharedIdsRef.current.has(id)) return
      fetchedUnsharedIdsRef.current.add(id)
      getAttachmentRecord(id).then((rec) => {
        setUnsharedAttachmentRecords((prev) => ({ ...prev, [id]: rec }))
      })
    })
  }, [chatMessages, sharedAttachments, identity?.user_id])
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
      if (toSend.length > 0) {
        const registered = await Promise.all(
          toSend.map((att) => registerAttachmentFromPath(att.path, att.storage_mode))
        )
        await Promise.all(registered.map((r) => waitForAttachmentReady(r.attachment_id)))
        const records = await Promise.all(registered.map((r) => getAttachmentRecord(r.attachment_id)))
        const isMediaFile = (fileName: string) =>
          isMediaType(getFileTypeFromExt(fileName) as Parameters<typeof isMediaType>[0])
        const dimensions = await Promise.all(
          records.map(async (rec, i) => {
            if (!rec || !isMediaFile(rec.file_name)) return null
            const cat = getFileTypeFromExt(rec.file_name)
            const url = convertFileSrc(toSend[i].path)
            return getMediaDimensions(url, cat === 'video' ? 'video' : 'image')
          })
        )
        const allAttachments = records.map((rec, i) => {
          if (!rec?.sha256) throw new Error('Attachment not ready')
          const dim = dimensions[i]
          return {
            attachment_id: rec.attachment_id,
            file_name: rec.file_name,
            extension: rec.extension,
            size_bytes: rec.size_bytes,
            sha256: rec.sha256,
            spoiler: toSend[i].spoiler ?? false,
            ...(dim && { aspect_ratio_w: dim.w, aspect_ratio_h: dim.h }),
          }
        })
        const mediaAttachments = allAttachments.filter((a) => isMediaFile(a.file_name))
        const otherAttachments = allAttachments.filter((a) => !isMediaFile(a.file_name))
        if (mediaAttachments.length > 0) {
          await sendMixedMessage({
            serverId: server.id,
            signingPubkey: server.signing_pubkey,
            chatId: groupChat.id,
            fromUserId: identity.user_id,
            attachments: mediaAttachments,
            text: text || undefined,
          })
        }
        if (otherAttachments.length > 0) {
          await sendMixedMessage({
            serverId: server.id,
            signingPubkey: server.signing_pubkey,
            chatId: groupChat.id,
            fromUserId: identity.user_id,
            attachments: otherAttachments,
            text: mediaAttachments.length > 0 ? undefined : text || undefined,
          })
        }
      } else {
        await sendMessage({
          serverId: server.id,
          signingPubkey: server.signing_pubkey,
          chatId: groupChat.id,
          fromUserId: identity.user_id,
          text,
        })
      }
      // Snap chat to bottom when your message is sent
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = chatScrollRef.current
          if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        })
      })
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

  const handleShareAgainAttachment = async (
    att: { attachment_id: string; file_name: string; size_bytes: number },
    isOwn: boolean,
    existingPath?: string | null
  ) => {
    try {
      if (isOwn) {
        await shareAttachmentAgain(att.attachment_id, existingPath ?? undefined)
        await refreshSharedAttachments()
        if (server?.signing_pubkey && groupChat?.id) {
          await notifyAttachmentReshared(server.signing_pubkey, groupChat.id, att.attachment_id)
        }
        return
      }
      if (!existingPath) return
      await registerAttachmentFromPath(existingPath, 'program_copy')
      await refreshSharedAttachments()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isOwn && msg.includes('no longer exists')) {
        const selected = await open({ title: 'Select the same file (same file required)', multiple: false })
        const path = Array.isArray(selected) ? selected?.[0] : selected
        if (!path) return
        const meta = await getFileMetadata(path)
        if (meta.size_bytes !== att.size_bytes) return
        await shareAttachmentAgain(att.attachment_id, path)
        await refreshSharedAttachments()
        if (server?.signing_pubkey && groupChat?.id) {
          await notifyAttachmentReshared(server.signing_pubkey, groupChat.id, att.attachment_id)
        }
      }
    }
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
    if (chatMessages.length === 0 || !wasAtBottomRef.current) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!wasAtBottomRef.current) return
        chatScrollBottomAnchorRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' })
      })
    })
  }, [serverId, groupChat?.id, chatMessages.length])

  // Only scroll to bottom when the message list actually changed (e.g. new message), not on every re-render.
  // chatMessages is a new array reference every render, so we must not depend on it or we'd fight the user's scroll (e.g. when video is playing and hover causes re-renders).
  const lastMessageId = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1].id : null
  useEffect(() => {
    const el = chatScrollRef.current
    const msgCount = chatMessages.length
    const wasAtBottom = wasAtBottomRef.current
    if (!groupChat || !el || msgCount === 0) return
    if (!wasAtBottom) return
    let rafCount = 0
    const maxRaf = 8
    const tick = () => {
      if (!wasAtBottomRef.current || !chatScrollRef.current) return
      const target = chatScrollRef.current
      target.scrollTop = target.scrollHeight
      rafCount += 1
      if (rafCount < maxRaf) {
        requestAnimationFrame(tick)
      }
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(tick)
    })
  }, [groupChat?.id, chatMessages.length, lastMessageId])

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
                profileCardAnchorRef.current = null
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
              {/* Group Chat Header with Voice: one row — PFPs left, Join/Leave right */}
              <div className="border-b-2 border-border p-4 overflow-visible">
                <div className="flex items-center justify-between gap-3 min-h-9">
                  {/* Voice participants: same row as button so bar doesn't stretch */}
                  <div className="flex items-center gap-2 min-w-0 flex-1 overflow-visible">
                    {groupChat && (() => {
                      const voiceParticipants = voicePresence.getVoiceParticipants(server.signing_pubkey, groupChat.id)
                      const allParticipants = identity && webrtcIsInVoice && currentRoomId === groupChat.id && !voiceParticipants.includes(identity.user_id)
                        ? [identity.user_id, ...voiceParticipants]
                        : voiceParticipants
                      if (allParticipants.length === 0) return null
                      return (
                        <>
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
                                  "relative h-6 w-6 shrink-0 grid place-items-center rounded-none ring-2 will-change-transform transition-all duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06] focus:outline-none overflow-visible",
                                  isSpeaking ? "ring-green-500" : "ring-background"
                                )}
                                style={!voiceAvatarUrl ? avatarStyleForUser(userId) : undefined}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setProfileCardUserId(userId)
                                  profileCardAnchorRef.current = e.currentTarget as HTMLElement
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
                        </>
                      )
                    })()}
                  </div>
                  <Button
                    variant={webrtcIsInVoice && currentRoomId === groupChat.id ? "default" : "outline"}
                    size="sm"
                    className="h-9 font-light gap-2 shrink-0"
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
              </div>

              {/* Text Chat Area */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div
                  ref={chatScrollRef}
                  className="flex-1 overflow-y-auto p-4 pt-2"
                  onScroll={() => {
                    const el = chatScrollRef.current
                    if (!el) return
                    const threshold = 24
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
                        <div className="flex flex-col-reverse">
                          <div ref={chatScrollBottomAnchorRef} aria-hidden className="h-0 shrink-0" />
                          <div className="flex flex-col-reverse space-y-2">
                            {[...items].reverse().map((item, revIdx) => {
                              const idx = items.length - 1 - revIdx
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
                                        profileCardAnchorRef.current = e.currentTarget as HTMLElement
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
                                    const messageAttachments = msg.attachments ?? (msg.attachment ? [msg.attachment] : [])
                                    const attachmentTransferRows = messageAttachments.length > 0
                                      ? attachmentTransfers.filter(
                                          (t) =>
                                            t.message_id === msg.id ||
                                            messageAttachments.some((a) => a.attachment_id === t.attachment_id)
                                        )
                                      : []
                                    const alreadyDownloadedAccessible =
                                      messageAttachments.length > 0
                                        ? messageAttachments.some((a) => hasAccessibleCompletedDownload(a.attachment_id))
                                        : false
                                    const hostOnlineForAttachment =
                                      messageAttachments.length > 0
                                        ? getLevel(server.signing_pubkey, msg.from_user_id, voicePresence.isUserInVoice(server.signing_pubkey, msg.from_user_id)) !== 'offline'
                                        : false
                                    const hasRejectedDownloadForAttachment = (att: { attachment_id: string }) =>
                                      attachmentTransferRows.some(
                                        (t) =>
                                          t.direction === 'download' &&
                                          t.attachment_id === att.attachment_id &&
                                          t.status === 'rejected'
                                      ) ||
                                      transferHistory.some(
                                        (h) =>
                                          h.direction === 'download' &&
                                          h.attachment_id === att.attachment_id &&
                                          h.status === 'rejected'
                                      )
                                    const attachmentStateLabelFor = (att: { attachment_id: string }) =>
                                      hasAccessibleCompletedDownload(att.attachment_id)
                                        ? 'Cached'
                                        : msg.from_user_id === identity?.user_id
                                          ? sharedAttachments.some((s) => s.attachment_id === att.attachment_id && s.can_share_now)
                                            ? 'Available'
                                            : 'Unavailable'
                                          : hasRejectedDownloadForAttachment(att) || !hostOnlineForAttachment
                                            ? 'Unavailable'
                                            : 'Available'
                                    const attachmentStateLabel =
                                      messageAttachments.length === 1
                                        ? attachmentStateLabelFor(messageAttachments[0])
                                        : null
                                    const unavailableReasonFor = (a: { attachment_id: string }) => {
                                      if (msg.from_user_id === identity?.user_id) {
                                        return !sharedAttachments.some((s) => s.attachment_id === a.attachment_id && s.can_share_now)
                                          ? 'No longer shared'
                                          : null
                                      }
                                      const removed = hasRejectedDownloadForAttachment(a)
                                      const offline = !hostOnlineForAttachment
                                      if (removed && offline) return 'Removed • Offline'
                                      if (removed) return 'Removed'
                                      if (offline) return 'Offline'
                                      return null
                                    }
                                    const timeStr = new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                    return (
                                      <div
                                        key={msg.id}
                                        className="group/msg py-px px-1 -mx-1 cursor-default"
                                        style={{ backgroundColor: hoveredMsgId === msg.id ? 'hsl(var(--muted) / 0.875)' : undefined }}
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
                                          {msg.kind === 'mixed' && msg.attachments?.length ? (
                                            <div className="py-2 space-y-2">
                                              {(() => {
                                                const mediaAttachments = msg.attachments!.filter((a) =>
                                                  isMediaType(getFileTypeFromExt(a.file_name) as Parameters<typeof isMediaType>[0])
                                                )
                                                const otherAttachments = msg.attachments!.filter((a) =>
                                                  !isMediaType(getFileTypeFromExt(a.file_name) as Parameters<typeof isMediaType>[0])
                                                )
                                                return (
                                                  <>
                                              {mediaAttachments.length > 0 ? (
                                              <div
                                                className={cn(
                                                  'grid w-full max-w-full',
                                                  mediaAttachments.length === 1 && 'max-w-[min(100%,28rem)]',
                                                  mediaAttachments.length === 2 && 'grid-cols-2 gap-0.5 max-w-[min(100%,36rem)]',
                                                  mediaAttachments.length >= 3 && 'grid-cols-3 gap-1.5 max-w-[min(100%,32rem)]'
                                                )}
                                              >
                                                {mediaAttachments.map((att) => {
                                                  const count = mediaAttachments.length
                                                  const isSingle = count === 1
                                                  const MIXED_SINGLE_MAX_W = 320
                                                  const MIXED_SINGLE_MAX_H = 240
                                                  const mixedSingleKey = isSingle ? `${msg.id}-${att.attachment_id}` : ''
                                                  const mixedSingleAspect = isSingle
                                                    ? (singleAttachmentAspect[mixedSingleKey] ??
                                                        (att.aspect_ratio_w != null && att.aspect_ratio_h != null
                                                          ? { w: att.aspect_ratio_w, h: att.aspect_ratio_h }
                                                          : { w: 1, h: 1 }))
                                                    : { w: 16, h: 9 }
                                                  const mixedSingleRatio = `${mixedSingleAspect.w}/${mixedSingleAspect.h}`
                                                  const mixedSingleW = Math.min(MIXED_SINGLE_MAX_W, (MIXED_SINGLE_MAX_H * mixedSingleAspect.w) / mixedSingleAspect.h)
                                                  const mixedSingleH = Math.min(MIXED_SINGLE_MAX_H, (MIXED_SINGLE_MAX_W * mixedSingleAspect.h) / mixedSingleAspect.w)
                                                  // #region agent log
                                                  if (isSingle) fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'badea1'},body:JSON.stringify({sessionId:'badea1',location:'ServerViewPage:mixed-media-single',message:'Rendering mixed message with single media',data:{msgKind: msg.kind, msgId: msg.id, attachmentId: att.attachment_id, w: mixedSingleAspect.w, h: mixedSingleAspect.h, mixedSingleW, mixedSingleH},timestamp:Date.now(),hypothesisId:'B',runId:'post-fix'})}).catch(()=>{});
                                                  // #endregion
                                                  const isOwn = msg.from_user_id === identity?.user_id
                                                  const sharedItem = sharedAttachments.find((s) => s.attachment_id === att.attachment_id)
                                                  const unsharedRec = unsharedAttachmentRecords[att.attachment_id]
                                                  const completedDownload = transferHistory.find(
                                                    (h) =>
                                                      h.direction === 'download' &&
                                                      h.attachment_id === att.attachment_id &&
                                                      h.status === 'completed' &&
                                                      h.saved_path
                                                  )
                                                  const liveDownload = attachmentTransferRows.find(
                                                    (t) =>
                                                      t.direction === 'download' &&
                                                      t.attachment_id === att.attachment_id &&
                                                      (t.status === 'transferring' || t.status === 'requesting' || t.status === 'connecting')
                                                  )
                                                  const hasPath = isOwn
                                                    ? (sharedItem?.file_path ?? unsharedRec?.file_path ?? undefined)
                                                    : completedDownload?.saved_path
                                                  const thumbPath = isOwn
                                                    ? (sharedItem?.thumbnail_path ?? unsharedRec?.thumbnail_path ?? undefined)
                                                    : undefined
                                                  const notDownloaded = !isOwn && !hasAccessibleCompletedDownload(att.attachment_id) && !hasPath
                                                  const downloadProgress = liveDownload
                                                    ? Math.max(0, Math.min(100, Math.round((liveDownload.progress ?? 0) * 100)))
                                                    : 0
                                                  const showDownloadProgress = !!liveDownload && (liveDownload.status === 'transferring' || liveDownload.status === 'completed')
                                                  const stateLabel = attachmentStateLabelFor(att)
                                                  const spoilerRevealed = revealedSpoilerIds.has(`${msg.id}:${att.attachment_id}`) || revealedSpoilerIds.has(msg.id)
                                                  if (att.spoiler && !spoilerRevealed) {
                                                    return (
                                                      <button
                                                        key={att.attachment_id}
                                                        type="button"
                                                        onClick={() =>
                                                          setRevealedSpoilerIds((prev) =>
                                                            new Set(prev).add(`${msg.id}:${att.attachment_id}`)
                                                          )
                                                        }
                                                        className={cn(
                                                          'w-full py-4 px-2 bg-muted/80 hover:bg-muted rounded-lg text-center',
                                                          isSingle ? 'min-h-[12rem]' : 'aspect-square'
                                                        )}
                                                        style={isSingle ? { aspectRatio: mixedSingleRatio } : undefined}
                                                      >
                                                        <EyeOff className="h-6 w-6 mx-auto mb-1 text-muted-foreground" />
                                                        <span className="text-[10px] text-muted-foreground block">Spoiler</span>
                                                      </button>
                                                    )
                                                  }
                                                  const category = getFileTypeFromExt(att.file_name)
                                                  const isMedia = isMediaType(category as Parameters<typeof isMediaType>[0])
                                                  return (
                                                    <div
                                                      key={att.attachment_id}
                                                      className={cn(
                                                        'group relative rounded-lg overflow-hidden border border-border/50',
                                                        notDownloaded ? 'bg-muted' : 'bg-muted/30',
                                                        isSingle && 'w-full'
                                                      )}
                                                      style={isSingle ? { width: mixedSingleW, height: mixedSingleH, maxWidth: MIXED_SINGLE_MAX_W, maxHeight: MIXED_SINGLE_MAX_H, aspectRatio: mixedSingleRatio } : undefined}
                                                    >
                                                      {notDownloaded ? (
                                                        <NotDownloadedCardByWidth
                                                          threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                          className={cn(
                                                            'relative w-full flex flex-col items-center justify-center gap-1.5 p-2 bg-muted rounded-lg border border-border/50 transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110',
                                                            isSingle ? 'h-full min-h-0 min-w-0' : 'aspect-square'
                                                          )}
                                                          narrowContent={
                                                            <>
                                                              {!liveDownload && (
                                                                <Button
                                                                  type="button"
                                                                  variant="outline"
                                                                  size="icon"
                                                                  className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                  onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                  disabled={stateLabel !== 'Available'}
                                                                  aria-label="Download"
                                                                >
                                                                  {stateLabel === 'Available' ? (
                                                                    <Download className="h-3.5 w-3.5" />
                                                                  ) : (
                                                                    <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                  )}
                                                                </Button>
                                                              )}
                                                              <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                              <span className="text-[9px] text-muted-foreground shrink-0">
                                                                {formatBytes(att.size_bytes)}
                                                              </span>
                                                              {stateLabel === 'Unavailable' && (
                                                                <span className="flex flex-col items-center justify-center gap-0.5">
                                                                  <span className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                    <CloudOff className="h-3 w-3 shrink-0" />
                                                                    Not available
                                                                  </span>
                                                                  {unavailableReasonFor(att) && (
                                                                    <span className="text-[8px] text-muted-foreground/90">
                                                                      {unavailableReasonFor(att)}
                                                                    </span>
                                                                  )}
                                                                </span>
                                                              )}
                                                              {showDownloadProgress && (
                                                                <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                  <div
                                                                    className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                    style={{ width: `${Math.max(2, downloadProgress)}%` }}
                                                                  />
                                                                </div>
                                                              )}
                                                            </>
                                                          }
                                                          wideContent={
                                                            <>
                                                              {!liveDownload && (
                                                                <Button
                                                                  type="button"
                                                                  variant="outline"
                                                                  size="icon"
                                                                  className="absolute top-1.5 right-1.5 h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                  onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                  disabled={stateLabel !== 'Available'}
                                                                  aria-label="Download"
                                                                >
                                                                  {stateLabel === 'Available' ? (
                                                                    <Download className="h-3.5 w-3.5" />
                                                                  ) : (
                                                                    <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                  )}
                                                                </Button>
                                                              )}
                                                              {stateLabel === 'Unavailable' ? (
                                                                <ImageOff className="h-8 w-8 shrink-0 text-muted-foreground" aria-hidden />
                                                              ) : category === 'video' ? (
                                                                <ImageDownPlay className="h-8 w-8 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                                              ) : (
                                                                <ImageDown className="h-8 w-8 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                                              )}
                                                              <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                              <span className="text-[9px] text-muted-foreground shrink-0">
                                                                {formatBytes(att.size_bytes)}
                                                              </span>
                                                              {stateLabel === 'Unavailable' && (
                                                                <span className="flex flex-col items-center justify-center gap-0.5">
                                                                  <span className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                    <CloudOff className="h-3 w-3 shrink-0" />
                                                                    Not available
                                                                  </span>
                                                                  {unavailableReasonFor(att) && (
                                                                    <span className="text-[8px] text-muted-foreground/90">
                                                                      {unavailableReasonFor(att)}
                                                                    </span>
                                                                  )}
                                                                </span>
                                                              )}
                                                              {showDownloadProgress && (
                                                                <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                  <div
                                                                    className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                    style={{ width: `${Math.max(2, downloadProgress)}%` }}
                                                                  />
                                                                </div>
                                                              )}
                                                            </>
                                                          }
                                                        />
                                                      ) : isMedia && hasPath ? (
                                                        category === 'image' ? (
                                                          <div className={cn('relative', isSingle && 'w-full h-full min-h-0')}>
                                                            <button
                                                              type="button"
                                                              className={cn('block w-full focus:outline-none', isSingle && 'h-full min-h-0')}
                                                              onClick={() =>
                                                                setMediaPreview({
                                                                  type: 'image',
                                                                  url: convertFileSrc(hasPath),
                                                                  fileName: att.file_name,
                                                                })
                                                              }
                                                            >
                                                              <ChatMediaSlot
                                                                fillParent={isSingle}
                                                                aspectClass={!isSingle ? 'aspect-square' : undefined}
                                                              >
                                                                <img
                                                                  src={convertFileSrc(hasPath)}
                                                                  alt=""
                                                                  loading="lazy"
                                                                  className="object-cover"
                                                                  onLoad={isSingle ? (e) => {
                                                                    const img = e.currentTarget
                                                                    if (img.naturalWidth && img.naturalHeight) {
                                                                      setSingleAttachmentAspect((prev) => ({
                                                                        ...prev,
                                                                        [mixedSingleKey]: { w: img.naturalWidth, h: img.naturalHeight },
                                                                      }))
                                                                    }
                                                                  } : undefined}
                                                                />
                                                              </ChatMediaSlot>
                                                            </button>
                                                            {isOwn && !sharedItem?.can_share_now && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share again">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation()
                                                                      handleShareAgainAttachment(att, true, hasPath)
                                                                    }}
                                                                  >
                                                                    <Upload className="h-4 w-4" />
                                                                  </Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                            {!isOwn && completedDownload?.saved_path && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share in this chat">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation()
                                                                      handleShareAgainAttachment(att, false, completedDownload.saved_path)
                                                                    }}
                                                                  >
                                                                    <Upload className="h-4 w-4" />
                                                                  </Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                          </div>
                                                        ) : (
                                                          <div className={cn('relative', isSingle && 'w-full h-full min-h-0')}>
                                                            {isSingle && inlinePlayingVideoId === att.attachment_id ? (
                                                              <div
                                                                ref={(el) => {
                                                                  videoScrollTargetsRef.current[`${msg.id}-${att.attachment_id}`] = el
                                                                }}
                                                                className={cn(
                                                                  'relative overflow-hidden rounded-lg bg-black w-full',
                                                                  isSingle ? 'h-full min-h-0 max-h-[min(70vh,24rem)]' : 'aspect-square'
                                                                )}
                                                                style={isSingle ? { aspectRatio: mixedSingleRatio } : undefined}
                                                                onMouseEnter={() => setInlineVideoShowControls(true)}
                                                                onMouseLeave={() => setInlineVideoShowControls(false)}
                                                              >
                                                                <CustomVideoPlayer
                                                                  src={convertFileSrc(hasPath)}
                                                                  showControls={inlineVideoShowControls}
                                                                  keepControlsWhenPaused
                                                                  autoPlay
                                                                  getScrollTarget={() => videoScrollTargetsRef.current[`${msg.id}-${att.attachment_id}`] ?? null}
                                                                  onAspectRatio={isSingle ? (w, h) => {
                                                                    setSingleAttachmentAspect((prev) => ({
                                                                      ...prev,
                                                                      [mixedSingleKey]: { w, h },
                                                                    }))
                                                                  } : undefined}
                                                                  className={cn('w-full h-full rounded-lg', isSingle ? 'object-contain' : 'object-cover')}
                                                                />
                                                              </div>
                                                            ) : (
                                                              <button
                                                                type="button"
                                                                className={cn('relative block w-full focus:outline-none group', isSingle && 'h-full min-h-0')}
                                                                onClick={() => {
                                                                  if (isSingle) {
                                                                    setInlinePlayingVideoId(att.attachment_id)
                                                                  } else {
                                                                    setMediaPreview({
                                                                      type: 'video',
                                                                      url: convertFileSrc(hasPath),
                                                                      fileName: att.file_name,
                                                                    })
                                                                  }
                                                                }}
                                                              >
                                                                <ChatMediaSlot
                                                                  fillParent={isSingle}
                                                                  aspectClass={!isSingle ? 'aspect-square' : undefined}
                                                                >
                                                                  {thumbPath ? (
                                                                    <img
                                                                      src={convertFileSrc(thumbPath)}
                                                                      alt=""
                                                                      loading="lazy"
                                                                      className="object-cover"
                                                                    />
                                                                  ) : (
                                                                    <video
                                                                      src={convertFileSrc(hasPath)}
                                                                      className="object-cover"
                                                                      muted
                                                                      playsInline
                                                                      preload="auto"
                                                                      onLoadedMetadata={isSingle ? (e) => {
                                                                        const v = e.currentTarget
                                                                        if (v.videoWidth && v.videoHeight) {
                                                                          setSingleAttachmentAspect((prev) => ({
                                                                            ...prev,
                                                                            [mixedSingleKey]: { w: v.videoWidth, h: v.videoHeight },
                                                                          }))
                                                                        }
                                                                      } : undefined}
                                                                    />
                                                                  )}
                                                                  {isSingle && category === 'video' && hasPath ? (
                                                                    <video
                                                                      src={convertFileSrc(hasPath)}
                                                                      className="!absolute !w-0 !h-0 !opacity-0 !pointer-events-none !min-w-0 !min-h-0"
                                                                      muted
                                                                      playsInline
                                                                      preload="metadata"
                                                                      onLoadedMetadata={(e) => {
                                                                        const v = e.currentTarget
                                                                        if (v.videoWidth && v.videoHeight) {
                                                                          setSingleAttachmentAspect((prev) => ({
                                                                            ...prev,
                                                                            [mixedSingleKey]: { w: v.videoWidth, h: v.videoHeight },
                                                                          }))
                                                                        }
                                                                      }}
                                                                    />
                                                                  ) : null}
                                                                </ChatMediaSlot>
                                                                <span className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 pointer-events-none rounded-lg">
                                                                  <span className="w-10 h-10 rounded-md bg-black/50 flex items-center justify-center">
                                                                    <Play className="h-5 w-5 text-white fill-white" />
                                                                  </span>
                                                                </span>
                                                              </button>
                                                            )}
                                                            {isOwn && !sharedItem?.can_share_now && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share again">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation()
                                                                      handleShareAgainAttachment(att, true, hasPath)
                                                                    }}
                                                                  >
                                                                    <Upload className="h-4 w-4" />
                                                                  </Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                            {!isOwn && completedDownload?.saved_path && (
                                                              <span className="absolute top-1.5 right-1.5 z-20">
                                                                <Tooltip content="Share in this chat">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={(e) => {
                                                                      e.stopPropagation()
                                                                      handleShareAgainAttachment(att, false, completedDownload.saved_path)
                                                                    }}
                                                                  >
                                                                    <Upload className="h-4 w-4" />
                                                                  </Button>
                                                                </Tooltip>
                                                              </span>
                                                            )}
                                                          </div>
                                                        )
                                                      ) : null}
                                                      {!notDownloaded && (
                                                        isSingle && category === 'video' ? (
                                                          <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none pt-2 pb-8 px-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b from-black/80 via-black/50 to-transparent" aria-hidden>
                                                            <span className="text-[10px] text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                          </div>
                                                        ) : (
                                                          <div className="absolute inset-0 pointer-events-none flex items-end">
                                                            <div className="w-full bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-8 pb-1 px-1.5 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden>
                                                              <span className="text-[10px] text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                            </div>
                                                          </div>
                                                        )
                                                      )}
                                                    </div>
                                                  )
                                                })}
                                              </div>
                                              ) : null}
                                              {otherAttachments.length > 0 && (
                                                <div className="flex flex-col gap-1 max-w-[min(100%,28rem)]">
                                                  {otherAttachments.map((att) => {
                                                    const isOwn = msg.from_user_id === identity?.user_id
                                                    const sharedItem = sharedAttachments.find((s) => s.attachment_id === att.attachment_id)
                                                    const unsharedRec = unsharedAttachmentRecords[att.attachment_id]
                                                    const completedDownload = transferHistory.find(
                                                      (h) =>
                                                        h.direction === 'download' &&
                                                        h.attachment_id === att.attachment_id &&
                                                        h.status === 'completed' &&
                                                        h.saved_path
                                                    )
                                                    const liveDownload = attachmentTransferRows.find(
                                                      (t) =>
                                                        t.direction === 'download' &&
                                                        t.attachment_id === att.attachment_id &&
                                                        (t.status === 'transferring' || t.status === 'requesting' || t.status === 'connecting')
                                                    )
                                                    const hasPath = isOwn
                                                      ? (sharedItem?.file_path ?? unsharedRec?.file_path ?? undefined)
                                                      : completedDownload?.saved_path
                                                    const notDownloaded = !isOwn && !hasAccessibleCompletedDownload(att.attachment_id) && !hasPath
                                                    const stateLabel = attachmentStateLabelFor(att)
                                                    const showDownloadProgress = !!liveDownload && (liveDownload.status === 'transferring' || liveDownload.status === 'completed')
                                                    const downloadProgress = liveDownload ? Math.max(0, Math.min(100, Math.round((liveDownload.progress ?? 0) * 100))) : 0
                                                    const category = getFileTypeFromExt(att.file_name) as Parameters<typeof IconForCategory>[0]['cat']
                                                    return (
                                                      <div
                                                        key={att.attachment_id}
                                                        className={cn(
                                                          'group relative rounded-lg overflow-hidden border border-border/50',
                                                          notDownloaded ? 'bg-muted' : 'bg-muted/30'
                                                        )}
                                                      >
                                                        {notDownloaded ? (
                                                          <NotDownloadedCardByWidth
                                                            threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                            className="relative w-full flex flex-col items-center justify-center gap-1.5 bg-muted transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110 min-h-[56px]"
                                                            narrowContent={
                                                              <>
                                                                {!liveDownload && (
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                    disabled={stateLabel !== 'Available'}
                                                                    aria-label="Download"
                                                                  >
                                                                    {stateLabel === 'Available' ? (
                                                                      <Download className="h-3.5 w-3.5" />
                                                                    ) : (
                                                                      <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                    )}
                                                                  </Button>
                                                                )}
                                                                <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                                <span className="text-[9px] text-muted-foreground shrink-0">{formatBytes(att.size_bytes)}</span>
                                                                {stateLabel === 'Unavailable' && (
                                                                  <span className="flex flex-col items-center justify-center gap-0.5">
                                                                    <span className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                      <CloudOff className="h-3 w-3 shrink-0" />
                                                                      Not available
                                                                    </span>
                                                                    {unavailableReasonFor(att) && (
                                                                      <span className="text-[8px] text-muted-foreground/90">{unavailableReasonFor(att)}</span>
                                                                    )}
                                                                  </span>
                                                                )}
                                                                {showDownloadProgress && (
                                                                  <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                    <div
                                                                      className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                      style={{ width: `${Math.max(2, downloadProgress)}%` }}
                                                                    />
                                                                  </div>
                                                                )}
                                                              </>
                                                            }
                                                            wideContent={
                                                              <>
                                                                <ChatFileRowSlot
                                                                  icon={<IconForCategory cat={category} className="text-muted-foreground" />}
                                                                  title={att.file_name}
                                                                  size={formatBytes(att.size_bytes)}
                                                                >
                                                                  <div className="flex flex-col items-end gap-1 shrink-0">
                                                                    {!liveDownload && (
                                                                      <Button
                                                                        type="button"
                                                                        variant="outline"
                                                                        size="icon"
                                                                        className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                        onClick={() => stateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                        disabled={stateLabel !== 'Available'}
                                                                        aria-label="Download"
                                                                      >
                                                                        {stateLabel === 'Available' ? (
                                                                          <Download className="h-3.5 w-3.5" />
                                                                        ) : (
                                                                          <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                        )}
                                                                      </Button>
                                                                    )}
                                                                    {stateLabel === 'Unavailable' && (
                                                                      <span className="text-[9px] text-muted-foreground text-right">Not available</span>
                                                                    )}
                                                                    {showDownloadProgress && (
                                                                      <div className="w-24 h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                        <div
                                                                          className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                          style={{ width: `${Math.max(2, downloadProgress)}%` }}
                                                                        />
                                                                      </div>
                                                                    )}
                                                                  </div>
                                                                </ChatFileRowSlot>
                                                              </>
                                                            }
                                                          />
                                                        ) : (
                                                          <div className="relative">
                                                            <ChatFileRowSlot
                                                              className="border border-border/50"
                                                              icon={<IconForCategory cat={category} className="text-muted-foreground" />}
                                                              title={att.file_name}
                                                              size={formatBytes(att.size_bytes)}
                                                            >
                                                              {isOwn && !sharedItem?.can_share_now && (
                                                                <span className="shrink-0">
                                                                  <Tooltip content="Share again">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, true, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                              {!isOwn && completedDownload?.saved_path && (
                                                                <span className="shrink-0">
                                                                  <Tooltip content="Share in this chat">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, false, completedDownload.saved_path)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                            </ChatFileRowSlot>
                                                          </div>
                                                        )}
                                                      </div>
                                                    )
                                                  })}
                                                </div>
                                              )}
                                              </>
                                                )
                                              })()}
                                              {msg.text ? (
                                                <p className="text-sm whitespace-pre-wrap break-words max-w-[min(100%,36rem)]">{msg.text}</p>
                                              ) : null}
                                            </div>
                                          ) : msg.kind === 'attachment' && msg.attachment ? (
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
                                                  const unsharedRec = unsharedAttachmentRecords[att.attachment_id]
                                                  const completedDownload = transferHistory.find(
                                                    (h) => h.direction === 'download' && h.attachment_id === att.attachment_id && h.status === 'completed' && h.saved_path
                                                  )
                                                  const liveDownload = attachmentTransferRows.find(
                                                    (t) =>
                                                      t.direction === 'download' &&
                                                      t.attachment_id === att.attachment_id &&
                                                      (t.status === 'transferring' || t.status === 'requesting' || t.status === 'connecting')
                                                  )
                                                  const hasPath = isOwn
                                                    ? (sharedItem?.file_path ?? unsharedRec?.file_path ?? undefined)
                                                    : completedDownload?.saved_path
                                                  const thumbPath = isOwn
                                                    ? (sharedItem?.thumbnail_path ?? unsharedRec?.thumbnail_path ?? undefined)
                                                    : undefined
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
                                                  const singleAspectKey = `${msg.id}-${att.attachment_id}`
                                                  const singleAspect =
                                                    singleAttachmentAspect[singleAspectKey] ??
                                                    (att.aspect_ratio_w != null && att.aspect_ratio_h != null
                                                      ? { w: att.aspect_ratio_w, h: att.aspect_ratio_h }
                                                      : { w: 1, h: 1 })
                                                  const singleAspectRatio = `${singleAspect.w}/${singleAspect.h}`
                                                  const singleW = Math.min(CHAT_MEDIA_MAX_W, (CHAT_MEDIA_MAX_H * singleAspect.w) / singleAspect.h)
                                                  const singleH = Math.min(CHAT_MEDIA_MAX_H, (CHAT_MEDIA_MAX_W * singleAspect.h) / singleAspect.w)
                                                  // #region agent log
                                                  fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'badea1'},body:JSON.stringify({sessionId:'badea1',location:'ServerViewPage:single-attachment-render',message:'Single attachment container values',data:{singleAspectKey, singleAspectW: singleAspect.w, singleAspectH: singleAspect.h, singleW, singleH, category, hasPath: !!hasPath, fromState: !!singleAttachmentAspect[singleAspectKey]},timestamp:Date.now(),hypothesisId:'A,B,C,E'})}).catch(()=>{});
                                                  // #endregion
                                                  if (isMedia) {
                                                    return (
                                                      <div className="space-y-1">
                                                        <div
                                                          className={cn(
                                                            'relative rounded-lg overflow-hidden border border-border/50',
                                                            notDownloaded && 'bg-muted'
                                                          )}
                                                          style={{
                                                            width: singleW,
                                                            height: singleH,
                                                            maxWidth: CHAT_MEDIA_MAX_W,
                                                            maxHeight: CHAT_MEDIA_MAX_H,
                                                            aspectRatio: singleAspectRatio,
                                                          }}
                                                        >
                                                          {notDownloaded ? (
                                                            <NotDownloadedCardByWidth
                                                              threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                              className="relative w-full h-full min-h-0 min-w-0 flex flex-col items-center justify-center gap-2 p-4 bg-muted rounded-lg transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110"
                                                              narrowContent={
                                                                <>
                                                                  {!liveDownload && (
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={() => attachmentStateLabel === 'Available' && requestAttachmentDownload(msg)}
                                                                      disabled={attachmentStateLabel !== 'Available'}
                                                                      aria-label="Download"
                                                                    >
                                                                      {attachmentStateLabel === 'Available' ? (
                                                                        <Download className="h-4 w-4" />
                                                                      ) : (
                                                                        <Ban className="h-4 w-4" aria-hidden />
                                                                      )}
                                                                    </Button>
                                                                  )}
                                                                  <FilenameEllipsis name={att.file_name} className="text-xs text-foreground truncate max-w-full text-center block" title={att.file_name} />
                                                                  <span className="text-[10px] text-muted-foreground shrink-0">
                                                                    {formatBytes(att.size_bytes)}
                                                                    {att.extension ? ` .${att.extension}` : ''}
                                                                  </span>
                                                                  {attachmentStateLabel === 'Unavailable' && (
                                                                    <span className="flex flex-col items-center justify-center gap-0.5">
                                                                      <span className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                        <CloudOff className="h-3.5 w-3.5 shrink-0" />
                                                                        Not available
                                                                      </span>
                                                                      {unavailableReasonFor(att) && (
                                                                        <span className="text-[9px] text-muted-foreground/90">
                                                                          {unavailableReasonFor(att)}
                                                                        </span>
                                                                      )}
                                                                    </span>
                                                                  )}
                                                                  {showProgress && (
                                                                    <div className="w-full max-w-[200px] h-1.5 bg-foreground/15 overflow-hidden rounded-full">
                                                                      <div
                                                                        className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                        style={{ width: `${Math.max(2, p)}%` }}
                                                                      />
                                                                    </div>
                                                                  )}
                                                                </>
                                                              }
                                                              wideContent={
                                                                <>
                                                                  {!liveDownload && (
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="absolute top-2 right-2 h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={() => attachmentStateLabel === 'Available' && requestAttachmentDownload(msg)}
                                                                      disabled={attachmentStateLabel !== 'Available'}
                                                                      aria-label="Download"
                                                                    >
                                                                      {attachmentStateLabel === 'Available' ? (
                                                                        <Download className="h-4 w-4" />
                                                                      ) : (
                                                                        <Ban className="h-4 w-4" aria-hidden />
                                                                      )}
                                                                    </Button>
                                                                  )}
                                                                  {attachmentStateLabel === 'Unavailable' ? (
                                                                    <ImageOff className="h-12 w-12 shrink-0 text-muted-foreground" aria-hidden />
                                                                  ) : (getFileTypeFromExt(att.file_name) === 'video') ? (
                                                                    <ImageDownPlay className="h-12 w-12 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                                                  ) : (
                                                                    <ImageDown className="h-12 w-12 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                                                  )}
                                                                  <FilenameEllipsis name={att.file_name} className="text-xs text-foreground truncate max-w-full text-center block" title={att.file_name} />
                                                                  <span className="text-[10px] text-muted-foreground shrink-0">
                                                                    {formatBytes(att.size_bytes)}
                                                                    {att.extension ? ` .${att.extension}` : ''}
                                                                  </span>
                                                                  {attachmentStateLabel === 'Unavailable' && (
                                                                    <span className="flex flex-col items-center justify-center gap-0.5">
                                                                      <span className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                        <CloudOff className="h-3.5 w-3.5 shrink-0" />
                                                                        Not available
                                                                      </span>
                                                                      {unavailableReasonFor(att) && (
                                                                        <span className="text-[9px] text-muted-foreground/90">
                                                                          {unavailableReasonFor(att)}
                                                                        </span>
                                                                      )}
                                                                    </span>
                                                                  )}
                                                                  {showProgress && (
                                                                    <div className="w-full max-w-[200px] h-1.5 bg-foreground/15 overflow-hidden rounded-full">
                                                                      <div
                                                                        className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                        style={{ width: `${Math.max(2, p)}%` }}
                                                                      />
                                                                    </div>
                                                                  )}
                                                                </>
                                                              }
                                                            />
                                                          ) : category === 'image' && hasPath ? (
                                                            <div className="relative w-full h-full min-h-0">
                                                              <button
                                                                type="button"
                                                                className="group relative block w-full h-full focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background rounded-lg overflow-hidden min-h-0"
                                                                onClick={() =>
                                                                  setMediaPreview({
                                                                    type: 'image',
                                                                    url: convertFileSrc(hasPath),
                                                                    fileName: att.file_name,
                                                                  })
                                                                }
                                                              >
                                                                <ChatMediaSlot fillParent>
                                                                  <img
                                                                    src={convertFileSrc(hasPath)}
                                                                    alt=""
                                                                    loading="lazy"
                                                                    className="object-cover"
                                                                    onLoad={(e) => {
                                                                      const img = e.currentTarget
                                                                      if (img.naturalWidth && img.naturalHeight) {
                                                                        const key = `${msg.id}-${att.attachment_id}`
                                                                        // #region agent log
                                                                        fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'badea1'},body:JSON.stringify({sessionId:'badea1',location:'ServerViewPage:image-onLoad',message:'Image dimensions reported',data:{key, w: img.naturalWidth, h: img.naturalHeight},timestamp:Date.now(),hypothesisId:'A,D'})}).catch(()=>{});
                                                                        // #endregion
                                                                        setSingleAttachmentAspect((prev) => ({
                                                                          ...prev,
                                                                          [key]: { w: img.naturalWidth, h: img.naturalHeight },
                                                                        }))
                                                                      }
                                                                    }}
                                                                  />
                                                                </ChatMediaSlot>
                                                                <div className="absolute inset-0 pointer-events-none flex items-end">
                                                                  <div className="w-full bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-12 pb-2 px-2 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden>
                                                                    <span className="text-xs text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                                  </div>
                                                                </div>
                                                              </button>
                                                              {isOwn && !sharedItem?.can_share_now && (
                                                                <span className="absolute top-2 right-2 z-20">
                                                                  <Tooltip content="Share again">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, true, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-4 w-4" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                              {!isOwn && completedDownload?.saved_path && (
                                                                <span className="absolute top-2 right-2 z-20">
                                                                  <Tooltip content="Share in this chat">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, false, completedDownload.saved_path)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-4 w-4" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                            </div>
                                                          ) : category === 'video' && hasPath ? (
                                                            <div className="relative">
                                                              {inlinePlayingVideoId === att.attachment_id ? (
                                                                <div
                                                                  ref={(el) => {
                                                                    videoScrollTargetsRef.current[`${msg.id}-${att.attachment_id}`] = el
                                                                  }}
                                                                  className="group relative overflow-hidden rounded-lg bg-black w-full h-full min-h-0"
                                                                  onMouseEnter={() => setInlineVideoShowControls(true)}
                                                                  onMouseLeave={() => setInlineVideoShowControls(false)}
                                                                >
                                                                  <CustomVideoPlayer
                                                                    src={convertFileSrc(hasPath)}
                                                                    showControls={inlineVideoShowControls}
                                                                    keepControlsWhenPaused
                                                                    autoPlay
                                                                    getScrollTarget={() => videoScrollTargetsRef.current[`${msg.id}-${att.attachment_id}`] ?? null}
                                                                    onAspectRatio={(w, h) => {
                                                                      const key = `${msg.id}-${att.attachment_id}`
                                                                      // #region agent log
                                                                      fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'badea1'},body:JSON.stringify({sessionId:'badea1',location:'ServerViewPage:onAspectRatio',message:'CustomVideoPlayer aspect reported',data:{key, w, h},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
                                                                      // #endregion
                                                                      setSingleAttachmentAspect((prev) => ({
                                                                        ...prev,
                                                                        [key]: { w, h },
                                                                      }))
                                                                    }}
                                                                    className="w-full h-full object-contain rounded-lg"
                                                                  />
                                                                  <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none pt-2 pb-10 px-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b from-black/80 via-black/50 to-transparent" aria-hidden>
                                                                    <span className="text-xs text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                                  </div>
                                                                </div>
                                                              ) : (
                                                                <button
                                                                  type="button"
                                                                  className="group relative block w-full h-full min-h-0 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background rounded-lg overflow-hidden"
                                                                  onClick={() => setInlinePlayingVideoId(att.attachment_id)}
                                                                >
                                                                  <ChatMediaSlot fillParent>
                                                                    {thumbPath ? (
                                                                      <img
                                                                        src={convertFileSrc(thumbPath)}
                                                                        alt=""
                                                                        loading="lazy"
                                                                        className="object-cover"
                                                                        onLoad={(e) => {
                                                                          const img = e.currentTarget
                                                                          if (img.naturalWidth && img.naturalHeight) {
                                                                            setSingleAttachmentAspect((prev) => ({
                                                                              ...prev,
                                                                              [singleAspectKey]: { w: img.naturalWidth, h: img.naturalHeight },
                                                                            }))
                                                                          }
                                                                        }}
                                                                      />
                                                                    ) : (
                                                                      <video
                                                                        src={convertFileSrc(hasPath)}
                                                                        className="object-cover"
                                                                        muted
                                                                        playsInline
                                                                        preload="metadata"
                                                                        onLoadedMetadata={(e) => {
                                                                          const v = e.currentTarget
                                                                          if (v.videoWidth && v.videoHeight) {
                                                                            const key = `${msg.id}-${att.attachment_id}`
                                                                            // #region agent log
                                                                            fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'badea1'},body:JSON.stringify({sessionId:'badea1',location:'ServerViewPage:video-onLoadedMetadata',message:'Video dimensions reported',data:{key, w: v.videoWidth, h: v.videoHeight},timestamp:Date.now(),hypothesisId:'A,D'})}).catch(()=>{});
                                                                            // #endregion
                                                                            setSingleAttachmentAspect((prev) => ({
                                                                              ...prev,
                                                                              [key]: { w: v.videoWidth, h: v.videoHeight },
                                                                            }))
                                                                          }
                                                                        }}
                                                                      />
                                                                    )}
                                                                  </ChatMediaSlot>
                                                                  <span className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors pointer-events-none">
                                                                    <span className="w-10 h-10 rounded-md bg-black/50 flex items-center justify-center">
                                                                      <Play className="h-5 w-5 text-white fill-white" />
                                                                    </span>
                                                                  </span>
                                                                  <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none pt-2 pb-10 px-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b from-black/80 via-black/50 to-transparent" aria-hidden>
                                                                    <span className="text-xs text-white truncate block drop-shadow-sm">{att.file_name}</span>
                                                                  </div>
                                                                </button>
                                                              )}
                                                              {isOwn && !sharedItem?.can_share_now && (
                                                                <span className="absolute top-2 right-2 z-20">
                                                                  <Tooltip content="Share again">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, true, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-4 w-4" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                              {!isOwn && completedDownload?.saved_path && (
                                                                <span className="absolute top-2 right-2 z-20">
                                                                  <Tooltip content="Share in this chat">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-8 w-8 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, false, completedDownload.saved_path)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-4 w-4" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                            </div>
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
                                                  const fileCategory = getFileTypeFromExt(att.file_name) as Parameters<typeof IconForCategory>[0]['cat']
                                                    return (
                                                      <div
                                                        className={cn(
                                                          'group relative rounded-lg overflow-hidden border border-border/50 max-w-[min(100%,28rem)]',
                                                          notDownloaded ? 'bg-muted' : 'bg-muted/30'
                                                        )}
                                                      >
                                                        {notDownloaded ? (
                                                          <NotDownloadedCardByWidth
                                                            threshold={NOT_DOWNLOADED_CARD_NARROW_PX}
                                                            className="relative w-full flex flex-col items-center justify-center gap-1.5 bg-muted rounded-lg transition-[background-color,filter] hover:bg-muted/80 hover:brightness-110 min-h-[56px]"
                                                            narrowContent={
                                                              <>
                                                                <Button
                                                                  type="button"
                                                                  variant="outline"
                                                                  size="icon"
                                                                  className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                  onClick={() => attachmentStateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                  disabled={attachmentStateLabel !== 'Available'}
                                                                  aria-label="Download"
                                                                >
                                                                  {attachmentStateLabel === 'Available' ? (
                                                                    <Download className="h-3.5 w-3.5" />
                                                                  ) : (
                                                                    <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                  )}
                                                                </Button>
                                                                <FilenameEllipsis name={att.file_name} className="text-[10px] text-foreground truncate w-full text-center block" title={att.file_name} />
                                                                <span className="text-[9px] text-muted-foreground shrink-0">{formatBytes(att.size_bytes)}</span>
                                                                {attachmentStateLabel === 'Unavailable' && (
                                                                  <span className="flex flex-col items-center justify-center gap-0.5">
                                                                    <span className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground" title="Uploader offline or file no longer available">
                                                                      <CloudOff className="h-3 w-3 shrink-0" />
                                                                      Not available
                                                                    </span>
                                                                    {unavailableReasonFor(att) && (
                                                                      <span className="text-[8px] text-muted-foreground/90">{unavailableReasonFor(att)}</span>
                                                                    )}
                                                                  </span>
                                                                )}
                                                                {showProgress && (
                                                                  <div className="w-full max-w-[120px] h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                    <div
                                                                      className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                      style={{ width: `${Math.max(2, p)}%` }}
                                                                    />
                                                                  </div>
                                                                )}
                                                              </>
                                                            }
                                                            wideContent={
                                                              <ChatFileRowSlot
                                                                icon={<IconForCategory cat={fileCategory} className="text-muted-foreground" />}
                                                                title={att.file_name}
                                                                size={formatBytes(att.size_bytes)}
                                                              >
                                                                <div className="flex flex-col items-end gap-1 shrink-0">
                                                                  <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                    onClick={() => attachmentStateLabel === 'Available' && requestAttachmentDownload(msg, att)}
                                                                    disabled={attachmentStateLabel !== 'Available'}
                                                                    aria-label="Download"
                                                                  >
                                                                    {attachmentStateLabel === 'Available' ? (
                                                                      <Download className="h-3.5 w-3.5" />
                                                                    ) : (
                                                                      <Ban className="h-3.5 w-3.5" aria-hidden />
                                                                    )}
                                                                  </Button>
                                                                  {attachmentStateLabel === 'Unavailable' && (
                                                                    <span className="text-[9px] text-muted-foreground text-right">Not available</span>
                                                                  )}
                                                                  {showProgress && (
                                                                    <div className="w-24 h-1 bg-foreground/15 overflow-hidden rounded-full">
                                                                      <div
                                                                        className={cn('h-full', liveDownload?.status === 'completed' ? 'bg-emerald-400/80' : 'bg-violet-400/85')}
                                                                        style={{ width: `${Math.max(2, p)}%` }}
                                                                      />
                                                                    </div>
                                                                  )}
                                                                </div>
                                                              </ChatFileRowSlot>
                                                            }
                                                          />
                                                        ) : (
                                                          <div className="relative">
                                                            <ChatFileRowSlot
                                                              className="border border-border/50"
                                                              icon={<IconForCategory cat={fileCategory} className="text-muted-foreground" />}
                                                              title={att.file_name}
                                                              size={formatBytes(att.size_bytes)}
                                                            >
                                                              {isOwn && !sharedItem?.can_share_now && (
                                                                <span className="shrink-0">
                                                                  <Tooltip content="Share again">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, true, hasPath)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                              {!isOwn && completedDownload?.saved_path && (
                                                                <span className="shrink-0">
                                                                  <Tooltip content="Share in this chat">
                                                                    <Button
                                                                      type="button"
                                                                      variant="outline"
                                                                      size="icon"
                                                                      className="h-7 w-7 shrink-0 border-2 border-foreground/50 rounded-md bg-background/80 hover:bg-background/90 hover:border-foreground/70"
                                                                      onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        handleShareAgainAttachment(att, false, completedDownload.saved_path)
                                                                      }}
                                                                    >
                                                                      <Upload className="h-3.5 w-3.5" />
                                                                    </Button>
                                                                  </Tooltip>
                                                                </span>
                                                              )}
                                                            </ChatFileRowSlot>
                                                          </div>
                                                        )}
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
                        </div>
                      )
                    })()}
                  </div>
                </div>

                <div className="border-t-2 border-border p-4 bg-card/50">
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
                                  <Tooltip content={att.spoiler ? 'Marked as spoiler' : 'Mark as spoiler'} side="top">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className={cn('h-6 w-6', att.spoiler && 'text-amber-500')}
                                      onClick={() => handleToggleStagedSpoiler(att.staged_id)}
                                    >
                                      {att.spoiler ? (
                                        <EyeOff className="h-3.5 w-3.5" />
                                      ) : (
                                        <Eye className="h-3.5 w-3.5" />
                                      )}
                                    </Button>
                                  </Tooltip>
                                  <Tooltip content="Remove" side="top">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-red-300 hover:text-red-200"
                                      onClick={() => handleRemoveStagedAttachment(att.staged_id)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </Tooltip>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <Tooltip content="Attach file(s)" title="Attach file(s)">
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          className="h-11 w-11 shrink-0"
                          disabled={!canSendMessages}
                          onClick={handleAddAttachment}
                        >
                          <Paperclip className="h-4 w-4" />
                        </Button>
                      </Tooltip>
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
                <Tooltip content={showInviteCodePopover ? 'Close invite code' : 'Invite code'} side="left">
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
                  >
                    {showInviteCodePopover ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  </Button>
                </Tooltip>
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
                      profileCardAnchorRef.current = e.currentTarget as HTMLElement
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
                        <Tooltip content={copiedInvite ? 'Copied' : 'Copy'} side="bottom">
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
                          >
                            {copiedInvite ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                        </Tooltip>
                        <Tooltip content="Revoke" side="bottom">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                            onClick={async (e) => {
                              e.stopPropagation()
                              await handleRevokeInvite()
                            }}
                            disabled={isRevokingInvite}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </Tooltip>
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
        anchorRef={profileCardAnchorRef}
        onClose={() => {
          setProfileCardUserId(null)
          profileCardAnchorRef.current = null
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
