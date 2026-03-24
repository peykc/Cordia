import React, { memo, useMemo, useRef, type ComponentProps, type MutableRefObject, type RefObject } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { MessageBubble } from '../MessageBubble'
import { ServerMessageContent } from './ServerMessageContent'
import type { EphemeralChatMessage } from '../../contexts/EphemeralMessagesContext'
import type { MediaPreviewState } from '../../contexts/MediaPreviewContext'
import type { AttachmentTransferState, TransferHistoryEntry } from '../../contexts/EphemeralMessagesContext'
import type { PresenceLevel } from '../../contexts/PresenceContext'
import type { Server } from '../../lib/tauri'

type ChatItem =
  | { type: 'day'; id: string; dateStr: string }
  | { type: 'group'; id: string; userId: string; messages: EphemeralChatMessage[] }

/** Avoid invalidating heavy row-model useMemo when transfer history changes but attachment-derived maps are unchanged. */
function shallowAttachmentMapEqual(
  a: Record<string, boolean | string | undefined>,
  b: Record<string, boolean | string | undefined>
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/** Per-message primitives only; reused when unchanged so React.memo is effective. */
export interface MessageRowModel {
  attachmentStateLabel: string | null
  hostOnlineForAttachment: boolean
  swarmSourceCount: number
}

/** Callbacks and shared state passed via ref so row props stay stable. */
export interface MessageRowCallbacks {
  identity: ServerChatTimelineProps['identity']
  sharedAttachments: SharedAttachmentItem[]
  unsharedAttachmentRecords: Record<string, { file_path?: string | null; thumbnail_path?: string | null } | null | undefined>
  transferHistory: TransferHistoryEntry[]
  attachmentTransfersByMessageId: Record<string, AttachmentTransferState[]>
  rejectedDownloadByAttachmentId: Record<string, boolean>
  activeUploadByAttachmentId: Record<string, boolean>
  sharedByAttachmentId: Record<string, SharedAttachmentItem | undefined>
  completedDownloadPathByAttachmentId: Record<string, string | undefined>
  getCachedPathForSha: (sha256: string | undefined) => string | null
  hasAccessibleCompletedDownload: (id: string | null | undefined) => boolean
  revealedSpoilerIds: Set<string>
  setRevealedSpoilerIds: (fn: (prev: Set<string>) => Set<string>) => void
  server: Server
  groupChat: { id: string }
  profile: ServerChatTimelineProps['profile']
  getProfile: ServerChatTimelineProps['getProfile']
  fallbackNameForUser: ServerChatTimelineProps['fallbackNameForUser']
  updateAttachmentAspect: ServerChatTimelineProps['updateAttachmentAspect']
  requestAttachmentDownload: ServerChatTimelineProps['requestAttachmentDownload']
  isSharedInServer: (serverSigningPubkey: string, sha256: string) => boolean
  justSharedKeys: Set<string>
  handleShareAgainAttachment: ServerChatTimelineProps['handleShareAgainAttachment']
  setMediaPreview: (state: MediaPreviewState) => void
  inlinePlayingVideoId: string | null
  setInlinePlayingVideoId: (id: string | null) => void
  videoScrollTargetsRef: MutableRefObject<Record<string, HTMLDivElement | null>>
  setInlineVideoShowControls: (show: boolean) => void
  inlineVideoShowControls: boolean
}

interface ServerMessageRowProps {
  msg: EphemeralChatMessage
  isFirstInGroup: boolean
  displayName: string
  levelColor: string
  currentUserId: string | undefined
  lastDeliveredMessageId: string | null
  lastPendingMessageId: string | null
  rowModel: MessageRowModel
  callbacksRef: React.MutableRefObject<MessageRowCallbacks | null>
}
const ServerMessageRow = memo(function ServerMessageRow({
  msg,
  isFirstInGroup,
  displayName,
  levelColor,
  currentUserId,
  lastDeliveredMessageId,
  lastPendingMessageId,
  rowModel,
  callbacksRef,
}: ServerMessageRowProps) {
  const callbacks = callbacksRef.current
  return (
    <MessageBubble
      msg={msg}
      isFirstInGroup={isFirstInGroup}
      displayName={displayName}
      levelColor={levelColor}
      currentUserId={currentUserId}
      lastDeliveredMessageId={lastDeliveredMessageId}
      lastPendingMessageId={lastPendingMessageId}
    >
      <ServerMessageContent msg={msg} rowModel={rowModel} callbacks={callbacks} />
    </MessageBubble>
  )
})

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

interface SharedAttachmentItem {
  attachment_id: string
  can_share_now?: boolean
  file_path?: string | null
  thumbnail_path?: string | null
  sha256?: string
}

export interface ServerChatTimelineProps {
  virtuosoKey: string
  chatItems: ChatItem[]
  virtuosoRef: RefObject<VirtuosoHandle | null>
  VirtuosoScroller: React.ForwardRefExoticComponent<
    ComponentProps<'div'> & React.RefAttributes<HTMLDivElement>
  >
  server: Server
  groupChat: { id: string }
  identity: { user_id: string; display_name?: string } | null
  profile: { avatar_data_url?: string | null }
  getProfile: (userId: string) =>
    | { display_name?: string | null; avatar_data_url?: string | null }
    | null
    | undefined
  getMemberLevel: (signingPubkey: string, userId: string, isInVoiceForUser: boolean) => PresenceLevel
  isUserInVoice: (userId: string) => boolean
  fallbackNameForUser: (userId: string) => string
  getInitials: (name: string) => string
  avatarStyleForUser: (userId: string) => React.CSSProperties
  onProfileClick: (userId: string, element: HTMLElement) => void
  lastDeliveredMessageId: string | null
  lastPendingMessageId: string | null
  attachmentTransfers: AttachmentTransferState[]
  transferHistory: TransferHistoryEntry[]
  sharedAttachments: SharedAttachmentItem[]
  hasAccessibleCompletedDownload: (attachmentId: string | null | undefined) => boolean
  getCachedPathForSha: (sha256: string | undefined) => string | null
  getLevel: (signingPubkey: string, userId: string, isInCall?: boolean) => PresenceLevel
  unsharedAttachmentRecords: Record<string, { file_path?: string | null; thumbnail_path?: string | null } | null | undefined>
  revealedSpoilerIds: Set<string>
  setRevealedSpoilerIds: (fn: (prev: Set<string>) => Set<string>) => void
  updateAttachmentAspect: (
    signingPubkey: string,
    chatId: string,
    messageId: string,
    attachmentId: string,
    aspect: { w: number; h: number }
  ) => void
  requestAttachmentDownload: (msg: EphemeralChatMessage, attachment?: EphemeralChatMessage['attachment']) => Promise<void>
  isSharedInServer: (serverSigningPubkey: string, sha256: string) => boolean
  justSharedKeys: Set<string>
  handleShareAgainAttachment: (
    att: { attachment_id: string; file_name: string; size_bytes: number; sha256?: string },
    isOwn: boolean,
    existingPath?: string | null
  ) => Promise<void>
  setMediaPreview: (state: MediaPreviewState) => void
  inlinePlayingVideoId: string | null
  setInlinePlayingVideoId: (id: string | null) => void
  videoScrollTargetsRef: MutableRefObject<Record<string, HTMLDivElement | null>>
  setInlineVideoShowControls: (show: boolean) => void
  inlineVideoShowControls: boolean
}

function ServerChatTimelineImpl(props: ServerChatTimelineProps) {
  const {
    virtuosoKey,
    chatItems,
  virtuosoRef,
  VirtuosoScroller,
    server,
    groupChat,
    identity,
    profile,
    getProfile,
    getMemberLevel,
    isUserInVoice,
    fallbackNameForUser,
    getInitials,
    avatarStyleForUser,
    onProfileClick,
    lastDeliveredMessageId,
    lastPendingMessageId,
    attachmentTransfers,
    transferHistory,
    sharedAttachments,
    hasAccessibleCompletedDownload,
    getCachedPathForSha,
    getLevel,
    unsharedAttachmentRecords,
    revealedSpoilerIds,
    setRevealedSpoilerIds,
    updateAttachmentAspect,
    requestAttachmentDownload,
    isSharedInServer,
    justSharedKeys,
    handleShareAgainAttachment,
    setMediaPreview,
    inlinePlayingVideoId,
    setInlinePlayingVideoId,
    videoScrollTargetsRef,
    setInlineVideoShowControls,
    inlineVideoShowControls,
  } = props

  const transferByMessageId = useMemo(() => {
    const byMsg: Record<string, AttachmentTransferState[]> = {}
    const attachmentToMessageIds: Record<string, Set<string>> = {}
    for (const it of chatItems) {
      if (it.type !== 'group') continue
      for (const msg of it.messages) {
        const atts = msg.attachments ?? (msg.attachment ? [msg.attachment] : [])
        for (const a of atts) {
          if (!attachmentToMessageIds[a.attachment_id]) attachmentToMessageIds[a.attachment_id] = new Set()
          attachmentToMessageIds[a.attachment_id].add(msg.id)
        }
      }
    }
    for (const t of attachmentTransfers) {
      if (!byMsg[t.message_id]) byMsg[t.message_id] = []
      byMsg[t.message_id].push(t)
      const msgIds = attachmentToMessageIds[t.attachment_id]
      if (msgIds) {
        for (const mid of msgIds) {
          if (mid === t.message_id) continue
          if (!byMsg[mid]) byMsg[mid] = []
          byMsg[mid].push(t)
        }
      }
    }
    return byMsg
  }, [chatItems, attachmentTransfers])

  const attachmentMapsCacheRef = useRef<{
    rejected: Record<string, boolean>
    activeUpload: Record<string, boolean>
    completed: Record<string, string | undefined>
  } | null>(null)

  /** Per-attachment summary maps so rows don't scan global arrays during render. */
  const { rejectedDownloadByAttachmentId, activeUploadByAttachmentId, completedDownloadPathByAttachmentId } = useMemo(() => {
    const rejected: Record<string, boolean> = {}
    const activeUpload: Record<string, boolean> = {}
    const completedDownloadPath: Record<string, string | undefined> = {}
    for (const t of attachmentTransfers) {
      if (t.direction === 'download' && t.status === 'rejected') {
        rejected[t.attachment_id] = true
      }
      if (
        t.direction === 'upload' &&
        t.status !== 'completed' &&
        t.status !== 'failed' &&
        t.status !== 'rejected'
      ) {
        activeUpload[t.attachment_id] = true
      }
    }
    for (const h of transferHistory) {
      if (h.direction === 'download' && h.status === 'rejected') {
        rejected[h.attachment_id] = true
      }
      if (
        h.direction === 'download' &&
        h.status === 'completed' &&
        h.saved_path &&
        !completedDownloadPath[h.attachment_id]
      ) {
        completedDownloadPath[h.attachment_id] = h.saved_path
      }
    }
    const prev = attachmentMapsCacheRef.current
    if (
      prev &&
      shallowAttachmentMapEqual(prev.rejected, rejected) &&
      shallowAttachmentMapEqual(prev.activeUpload, activeUpload) &&
      shallowAttachmentMapEqual(prev.completed, completedDownloadPath)
    ) {
      return {
        rejectedDownloadByAttachmentId: prev.rejected,
        activeUploadByAttachmentId: prev.activeUpload,
        completedDownloadPathByAttachmentId: prev.completed,
      }
    }
    attachmentMapsCacheRef.current = {
      rejected,
      activeUpload,
      completed: completedDownloadPath,
    }
    return {
      rejectedDownloadByAttachmentId: rejected,
      activeUploadByAttachmentId: activeUpload,
      completedDownloadPathByAttachmentId: completedDownloadPath,
    }
  }, [attachmentTransfers, transferHistory])

  const sharedByAttachmentId = useMemo(() => {
    const map: Record<string, SharedAttachmentItem | undefined> = {}
    for (const s of sharedAttachments) {
      map[s.attachment_id] = s
    }
    return map
  }, [sharedAttachments])

  const prevRowModelsRef = useRef<Record<string, MessageRowModel>>({})
  const perfLogCountRef = useRef(0)

  /** Dev-only metric for row-model cache effectiveness. */
  const __DEV__ = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false
  const rowModelByMessageId = useMemo(() => {
    const next: Record<string, MessageRowModel> = {}
    let total = 0
    let reused = 0
    for (const it of chatItems) {
      if (it.type !== 'group') continue
      for (const msg of it.messages) {
        total += 1
        const messageAttachments = msg.attachments ?? (msg.attachment ? [msg.attachment] : [])
        const hostOnlineForAttachment =
          messageAttachments.length > 0
            ? getLevel(
                server.signing_pubkey,
                msg.from_user_id,
                isUserInVoice(msg.from_user_id)
              ) !== 'offline'
            : false
        const attachmentStateLabelFor = (att: { attachment_id: string; sha256?: string }) =>
          hasAccessibleCompletedDownload(att.attachment_id) ||
          (att.sha256 ? !!getCachedPathForSha(att.sha256) : false)
            ? 'Cached'
            : msg.from_user_id === identity?.user_id
              ? sharedByAttachmentId[att.attachment_id]?.can_share_now
                ? 'Available'
                : 'Unavailable'
              : rejectedDownloadByAttachmentId[att.attachment_id] || !hostOnlineForAttachment
                ? 'Unavailable'
                : 'Available'
        const attachmentStateLabel =
          messageAttachments.length === 1 ? attachmentStateLabelFor(messageAttachments[0]) : null
        const swarmSourceCount =
          messageAttachments.length === 1
            ? (() => {
                const att = messageAttachments[0]
                let count = hostOnlineForAttachment ? 1 : 0
                if (
                  att.sha256 &&
                  isSharedInServer(server.signing_pubkey, att.sha256) &&
                  msg.from_user_id !== identity?.user_id
                ) {
                  count += 1
                }
                return count
              })()
            : 0
        const rowModel: MessageRowModel = {
          attachmentStateLabel,
          hostOnlineForAttachment,
          swarmSourceCount,
        }
        const prev = prevRowModelsRef.current[msg.id]
        const same =
          prev &&
          prev.attachmentStateLabel === rowModel.attachmentStateLabel &&
          prev.hostOnlineForAttachment === rowModel.hostOnlineForAttachment &&
          prev.swarmSourceCount === rowModel.swarmSourceCount
        if (same) reused += 1
        next[msg.id] = same ? prev : rowModel
      }
    }
    if (__DEV__ && total > 0) {
      const pct = Math.round((reused / total) * 100)
      perfLogCountRef.current += 1
      if (perfLogCountRef.current <= 3 || perfLogCountRef.current % 20 === 0) {
        console.log(`[perf] rowModel reuse ${reused}/${total} (${pct}%)`)
      }
    }
    prevRowModelsRef.current = next
    return next
  }, [
    chatItems,
    sharedByAttachmentId,
    rejectedDownloadByAttachmentId,
    hasAccessibleCompletedDownload,
    getCachedPathForSha,
    getLevel,
    isUserInVoice,
    server.signing_pubkey,
    identity?.user_id,
    isSharedInServer,
  ])

  /** Precompute presence level and color per user so itemContent doesn't call getMemberLevel per group. */
  const { levelColorByUserId, levelByUserId } = useMemo(() => {
    const colorByUserId: Record<string, string> = {}
    const levelByUserId: Record<string, PresenceLevel> = {}
    for (const it of chatItems) {
      if (it.type !== 'group') continue
      const { userId } = it
      if (userId in colorByUserId) continue
      const memberLevel = getMemberLevel(server.signing_pubkey, userId, isUserInVoice(userId))
      levelByUserId[userId] = memberLevel
      colorByUserId[userId] =
        memberLevel === 'in_call'
          ? 'text-blue-500'
          : memberLevel === 'active'
            ? 'text-green-500'
            : memberLevel === 'online'
              ? 'text-amber-500'
              : 'text-muted-foreground'
    }
    return { levelColorByUserId: colorByUserId, levelByUserId }
  }, [chatItems, getMemberLevel, isUserInVoice, server.signing_pubkey])

  const callbacksRef = useRef<MessageRowCallbacks | null>(null)
  callbacksRef.current = {
    identity,
    sharedAttachments,
    unsharedAttachmentRecords,
    transferHistory,
    attachmentTransfersByMessageId: transferByMessageId,
    rejectedDownloadByAttachmentId,
    activeUploadByAttachmentId,
    sharedByAttachmentId,
    completedDownloadPathByAttachmentId,
    getCachedPathForSha,
    hasAccessibleCompletedDownload,
    revealedSpoilerIds,
    setRevealedSpoilerIds,
    server,
    groupChat,
    profile,
    getProfile,
    fallbackNameForUser,
    updateAttachmentAspect,
    requestAttachmentDownload,
    isSharedInServer,
    justSharedKeys,
    handleShareAgainAttachment,
    setMediaPreview,
    inlinePlayingVideoId,
    setInlinePlayingVideoId,
    videoScrollTargetsRef,
    setInlineVideoShowControls,
    inlineVideoShowControls,
  }

  const itemContent = useMemo(
    () =>
      function ItemContent(_idx: number, item: ChatItem) {
        if (item.type === 'day') {
          return (
            <div key={item.id} className="max-w-6xl mx-auto flex items-center gap-3 py-2" aria-hidden>
              <div className="h-px flex-1 bg-muted-foreground/50" />
              <span className="text-xs text-muted-foreground shrink-0">{item.dateStr}</span>
              <div className="h-px flex-1 bg-muted-foreground/50" />
            </div>
          )
        }
        const { userId, messages } = item
        const displayName =
          userId === identity?.user_id ? identity?.display_name ?? 'You' : fallbackNameForUser(userId)
        const rp = userId === identity?.user_id ? null : getProfile(userId)
        const avatarUrl = userId === identity?.user_id ? profile.avatar_data_url : rp?.avatar_data_url
        const levelColor = levelColorByUserId[userId] ?? 'text-muted-foreground'
        const memberLevel = levelByUserId[userId] ?? 'offline'
        return (
          <div key={item.id} className="max-w-6xl mx-auto flex gap-2 py-1">
            <div className="shrink-0 w-8 flex flex-col items-center pt-0.5 self-start z-10 bg-background pb-1">
              <div className="relative overflow-visible will-change-transform transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.06]">
                <div className="absolute -left-1 top-1/2 -translate-y-1/2 z-10">
                  <PresenceSquare level={memberLevel} />
                </div>
                <button
                  type="button"
                  className="relative h-8 w-8 grid place-items-center rounded-none ring-2 ring-background shrink-0 focus:outline-none overflow-hidden"
                  style={!avatarUrl ? avatarStyleForUser(userId) : undefined}
                  onClick={(e) => onProfileClick(userId, e.currentTarget)}
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
                const rowModel = rowModelByMessageId[msg.id]
                if (!rowModel) return null
                return (
                  <ServerMessageRow
                    key={msg.id}
                    msg={msg}
                    isFirstInGroup={msgIdx === 0}
                    displayName={displayName}
                    levelColor={levelColor}
                    currentUserId={identity?.user_id}
                    lastDeliveredMessageId={lastDeliveredMessageId}
                    lastPendingMessageId={lastPendingMessageId}
                    rowModel={rowModel}
                    callbacksRef={callbacksRef}
                  />
                )
              })}
            </div>
          </div>
        )
      },
    [
      identity,
      profile.avatar_data_url,
      getProfile,
      fallbackNameForUser,
      getInitials,
      avatarStyleForUser,
      onProfileClick,
      levelColorByUserId,
      levelByUserId,
      lastDeliveredMessageId,
      lastPendingMessageId,
      rowModelByMessageId,
      callbacksRef,
    ]
  )

  return (
    <Virtuoso
      key={virtuosoKey}
      ref={virtuosoRef as React.RefObject<VirtuosoHandle>}
      className="p-4 pt-2"
      style={{ height: '100%' }}
      components={{ Scroller: VirtuosoScroller }}
      data={chatItems}
      computeItemKey={(_, item) => item.id}
      alignToBottom
      followOutput="smooth"
      initialTopMostItemIndex={Math.max(chatItems.length - 1, 0)}
      itemContent={itemContent}
    />
  )
}

export const ServerChatTimeline = memo(ServerChatTimelineImpl)
