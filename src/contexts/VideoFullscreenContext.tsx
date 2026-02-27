import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type VideoFullscreenContextType = {
  isNativeVideoFullscreen: boolean
  /** When entering fullscreen (value true), pass getScrollTarget so we can scroll that element back into view on exit. */
  setNativeVideoFullscreen: (value: boolean, getScrollTarget?: () => HTMLElement | null) => void
}

const VideoFullscreenContext = createContext<VideoFullscreenContextType | null>(null)

export function VideoFullscreenProvider({ children }: { children: ReactNode }) {
  const [isNativeVideoFullscreen, setNativeVideoFullscreenState] = useState(false)
  const scrollTargetRef = useRef<(() => HTMLElement | null) | null>(null)

  const setNativeVideoFullscreen = useCallback((value: boolean, getScrollTarget?: () => HTMLElement | null) => {
    if (value) {
      scrollTargetRef.current = getScrollTarget ?? null
      setNativeVideoFullscreenState(true)
    } else {
      const el = scrollTargetRef.current?.() ?? null
      scrollTargetRef.current = null
      setNativeVideoFullscreenState(false)
      if (el) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.scrollIntoView({ block: 'center', behavior: 'auto' })
          })
        })
      }
    }
  }, [])

  const value = useMemo(
    () => ({ isNativeVideoFullscreen, setNativeVideoFullscreen }),
    [isNativeVideoFullscreen, setNativeVideoFullscreen]
  )

  return (
    <VideoFullscreenContext.Provider value={value}>
      {children}
    </VideoFullscreenContext.Provider>
  )
}

export function useVideoFullscreen() {
  const ctx = useContext(VideoFullscreenContext)
  if (!ctx) throw new Error('useVideoFullscreen must be used within VideoFullscreenProvider')
  return ctx
}
