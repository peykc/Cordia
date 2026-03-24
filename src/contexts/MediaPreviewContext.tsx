import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export type MediaPreviewSource = 'chat' | 'transfers'

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
  showShareInChat?: boolean
  onShareInChat?: () => void | Promise<void>
}

export type MediaPreviewState = {
  type: 'image' | 'video'
  url: string | null
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
  aspectW?: number
  aspectH?: number
  showShareInChat?: boolean
  /** Set when source === 'chat' && showShareInChat; runs share/reseed for current server. */
  onShareInChat?: () => void | Promise<void>
  /** Chat-only: 2+ media attachments in one message — prev/next + thumbnail strip. */
  chatMediaGallery?: {
    items: ChatMediaGalleryItem[]
    startIndex: number
  }
} | null

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
