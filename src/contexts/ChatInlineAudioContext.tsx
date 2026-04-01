import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react'

export type ChatInlineActiveTrack = {
  attachmentId: string
  audioSrc: string
}

type ChatInlineAudioContextValue = {
  activeTrack: ChatInlineActiveTrack | null
  sharedAudioRef: MutableRefObject<HTMLAudioElement | null>
  playTrack: (attachmentId: string, audioSrc: string) => void
  armTrack: (attachmentId: string, audioSrc: string) => void
  clearActive: () => void
}

export const ChatInlineAudioContext = createContext<ChatInlineAudioContextValue | null>(null)

export function useChatInlineAudio(): ChatInlineAudioContextValue | null {
  return useContext(ChatInlineAudioContext)
}

export function ChatInlineAudioProvider({
  children,
  resetKey,
}: {
  children: ReactNode
  resetKey?: string | null
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [activeTrack, setActiveTrack] = useState<ChatInlineActiveTrack | null>(null)
  /** Bumps so layout effect re-runs when play/arm is requested for the same URL as before. */
  const [transportEpoch, setTransportEpoch] = useState(0)
  const intendPlayRef = useRef(false)

  const playTrack = useCallback((attachmentId: string, audioSrc: string) => {
    intendPlayRef.current = true
    setActiveTrack({ attachmentId, audioSrc })
    setTransportEpoch((e) => e + 1)
  }, [])

  const armTrack = useCallback((attachmentId: string, audioSrc: string) => {
    intendPlayRef.current = false
    setActiveTrack({ attachmentId, audioSrc })
    setTransportEpoch((e) => e + 1)
  }, [])

  const clearActive = useCallback(() => {
    intendPlayRef.current = false
    setActiveTrack(null)
    setTransportEpoch((e) => e + 1)
  }, [])

  useLayoutEffect(() => {
    intendPlayRef.current = false
    setActiveTrack(null)
    setTransportEpoch((e) => e + 1)
  }, [resetKey])

  useLayoutEffect(() => {
    const el = audioRef.current
    if (!activeTrack) {
      if (el) {
        el.pause()
        el.removeAttribute('src')
      }
      return
    }
    if (!el) return
    if (el.src !== activeTrack.audioSrc) {
      el.src = activeTrack.audioSrc
    }
    if (intendPlayRef.current) {
      intendPlayRef.current = false
      void el.play().catch(() => {})
    } else {
      el.pause()
    }
  }, [activeTrack, transportEpoch])

  const value = useMemo(
    () => ({
      activeTrack,
      sharedAudioRef: audioRef,
      playTrack,
      armTrack,
      clearActive,
    }),
    [activeTrack, playTrack, armTrack, clearActive]
  )

  return (
    <ChatInlineAudioContext.Provider value={value}>
      <audio ref={audioRef} preload="auto" className="hidden" aria-hidden />
      {children}
    </ChatInlineAudioContext.Provider>
  )
}
