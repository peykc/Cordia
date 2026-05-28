import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { convertFileSrc } from '@tauri-apps/api/tauri'
import { useMediaPreview } from '../../contexts/MediaPreviewContext'
import { useEphemeralMessages } from '../../contexts/EphemeralMessagesContext'
import { useIdentity } from '../../contexts/IdentityContext'
import { useProfile } from '../../contexts/ProfileContext'
import { useRemoteProfiles } from '../../contexts/RemoteProfilesContext'
import { useActiveServer } from '../../contexts/ActiveServerContext'
import { useMessageById, useEphemeralMessagesStore } from '../../stores/ephemeralMessagesStore'
import { buildChatMediaPreviewState } from '../../lib/chatMediaPreview'
import { getFileTypeFromExt, isMediaType } from '../../lib/fileType'
import type { EphemeralAttachmentMeta } from '../../domain/attachments/types'
import type { ChatMediaGalleryItem, MediaPreviewState } from '../../domain/media/types'
import type { SharedAttachmentPresentationItem } from '../chat/buildAttachmentPresentation'
import { resolveLiveDownloadForAttachment } from '../chat/useAttachmentPresentation'
import { buildAttachmentPresentationFromFacts } from '../chat/buildAttachmentPresentation'
import { attachmentShareInChatVisible } from '../../lib/attachmentShareInChat'
import { consumeChatPreviewShareHandler } from './chatPreviewShareRegistry'

function presentationForAttachment(
  att: EphemeralAttachmentMeta,
  messageFromUserId: string,
  identityUserId: string | undefined,
  sharedByAttachmentId: Record<string, SharedAttachmentPresentationItem | undefined>,
  getCachedPathForSha: (sha: string | undefined) => string | null,
  hasAccessibleCompletedDownload: (id: string | null | undefined) => boolean
) {
  const isOwn = messageFromUserId === identityUserId
  const state = useEphemeralMessagesStore.getState()
  const liveDownload = resolveLiveDownloadForAttachment(
    state.transfersByRequestId,
    state.activeDownloadRequestIdByAttachmentId,
    att.attachment_id
  )
  return buildAttachmentPresentationFromFacts({
    attachmentRef: att,
    isOwn,
    liveDownload,
    sharedItem: sharedByAttachmentId[att.attachment_id],
    cachedPath: getCachedPathForSha(att.sha256) ?? undefined,
    unsharedRec: null,
    hasAccessibleCompletedDownload,
  })
}

/** Resolves chat image MediaPreviewSession into rich preview state from current store facts. */
export function MediaPreviewSessionBridge() {
  const { mediaPreviewSession, setMediaPreview } = useMediaPreview()
  const { identity } = useIdentity()
  const { profile } = useProfile()
  const remoteProfiles = useRemoteProfiles()
  const { activeSigningPubkey } = useActiveServer()
  const { isSharedInServer, hasAccessibleCompletedDownload, getCachedPathForSha } = useEphemeralMessages()
  const justSharedKeys = useMemo(() => new Set<string>(), [])

  const message = useMessageById(mediaPreviewSession?.messageId)
  const sharedByAttachmentId = useEphemeralMessagesStore(
    useShallow((s) => {
      const map: Record<string, SharedAttachmentPresentationItem> = {}
      for (const item of s.sharedAttachments) map[item.attachment_id] = item
      return map
    })
  )

  useEffect(() => {
    if (!mediaPreviewSession || mediaPreviewSession.source !== 'chat') return
    if (!message) return
    const attachmentRefId = mediaPreviewSession.attachmentRefId
    if (!attachmentRefId) return

    const attachmentsList = message.attachments ?? (message.attachment ? [message.attachment] : [])
    const att = attachmentsList.find((a) => a.attachment_id === attachmentRefId)
    if (!att) return
    if (getFileTypeFromExt(att.file_name) !== 'image') return

    const presentation = presentationForAttachment(
      att,
      message.from_user_id,
      identity?.user_id,
      sharedByAttachmentId,
      getCachedPathForSha,
      hasAccessibleCompletedDownload
    )
    const url = presentation.hasPath ? convertFileSrc(presentation.hasPath) : null

    const mediaOnly = attachmentsList.filter((a: EphemeralAttachmentMeta) =>
      isMediaType(getFileTypeFromExt(a.file_name))
    )

    let chatMediaGallery: { items: ChatMediaGalleryItem[]; startIndex: number } | undefined
    if (mediaOnly.length >= 2) {
      const galleryIds = mediaPreviewSession.galleryAttachmentRefIds
      const ordered =
        galleryIds && galleryIds.length > 0
          ? galleryIds
              .map((id) => mediaOnly.find((a) => a.attachment_id === id))
              .filter((a): a is EphemeralAttachmentMeta => a != null)
          : mediaOnly
      const startIndex = Math.max(0, ordered.findIndex((a) => a.attachment_id === attachmentRefId))
      chatMediaGallery = {
        startIndex,
        items: ordered.map((a) => {
          const pres = presentationForAttachment(
            a,
            message.from_user_id,
            identity?.user_id,
            sharedByAttachmentId,
            getCachedPathForSha,
            hasAccessibleCompletedDownload
          )
          const pathUrl = pres.hasPath ? convertFileSrc(pres.hasPath) : null
          const thumb = pres.thumbPath ? convertFileSrc(pres.thumbPath) : pathUrl
          const isOwnAtt = message.from_user_id === identity?.user_id
          const activeUpload = useEphemeralMessagesStore.getState().activeUploadIds.some(
            (id) =>
              useEphemeralMessagesStore.getState().transfersByRequestId[id]?.attachment_id === a.attachment_id
          )
          const sh = attachmentShareInChatVisible({
            isOwn: isOwnAtt,
            hasPath: !!pres.hasPath,
            deliveryStatus: message.delivery_status,
            serverSigningPubkey: activeSigningPubkey ?? '',
            sha256: a.sha256,
            attachmentId: a.attachment_id,
            isSharedInServer,
            justSharedKeys,
            hasActiveUpload: activeUpload,
          })
          const shareHandler = consumeChatPreviewShareHandler(a.attachment_id)
          return {
            type: 'image' as const,
            url: pathUrl,
            attachmentId: a.attachment_id,
            fileName: a.file_name,
            localPath: pres.hasPath ?? null,
            sizeBytes: a.size_bytes,
            sha256: a.sha256,
            aspectW: a.aspect_ratio_w,
            aspectH: a.aspect_ratio_h,
            thumbnailUrl: thumb,
            showShareInChat: sh,
            onShareInChat: sh && shareHandler ? shareHandler : undefined,
          }
        }),
      }
    }

    const preview = {
      ...buildChatMediaPreviewState({
        type: 'image',
        url,
        attachmentId: att.attachment_id,
        fileName: att.file_name,
        msg: message,
        att,
        hasPath: presentation.hasPath,
        serverSigningPubkey: activeSigningPubkey ?? '',
        identityUserId: identity?.user_id,
        profileAvatarDataUrl: profile?.avatar_data_url,
        getProfile: (uid) => remoteProfiles.getProfile(uid),
        fallbackNameForUser: (id) => `User ${id.slice(0, 8)}`,
        ownDisplayName: identity?.display_name ?? 'You',
        isSharedInServer,
        justSharedKeys,
        hasActiveUploadForAttachment: (a) =>
          useEphemeralMessagesStore.getState().activeUploadIds.some(
            (id) => useEphemeralMessagesStore.getState().transfersByRequestId[id]?.attachment_id === a.attachment_id
          ),
        handleShareAgainAttachment: (a) => {
          consumeChatPreviewShareHandler(a.attachment_id)?.()
        },
      }),
      chatMediaGallery,
    } as MediaPreviewState
    setMediaPreview(preview)
  }, [
    mediaPreviewSession,
    message,
    identity,
    profile,
    remoteProfiles,
    activeSigningPubkey,
    isSharedInServer,
    justSharedKeys,
    hasAccessibleCompletedDownload,
    getCachedPathForSha,
    sharedByAttachmentId,
    setMediaPreview,
  ])

  return null
}
