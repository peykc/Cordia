import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export type MediaPreviewState = {
  type: 'image' | 'video'
  url: string | null
  attachmentId?: string
  fileName?: string
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
