import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { MediaPreviewSession, MediaPreviewState } from '../domain/media/types'

export type {
  ChatAudioGalleryItem,
  ChatMediaGalleryItem,
  MediaPreviewSession,
  MediaPreviewSource,
  MediaPreviewState,
} from '../domain/media/types'

type MediaPreviewContextType = {
  mediaPreview: MediaPreviewState
  setMediaPreview: (value: MediaPreviewState) => void
  mediaPreviewSession: MediaPreviewSession | null
  setMediaPreviewSession: (value: MediaPreviewSession | null) => void
}

const MediaPreviewContext = createContext<MediaPreviewContextType | null>(null)

export function MediaPreviewProvider({ children }: { children: ReactNode }) {
  const [mediaPreview, setMediaPreview] = useState<MediaPreviewState>(null)
  const [mediaPreviewSession, setMediaPreviewSession] = useState<MediaPreviewSession | null>(null)

  const value = useMemo(
    () => ({ mediaPreview, setMediaPreview, mediaPreviewSession, setMediaPreviewSession }),
    [mediaPreview, mediaPreviewSession]
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
