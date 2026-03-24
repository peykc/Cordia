import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import type { VirtuosoHandle } from 'react-virtuoso'
import { ArrowLeft, Copy, Check, EyeOff, Plus, Minus, X, Volume2, VolumeX } from 'lucide-react'
import { open, confirm } from '@tauri-apps/api/dialog'
import { listen } from '@tauri-apps/api/event'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { Button } from '../components/ui/button'
import { loadServer, type Server, fetchAndImportServerHintOpaque, createTemporaryInvite, revokeActiveInvite, getFileMetadata, computeFileSha256, registerAttachmentFromPath, getAttachmentRecord, shareAttachmentAgain } from '../lib/tauri'
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
import { useToast } from '../contexts/ToastContext'
import { TransferCenterButton } from '../components/TransferCenterButton'
import { NotificationCenterButton } from '../components/NotificationCenterButton'
import { Tooltip } from '../components/Tooltip'
import { usePresence, type PresenceLevel } from '../contexts/PresenceContext'
import { useVoicePresence } from '../contexts/VoicePresenceContext'
import { useSpeaking } from '../contexts/SpeakingContext'
import { useActiveServer } from '../contexts/ActiveServerContext'
import { useEphemeralMessages } from '../contexts/EphemeralMessagesContext'
import { cn } from '../lib/utils'
import { avatarStyleForUserId } from '../lib/userAvatarStyle'
import { getDraft, setDraft, clearDraft } from '../lib/messageDrafts'
import { ServerVoiceHeader } from '../components/server/ServerVoiceHeader'
import { ServerChatTimeline } from '../components/server/ServerChatTimeline'
import { ServerComposer, type StagedAttachment } from '../components/server/ServerComposer'
import { useMediaPreview } from '../contexts/MediaPreviewContext'
import { isMediaType, getFileTypeFromExt } from '../lib/fileType'
import { useRenderCount } from '../lib/useRenderCount'

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

function ServerViewPage() {
  useRenderCount('ServerViewPage')
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
    addBundlingMessage,
    updateBundlingProgress,
    requestAttachmentDownload,
    attachmentTransfers,
    transferHistory,
    sharedAttachments,
    hasAccessibleCompletedDownload,
    refreshSharedAttachments,
    notifyAttachmentReshared,
    markSharedInServer,
    isSharedInServer,
    getCachedPathForSha,
    updateAttachmentAspect,
  } = useEphemeralMessages()
  const { beaconUrl, status: beaconStatus } = useBeacon()
  const { toast } = useToast()
  /** For the current user, presence is instant from local state; for others, use signaling data. */
  const getMemberLevel = useCallback(
    (signingPubkey: string, userId: string, isInVoiceForUser: boolean): PresenceLevel => {
      if (identity?.user_id === userId) {
        if (beaconStatus !== 'connected') return 'offline'
        if (isInVoiceForUser) return 'in_call'
        if (activeSigningPubkey === signingPubkey) return 'active'
        return 'online'
      }
      return getLevel(signingPubkey, userId, isInVoiceForUser)
    },
    [identity?.user_id, beaconStatus, activeSigningPubkey, getLevel]
  )
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
  const [composerHasText, setComposerHasText] = useState(false)
  const virtuosoScrollerRef = useRef<HTMLDivElement | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const lastInitialBottomScrollChatKeyRef = useRef<string | null>(null)
  const pendingBottomStabilizeRef = useRef(0)
  /** When true, user has scrolled away from bottom (e.g. wheel up); skip forced bottom scroll until send/receipt or they return. */
  const userScrolledAwayRef = useRef(false)
  const coalescedStabilizeRafRef = useRef<number | null>(null)
  const bundlingProgressRef = useRef<{
    messageId: string
    attachmentIds: string[]
    progressByAtt: Record<string, number>
  } | null>(null)
  /** Refs to video container elements so we can scroll the active one into view when exiting fullscreen. */
  const videoScrollTargetsRef = useRef<Record<string, HTMLDivElement | null>>({})
  /** When set, this single-attachment video plays inline in chat (no overlay). */
  const [inlinePlayingVideoId, setInlinePlayingVideoId] = useState<string | null>(null)
  const [inlineVideoShowControls, setInlineVideoShowControls] = useState(false)
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null)
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftValueRef = useRef('')

  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([])
  const { setMediaPreview } = useMediaPreview()
  const [revealedSpoilerIds, setRevealedSpoilerIds] = useState<Set<string>>(new Set())
  const [unsharedAttachmentRecords, setUnsharedAttachmentRecords] = useState<Record<string, Awaited<ReturnType<typeof getAttachmentRecord>>>>({})
  const fetchedUnsharedIdsRef = useRef<Set<string>>(new Set())
  const unsharedPendingRef = useRef<Record<string, Awaited<ReturnType<typeof getAttachmentRecord>>>>({})
  const unsharedFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Optimistically hide Share/Upload button on click to prevent double-clicks before async completes. */
  const [justSharedKeys, setJustSharedKeys] = useState<Set<string>>(new Set())
  const shareInProgressRef = useRef(false)

  const MESSAGE_INPUT_MAX_HEIGHT = 100
  const DRAFT_SAVE_DEBOUNCE_MS = 300
  const MESSAGE_MAX_LENGTH = 2500

  const adjustComposerHeight = useCallback(() => {
    const el = messageInputRef.current
    if (!el) return
    el.style.height = 'auto'
    const capped = Math.min(el.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT)
    el.style.height = `${capped}px`
    const isScrollable = el.scrollHeight > MESSAGE_INPUT_MAX_HEIGHT
    el.style.overflowY = isScrollable ? 'auto' : 'hidden'
    // Keep cursor typing at the end smooth when content overflows.
    if (isScrollable && el.selectionStart === el.value.length) {
      el.scrollTop = el.scrollHeight
    }
  }, [MESSAGE_INPUT_MAX_HEIGHT])

  // Single group chat per server (v1: no chat selector)
  const groupChat = server?.chats?.[0] ?? null
  const chatMessages = useMemo(
    () => (groupChat && server?.signing_pubkey ? getMessages(server.signing_pubkey, groupChat.id) : []),
    [getMessages, server?.signing_pubkey, groupChat?.id]
  )
  const latestOwnReceiptKey = useMemo(() => {
    if (!identity?.user_id || chatMessages.length === 0) return null
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i]
      if (!msg || msg.from_user_id !== identity.user_id) continue
      const deliveredByCount = (msg.delivered_by ?? []).filter((uid) => uid !== identity.user_id).length
      return `${msg.id}:${msg.delivery_status ?? 'none'}:${deliveredByCount}`
    }
    return null
  }, [chatMessages, identity?.user_id])

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
    const toFetch = [...ids].filter((id) => !fetchedUnsharedIdsRef.current.has(id))
    const UNSHARED_FLUSH_MS = 150
    toFetch.forEach((id) => {
      fetchedUnsharedIdsRef.current.add(id)
      getAttachmentRecord(id).then((rec) => {
        unsharedPendingRef.current[id] = rec
        if (unsharedFlushRef.current) return
        unsharedFlushRef.current = setTimeout(() => {
          unsharedFlushRef.current = null
          const pending = unsharedPendingRef.current
          unsharedPendingRef.current = {}
          if (Object.keys(pending).length === 0) return
          setUnsharedAttachmentRecords((prev) => ({ ...prev, ...pending }))
        }, UNSHARED_FLUSH_MS)
      })
    })
    return () => {
      if (unsharedFlushRef.current) {
        clearTimeout(unsharedFlushRef.current)
        unsharedFlushRef.current = null
      }
    }
  }, [chatMessages, sharedAttachments, identity?.user_id])
  const canSendMessages = Boolean(groupChat && server?.connection_mode === 'Signaling' && beaconStatus === 'connected')

  const getProfile = useCallback(
    (userId: string) => remoteProfiles.getProfile(userId),
    [remoteProfiles]
  )

  const fallbackNameForUser = useCallback(
    (userId: string) => {
      const m = server?.members?.find((mm) => mm.user_id === userId)
      return m?.display_name ?? `User ${userId.slice(0, 8)}`
    },
    [server?.members]
  )

  const getInitials = useCallback((name: string) => {
    const cleaned = name.trim()
    if (!cleaned) return '?'
    const parts = cleaned.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }, [])

  const avatarStyleForUser = useCallback((userId: string): CSSProperties => avatarStyleForUserId(userId), [])

  const onProfileClick = useCallback((userId: string, element: HTMLElement) => {
    setProfileCardUserId(userId)
    profileCardAnchorRef.current = element
    setProfileCardAnchor(element.getBoundingClientRect())
  }, [])

  const isUserInVoiceForServer = useCallback(
    (userId: string) => {
      if (!server?.signing_pubkey) return false
      return voicePresence.isUserInVoice(server.signing_pubkey, userId)
    },
    [voicePresence, server?.signing_pubkey]
  )

  const PresenceSquare = ({ level, size = 'default' }: { level: 'active' | 'online' | 'offline' | 'in_call'; size?: 'default' | 'small' }) => {
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

  useEffect(() => {
    const unlistenPromise = listen<{ attachment_id: string; ok: boolean; error?: string }>(
      'cordia:attachment-ready',
      (event) => {
        const { attachment_id, ok } = event.payload ?? {}
        if (attachment_id == null || !ok) return
        setStagedAttachments((prev) =>
          prev.some((a) => a.attachment_id === attachment_id)
            ? prev.map((a) => (a.attachment_id === attachment_id ? { ...a, ready: true } : a))
            : prev
        )
      }
    )
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const unlistenPromise = listen<{ attachment_id: string; percent: number }>(
      'cordia:attachment-sha-progress',
      (event) => {
        const { attachment_id, percent } = event.payload ?? {}
        if (attachment_id == null || percent == null) return
        setStagedAttachments((prev) =>
          prev.some((a) => a.attachment_id === attachment_id)
            ? prev.map((a) =>
                a.attachment_id === attachment_id ? { ...a, preparePercent: Math.min(100, percent) } : a
              )
            : prev
        )
        const ref = bundlingProgressRef.current
        if (!ref) return
        ref.progressByAtt[attachment_id] = percent
        if (ref.attachmentIds.length === 0) return
        const total = ref.attachmentIds.reduce(
          (sum, id) => sum + (ref.progressByAtt[id] ?? 0),
          0
        )
        const avg = Math.round(total / ref.attachmentIds.length)
        updateBundlingProgress(ref.messageId, Math.min(100, avg))
      }
    )
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {})
    }
  }, [updateBundlingProgress])

  const handleSendMessage = async () => {
    if (!server || !groupChat || !identity || !canSendMessages) return
    const text = draftValueRef.current.trim().slice(0, MESSAGE_MAX_LENGTH)
    if (!text && stagedAttachments.length === 0) return

    draftValueRef.current = ''
    setComposerHasText(false)
    if (messageInputRef.current) {
      messageInputRef.current.value = ''
      adjustComposerHeight()
    }
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current)
      draftSaveTimeoutRef.current = null
    }
    if (currentAccountId) clearDraft(currentAccountId, server.signing_pubkey)
    const toSend = [...stagedAttachments]
    setStagedAttachments([])

    try {
      if (toSend.length > 0) {
        const allPrepared = toSend.every((a) => a.attachment_id && a.ready)
        if (!allPrepared) {
          throw new Error('Attachments are still preparing. Please wait.')
        }
        const attachmentIds = toSend.map((a) => a.attachment_id!).filter(Boolean)
        const messageId = `${identity.user_id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
        bundlingProgressRef.current = { messageId, attachmentIds, progressByAtt: {} }
        addBundlingMessage({
          messageId,
          signingPubkey: server.signing_pubkey,
          chatId: groupChat.id,
          fromUserId: identity.user_id,
          staged: toSend.map((s) => ({
            path: s.path,
            file_name: s.file_name,
            extension: s.extension,
            size_bytes: s.size_bytes,
            spoiler: s.spoiler,
          })),
          text: text || undefined,
        })
        const records = await Promise.all(attachmentIds.map((id) => getAttachmentRecord(id)))
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
        bundlingProgressRef.current = null
        await sendMixedMessage({
          serverId: server.id,
          signingPubkey: server.signing_pubkey,
          chatId: groupChat.id,
          fromUserId: identity.user_id,
          attachments: allAttachments,
          text: text || undefined,
          replaceMessageId: messageId,
        })
        for (const att of allAttachments) {
          if (att.sha256) markSharedInServer(server.signing_pubkey, att.sha256)
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
      userScrolledAwayRef.current = false
      pendingBottomStabilizeRef.current = 12
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' })
      requestAnimationFrame(() => {
        virtuosoRef.current?.autoscrollToBottom()
      })
    } catch (error) {
      console.warn('Failed to send:', error)
      bundlingProgressRef.current = null
      draftValueRef.current = text
      setComposerHasText(text.trim().length > 0)
      if (messageInputRef.current) {
        messageInputRef.current.value = text
        adjustComposerHeight()
      }
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
        const result = await registerAttachmentFromPath(p, storage_mode)
        const attachment_id = result.attachment_id
        const rec = await getAttachmentRecord(attachment_id)
        const ready = rec?.status === 'ready'
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
            attachment_id,
            ready: ready ?? false,
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

  const handleShareAgainAttachment = useCallback(
    async (
      att: { attachment_id: string; file_name: string; size_bytes: number; sha256?: string },
      isOwn: boolean,
      existingPath?: string | null
    ) => {
      const key = isOwn ? `att:${att.attachment_id}` : `sha:${att.sha256 ?? ''}`
      shareInProgressRef.current = true
      setJustSharedKeys((prev) => new Set(prev).add(key))
      try {
        if (isOwn) {
          const path = existingPath ?? getCachedPathForSha(att.sha256) ?? undefined
          try {
            await shareAttachmentAgain(att.attachment_id, path ?? undefined)
            await refreshSharedAttachments(att.attachment_id)
            if (server?.signing_pubkey && att.sha256) markSharedInServer(server.signing_pubkey, att.sha256)
            if (server?.signing_pubkey && groupChat?.id) {
              await notifyAttachmentReshared(server.signing_pubkey, groupChat.id, att.attachment_id)
            }
            if (att.sha256) setJustSharedKeys((p) => new Set(p).add(`sha:${att.sha256}`))
            return
          } catch (err) {
            if (!path) throw err
            const result = await registerAttachmentFromPath(path, 'program_copy')
            await refreshSharedAttachments()
            if (server?.signing_pubkey && att.sha256) markSharedInServer(server.signing_pubkey, att.sha256)
            if (server?.signing_pubkey && groupChat?.id) {
              await notifyAttachmentReshared(server.signing_pubkey, groupChat.id, result.attachment_id)
            }
            if (att.sha256) setJustSharedKeys((p) => new Set(p).add(`sha:${att.sha256}`))
            return
          }
        }
        if (!existingPath) return
        const existingBySha = att.sha256 ? sharedAttachments.find((s) => s.sha256 === att.sha256) : null
        if (existingBySha) {
          if (server?.signing_pubkey && att.sha256) markSharedInServer(server.signing_pubkey, att.sha256)
          if (server?.signing_pubkey && groupChat?.id) {
            await notifyAttachmentReshared(server.signing_pubkey, groupChat.id, existingBySha.attachment_id)
          }
          return
        }
        const result = await registerAttachmentFromPath(existingPath, 'program_copy')
        await refreshSharedAttachments()
        if (server?.signing_pubkey && att.sha256) markSharedInServer(server.signing_pubkey, att.sha256)
        if (server?.signing_pubkey && groupChat?.id) {
          await notifyAttachmentReshared(server.signing_pubkey, groupChat.id, result.attachment_id)
        }
      } catch (e: unknown) {
        setJustSharedKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        const msg = e instanceof Error ? e.message : String(e)
        if (isOwn && msg.includes('no longer exists')) {
          const selected = await open({ title: 'Select the same file (same file required)', multiple: false })
          const path = Array.isArray(selected) ? selected?.[0] : selected
          if (!path) return
          const meta = await getFileMetadata(path)
          if (meta.size_bytes !== att.size_bytes) {
            toast('File size does not match. Please select the exact same file.')
            return
          }
          if (att.sha256) {
            const actualSha = await computeFileSha256(path)
            if (actualSha.toLowerCase() !== att.sha256.toLowerCase()) {
              toast('File content does not match. Please select the exact same file.')
              return
            }
          }
          await shareAttachmentAgain(att.attachment_id, path)
          await refreshSharedAttachments(att.attachment_id)
          if (server?.signing_pubkey && groupChat?.id) {
            await notifyAttachmentReshared(server.signing_pubkey, groupChat.id, att.attachment_id)
          }
        }
      } finally {
        shareInProgressRef.current = false
      }
    },
    [
      server?.signing_pubkey,
      groupChat?.id,
      getCachedPathForSha,
      shareAttachmentAgain,
      refreshSharedAttachments,
      markSharedInServer,
      notifyAttachmentReshared,
      sharedAttachments,
      open,
      toast,
    ]
  )

  useEffect(() => {
    if (shareInProgressRef.current) return
    setJustSharedKeys((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(prev)
      const signingPubkey = server?.signing_pubkey ?? ''
      for (const k of prev) {
        if (k.startsWith('att:')) {
          const id = k.slice(4)
          const item = sharedAttachments.find((s) => s.attachment_id === id)
          if (!item?.can_share_now) next.delete(k)
        } else if (k.startsWith('sha:')) {
          const sha = k.slice(4)
          const hasSharedAttachment = sharedAttachments.some((s) => s.sha256 === sha)
          const sharedInThisServer = !!signingPubkey && isSharedInServer(signingPubkey, sha)
          if (!hasSharedAttachment || !sharedInThisServer) next.delete(k)
        }
      }
      return next
    })
  }, [sharedAttachments, server?.signing_pubkey, isSharedInServer])

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
    draftValueRef.current = draft
    setComposerHasText(draft.trim().length > 0)
    requestAnimationFrame(() => {
      const el = messageInputRef.current
      if (!el) return
      el.value = draft
      adjustComposerHeight()
    })
  }, [server?.signing_pubkey, currentAccountId, adjustComposerHeight])

  // Flush draft to sessionStorage on unmount (e.g. navigate away)
  useEffect(() => {
    return () => {
      if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current)
      if (server?.signing_pubkey && currentAccountId) {
        const value = draftValueRef.current
        if (value.trim().length === 0) clearDraft(currentAccountId, server.signing_pubkey)
        else setDraft(currentAccountId, server.signing_pubkey, value)
      }
    }
  }, [server?.signing_pubkey, currentAccountId])

  // Re-sync composer height when server/chat context changes.
  useEffect(() => {
    const raf = requestAnimationFrame(adjustComposerHeight)
    return () => cancelAnimationFrame(raf)
  }, [adjustComposerHeight, server?.signing_pubkey, groupChat?.id])

  const VirtuosoScroller = useMemo(
    () =>
      forwardRef<HTMLDivElement, ComponentProps<'div'>>((props, ref) => (
        <div
          {...props}
          onWheelCapture={props.onWheelCapture}
          ref={(node) => {
            virtuosoScrollerRef.current = node
            if (typeof ref === 'function') ref(node)
            else if (ref && typeof ref === 'object') {
              ;(ref as MutableRefObject<HTMLDivElement | null>).current = node
            }
          }}
          style={{
            ...(props.style ?? {}),
            overflowX: 'hidden',
          }}
        />
      )),
    []
  )

  useEffect(() => {
    const el = virtuosoScrollerRef.current
    if (!el) return
    const runStabilize = () => {
      if (pendingBottomStabilizeRef.current <= 0 || userScrolledAwayRef.current) return false
      const distanceFromBottom = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop)
      if (distanceFromBottom <= 4) {
        userScrolledAwayRef.current = false
        pendingBottomStabilizeRef.current = 0
        return false
      }
      pendingBottomStabilizeRef.current -= 1
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      requestAnimationFrame(() => {
        virtuosoRef.current?.autoscrollToBottom()
      })
      return pendingBottomStabilizeRef.current > 0
    }
    const MAX_SETTLE_FRAMES = 16
    let settleCount = 0
    const tick = () => {
      coalescedStabilizeRafRef.current = null
      settleCount += 1
      const shouldContinue = runStabilize()
      if (shouldContinue && settleCount < MAX_SETTLE_FRAMES) {
        coalescedStabilizeRafRef.current = requestAnimationFrame(tick)
      }
    }
    coalescedStabilizeRafRef.current = requestAnimationFrame(tick)
    const onScroll = () => {
      if (pendingBottomStabilizeRef.current <= 0) return
      if (coalescedStabilizeRafRef.current != null) return
      coalescedStabilizeRafRef.current = requestAnimationFrame(tick)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const onWheel = () => {
      const distanceFromBottom = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop)
      if (distanceFromBottom > 12) userScrolledAwayRef.current = true
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      if (coalescedStabilizeRafRef.current != null) cancelAnimationFrame(coalescedStabilizeRafRef.current)
    }
  }, [chatMessages.length, groupChat?.id])

  useEffect(() => {
    if (!groupChat?.id) return
    if (!chatMessages.length) return
    const chatKey = `${serverId ?? 'no-server'}:${groupChat.id}`
    const scrollRunKey = `${chatKey}:${location.key}`
    if (lastInitialBottomScrollChatKeyRef.current === scrollRunKey) return
    lastInitialBottomScrollChatKeyRef.current = scrollRunKey
    userScrolledAwayRef.current = false
    pendingBottomStabilizeRef.current = 12
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      requestAnimationFrame(() => {
        virtuosoRef.current?.autoscrollToBottom()
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [serverId, groupChat?.id, chatMessages.length, location.key])

  useEffect(() => {
    if (!groupChat?.id) return
    if (!latestOwnReceiptKey) return
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.autoscrollToBottom()
    })
    return () => cancelAnimationFrame(raf)
  }, [groupChat?.id, latestOwnReceiptKey])

  type ChatItem =
    | { type: 'day'; id: string; dateStr: string }
    | { type: 'group'; id: string; userId: string; messages: typeof chatMessages }
  const { chatItems, lastDeliveredMessageId, lastPendingMessageId } = useMemo(() => {
    const items: ChatItem[] = []
    let lastDateStr: string | null = null
    let currentGroup: { userId: string; messages: typeof chatMessages } | null = null
    const flushGroup = () => {
      if (currentGroup && currentGroup.messages.length > 0) {
        const firstMsg = currentGroup.messages[0]
        const groupId = firstMsg ? firstMsg.id : `${currentGroup.userId}:${items.length}`
        items.push({ type: 'group', id: groupId, userId: currentGroup.userId, messages: currentGroup.messages })
        currentGroup = null
      }
    }
    const formatDay = (d: Date) =>
      d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const FIVE_MIN_MS = 5 * 60 * 1000
    const MAX_MESSAGES_PER_GROUP = 8
    for (const msg of chatMessages) {
      const msgDate = new Date(msg.sent_at)
      const dateStr = formatDay(msgDate)
      if (dateStr !== lastDateStr) {
        flushGroup()
        lastDateStr = dateStr
        const dayId = `day:${dateStr}`
        items.push({ type: 'day', id: dayId, dateStr })
      }
      const prevMsg = currentGroup?.messages[currentGroup.messages.length - 1]
      const isContinuation =
        currentGroup &&
        currentGroup.userId === msg.from_user_id &&
        prevMsg &&
        currentGroup.messages.length < MAX_MESSAGES_PER_GROUP &&
        msgDate.getTime() - new Date(prevMsg.sent_at).getTime() < FIVE_MIN_MS
      if (!isContinuation) {
        flushGroup()
        currentGroup = { userId: msg.from_user_id, messages: [msg] }
      } else {
        currentGroup!.messages.push(msg)
      }
    }
    flushGroup()
    let lastDelivered: string | null = null
    let lastPending: string | null = null
    for (const msg of chatMessages) {
      if (msg.from_user_id !== identity?.user_id) continue
      if (msg.delivery_status === 'delivered') lastDelivered = msg.id
      else lastPending = msg.id
    }
    return { chatItems: items, lastDeliveredMessageId: lastDelivered, lastPendingMessageId: lastPending }
  }, [chatMessages, identity?.user_id])

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
              <ServerVoiceHeader
                server={server}
                groupChat={groupChat}
                identity={identity}
                profile={profile}
                voiceParticipants={voicePresence.getVoiceParticipants(server.signing_pubkey, groupChat.id)}
                webrtcIsInVoice={webrtcIsInVoice}
                currentRoomId={currentRoomId}
                getMemberLevel={getMemberLevel}
                isUserInVoice={isUserInVoiceForServer}
                isUserSpeaking={isUserSpeaking}
                getRemoteUserPrefs={getRemoteUserPrefs}
                getProfile={getProfile}
                getInitials={getInitials}
                avatarStyleForUser={avatarStyleForUser}
                onProfileClick={onProfileClick}
                onVoiceVolumeMenu={(userId, displayName, x, y) =>
                  setVoiceVolumeMenu({ userId, displayName, x, y })
                }
                onJoinVoice={handleJoinVoice}
                onLeaveVoice={handleLeaveVoice}
              />

              {/* Text Chat Area */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-hidden">
                    {chatMessages.length === 0 && (
                      <div className="flex justify-center py-12">
                        <p className="text-sm text-muted-foreground font-light">
                          Welcome to <span className="text-foreground font-normal">{server.name}</span> — your group chat.
                        </p>
                      </div>
                    )}
                    {chatMessages.length > 0 && (
                      <ServerChatTimeline
                        virtuosoKey={`${serverId ?? 'no-server'}:${groupChat?.id ?? 'no-chat'}:${location.key}`}
                        chatItems={chatItems}
                        virtuosoRef={virtuosoRef}
                        VirtuosoScroller={VirtuosoScroller}
                        server={server}
                        groupChat={groupChat}
                        identity={identity}
                        profile={profile}
                        getProfile={getProfile}
                        getMemberLevel={getMemberLevel}
                        isUserInVoice={isUserInVoiceForServer}
                        fallbackNameForUser={fallbackNameForUser}
                        getInitials={getInitials}
                        avatarStyleForUser={avatarStyleForUser}
                        onProfileClick={onProfileClick}
                        lastDeliveredMessageId={lastDeliveredMessageId}
                        lastPendingMessageId={lastPendingMessageId}
                        attachmentTransfers={attachmentTransfers}
                        transferHistory={transferHistory}
                        sharedAttachments={sharedAttachments}
                        hasAccessibleCompletedDownload={hasAccessibleCompletedDownload}
                        getCachedPathForSha={getCachedPathForSha}
                        getLevel={getLevel}
                        unsharedAttachmentRecords={unsharedAttachmentRecords as Record<string, { file_path?: string | null; thumbnail_path?: string | null } | null | undefined>}
                        revealedSpoilerIds={revealedSpoilerIds}
                        setRevealedSpoilerIds={setRevealedSpoilerIds}
                        updateAttachmentAspect={updateAttachmentAspect}
                        requestAttachmentDownload={requestAttachmentDownload}
                        isSharedInServer={isSharedInServer}
                        justSharedKeys={justSharedKeys}
                        handleShareAgainAttachment={handleShareAgainAttachment}
                        setMediaPreview={setMediaPreview}
                        inlinePlayingVideoId={inlinePlayingVideoId}
                        setInlinePlayingVideoId={setInlinePlayingVideoId}
                        videoScrollTargetsRef={videoScrollTargetsRef}
                        setInlineVideoShowControls={setInlineVideoShowControls}
                        inlineVideoShowControls={inlineVideoShowControls}
                      />
                    )}
                </div>
                <ServerComposer
                  messageInputRef={messageInputRef}
                  composerHasText={composerHasText}
                  setComposerHasText={setComposerHasText}
                  adjustComposerHeight={adjustComposerHeight}
                  onDraftChange={(v) => {
                    draftValueRef.current = v
                    if (server && currentAccountId) {
                      if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current)
                      draftSaveTimeoutRef.current = setTimeout(() => {
                        setDraft(currentAccountId, server.signing_pubkey, v)
                        draftSaveTimeoutRef.current = null
                      }, DRAFT_SAVE_DEBOUNCE_MS)
                    }
                  }}
                  canSendMessages={canSendMessages}
                  beaconStatus={beaconStatus}
                  stagedAttachments={stagedAttachments}
                  messageMaxLength={MESSAGE_MAX_LENGTH}
                  messageInputMaxHeight={MESSAGE_INPUT_MAX_HEIGHT}
                  onSendMessage={handleSendMessage}
                  onAddAttachment={handleAddAttachment}
                  onRemoveStagedAttachment={handleRemoveStagedAttachment}
                  onToggleStagedSpoiler={handleToggleStagedSpoiler}
                  onMediaPreview={({ type, url, fileName, localPath, sizeBytes }) => {
                    if (!identity?.user_id) return
                    setMediaPreview({
                      type,
                      url,
                      attachmentId: undefined,
                      fileName,
                      source: 'chat',
                      originUserId: identity.user_id,
                      originSentAtIso: new Date().toISOString(),
                      originDisplayName: identity.display_name ?? 'You',
                      originAvatarDataUrl: profile.avatar_data_url ?? null,
                      localPath,
                      sizeBytes,
                      showShareInChat: false,
                    })
                  }}
                />
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
                    className="flex gap-2 px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors w-full text-left min-w-0 overflow-visible"
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
