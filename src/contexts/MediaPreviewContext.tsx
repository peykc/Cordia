import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export type MediaPreviewSource = 'chat' | 'transfers'

/** One audio file in a multi-attachment chat message (skip prev/next in audio modal). */
export type ChatAudioGalleryItem = {
  attachmentId: string
  localPath: string
  /** List-style cover for carousel thumb (prep path or embedded data URL); null → music icon. */
  thumbnailUrl?: string | null
  fileName?: string
  sizeBytes?: number
  sha256?: string
  musicCoverFullSourcePath?: string | null
  showShareInChat?: boolean
  onShareInChat?: () => void | Promise<void>
}

/** One slot in a multi-attachment chat message gallery (images/videos only). */
export type ChatMediaGalleryItem = {
  type: 'image' | 'video'
  attachmentId: string
  url: string | null
  fileName?: string
  localPath?: string | null
  sizeBytes?: number
  sha256?: string
  aspectW?: number
  aspectH?: number
  /** Thumbnail for carousel; null shows a placeholder. */
  thumbnailUrl: string | null
  musicCoverFullSourcePath?: string | null
  showShareInChat?: boolean
  onShareInChat?: () => void | Promise<void>
}

type MediaPreviewCommon = {
  attachmentId?: string
  fileName?: string
  /** Where the preview was opened (hides share-in-chat in transfers). */
  source: MediaPreviewSource
  /** User who originally shared the attachment in chat, or uploader for transfers / you for seeding. */
  originUserId: string
  /** ISO timestamp: message sent_at when known, else transfer/registration fallback. */
  originSentAtIso: string
  originDisplayName?: string
  originAvatarDataUrl?: string | null
  /** Full path to open containing folder (file or dir). */
  localPath?: string | null
  sizeBytes?: number
  sha256?: string
  showShareInChat?: boolean
  /** Set when source === 'chat' && showShareInChat; runs share/reseed for current server. */
  onShareInChat?: () => void | Promise<void>
}

export type MediaPreviewState =
  | ({
      type: 'image' | 'video'
      url: string | null
      /**
       * Transfers: open embedded album art from this audio file at full resolution in the image viewer
       * (`thumbs/{id}_music_full.jpg`), not the list preview (`url`).
       */
      musicCoverFullSourcePath?: string | null
      aspectW?: number
      aspectH?: number
      /** Chat-only: 2+ media attachments in one message — prev/next + thumbnail strip. */
      chatMediaGallery?: {
        items: ChatMediaGalleryItem[]
        startIndex: number
      }
    } & MediaPreviewCommon)
  | ({
      type: 'audio'
      /** Absolute path to the audio file on disk (playback + optional cover extraction). */
      localPath: string
      /**
       * When set, full-res embedded cover is extracted from this path (same as transfers image flow).
       * When absent, the modal shows the music icon as art.
       */
      musicCoverFullSourcePath?: string | null
      /** Chat-only: 2+ audio attachments in one message — skip prev/next beside play (Plexamp-style). */
      chatAudioGallery?: {
        items: ChatAudioGalleryItem[]
        startIndex: number
      }
    } & MediaPreviewCommon)
  | null

type MediaPreviewContextType = {
  mediaPreview: MediaPreviewState
  setMediaPreview: (value: MediaPreviewState) => void
}

const MediaPreviewContext = createContext<MediaPreviewContextType | null>(null)

export function MediaPreviewProvider({ children }: { children: ReactNode }) {
  const [mediaPreview, setMediaPreview] = useState<MediaPreviewState>(null)

  const value = useMemo(
    () => ({ mediaPreview, setMediaPreview }),
    [mediaPreview]
  )

  return (
    <MediaPreviewContext.Provider value={value}>
      {children}
    </MediaPreviewContext.Provider>
  )
}

export function useMediaPreview() {
  const ctx = useContext(MediaPreviewContext)
  if (!ctx) throw new Error('useMediaPreview must be used within MediaPreviewProvider')
  return ctx
}
