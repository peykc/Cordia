import type { MediaPreviewState } from '../contexts/MediaPreviewContext'
import type { EphemeralAttachmentMeta, EphemeralChatMessage } from '../contexts/EphemeralMessagesContext'
import { attachmentShareInChatVisible } from './attachmentShareInChat'

export function buildChatMediaPreviewState(params: {
  type: 'image' | 'video'
  url: string | null
  attachmentId?: string
  fileName?: string
  msg: EphemeralChatMessage
  att: EphemeralAttachmentMeta
  hasPath: string | undefined
  serverSigningPubkey: string
  identityUserId: string | undefined
  /** Local profile avatar (current user). */
  profileAvatarDataUrl: string | null | undefined
  getProfile: (userId: string) => { display_name?: string | null; avatar_data_url?: string | null } | null | undefined
  fallbackNameForUser: (userId: string) => string
  ownDisplayName: string
  isSharedInServer: (serverSigningPubkey: string, sha256: string) => boolean
  justSharedKeys: Set<string>
  hasActiveUploadForAttachment: (att: EphemeralAttachmentMeta) => boolean
  handleShareAgainAttachment: (
    att: EphemeralAttachmentMeta,
    isOwn: boolean,
    existingPath?: string | null
  ) => void | Promise<void>
}): Exclude<MediaPreviewState, null> {
  const {
    type,
    url,
    attachmentId,
    fileName,
    msg,
    att,
    hasPath,
    serverSigningPubkey,
    identityUserId,
    profileAvatarDataUrl,
    getProfile,
    fallbackNameForUser,
    ownDisplayName,
    isSharedInServer,
    justSharedKeys,
    hasActiveUploadForAttachment,
    handleShareAgainAttachment,
  } = params

  const fromId = msg.from_user_id
  const isOwn = fromId === identityUserId
  const originDisplayName = isOwn
    ? ownDisplayName
    : getProfile(fromId)?.display_name?.trim() || fallbackNameForUser(fromId)
  const originAvatarDataUrl = isOwn
    ? profileAvatarDataUrl ?? null
    : getProfile(fromId)?.avatar_data_url ?? null

  const showShareInChat = attachmentShareInChatVisible({
    isOwn,
    hasPath: !!hasPath,
    deliveryStatus: msg.delivery_status,
    serverSigningPubkey,
    sha256: att.sha256,
    attachmentId: att.attachment_id,
    isSharedInServer,
    justSharedKeys,
    hasActiveUpload: hasActiveUploadForAttachment(att),
  })

  return {
    type,
    url,
    attachmentId,
    fileName,
    source: 'chat',
    originUserId: fromId,
    originSentAtIso: msg.sent_at,
    originDisplayName,
    originAvatarDataUrl,
    localPath: hasPath ?? null,
    sizeBytes: att.size_bytes,
    sha256: att.sha256,
    aspectW: att.aspect_ratio_w,
    aspectH: att.aspect_ratio_h,
    showShareInChat,
    onShareInChat: showShareInChat ? () => handleShareAgainAttachment(att, isOwn, hasPath) : undefined,
  }
}

/** Local audio file preview (Plexamp-style modal). Requires `hasPath` on disk. */
export function buildChatAudioPreviewState(params: {
  attachmentId?: string
  fileName?: string
  msg: EphemeralChatMessage
  att: EphemeralAttachmentMeta
  /** Absolute path to the audio file */
  hasPath: string
  musicCoverFullSourcePath?: string | null
  serverSigningPubkey: string
  identityUserId: string | undefined
  profileAvatarDataUrl: string | null | undefined
  getProfile: (userId: string) => { display_name?: string | null; avatar_data_url?: string | null } | null | undefined
  fallbackNameForUser: (userId: string) => string
  ownDisplayName: string
  isSharedInServer: (serverSigningPubkey: string, sha256: string) => boolean
  justSharedKeys: Set<string>
  hasActiveUploadForAttachment: (att: EphemeralAttachmentMeta) => boolean
  handleShareAgainAttachment: (
    att: EphemeralAttachmentMeta,
    isOwn: boolean,
    existingPath?: string | null
  ) => void | Promise<void>
}): Exclude<MediaPreviewState, null> {
  const {
    attachmentId,
    fileName,
    msg,
    att,
    hasPath,
    musicCoverFullSourcePath,
    serverSigningPubkey,
    identityUserId,
    profileAvatarDataUrl,
    getProfile,
    fallbackNameForUser,
    ownDisplayName,
    isSharedInServer,
    justSharedKeys,
    hasActiveUploadForAttachment,
    handleShareAgainAttachment,
  } = params

  const fromId = msg.from_user_id
  const isOwn = fromId === identityUserId
  const originDisplayName = isOwn
    ? ownDisplayName
    : getProfile(fromId)?.display_name?.trim() || fallbackNameForUser(fromId)
  const originAvatarDataUrl = isOwn
    ? profileAvatarDataUrl ?? null
    : getProfile(fromId)?.avatar_data_url ?? null

  const showShareInChat = attachmentShareInChatVisible({
    isOwn,
    hasPath: true,
    deliveryStatus: msg.delivery_status,
    serverSigningPubkey,
    sha256: att.sha256,
    attachmentId: att.attachment_id,
    isSharedInServer,
    justSharedKeys,
    hasActiveUpload: hasActiveUploadForAttachment(att),
  })

  return {
    type: 'audio',
    localPath: hasPath.trim(),
    musicCoverFullSourcePath:
      musicCoverFullSourcePath === null ? null : (musicCoverFullSourcePath ?? hasPath.trim()),
    attachmentId,
    fileName,
    source: 'chat',
    originUserId: fromId,
    originSentAtIso: msg.sent_at,
    originDisplayName,
    originAvatarDataUrl,
    sizeBytes: att.size_bytes,
    sha256: att.sha256,
    showShareInChat,
    onShareInChat: showShareInChat ? () => handleShareAgainAttachment(att, isOwn, hasPath) : undefined,
  }
}
