import { createContext, useContext, useState, useCallback, useMemo, type ReactNode, useEffect } from 'react'

type SpeakingState = Record<string, boolean> // userId -> isSpeaking

interface SpeakingContextType {
  isUserSpeaking: (userId: string) => boolean
  setUserSpeaking: (userId: string, isSpeaking: boolean) => void
}

const SpeakingContext = createContext<SpeakingContextType | null>(null)

export function SpeakingProvider({ children }: { children: ReactNode }) {
  const [speakingState, setSpeakingState] = useState<SpeakingState>({})

  const setUserSpeaking = useCallback((userId: string, isSpeaking: boolean) => {
    setSpeakingState((prev) => {
      if (prev[userId] === isSpeaking) return prev
      return { ...prev, [userId]: isSpeaking }
    })
  }, [])

  const isUserSpeaking = useCallback((userId: string) => {
    return speakingState[userId] === true
  }, [speakingState])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      setSpeakingState({})
    }
  }, [])

  const value = useMemo(
    () => ({ isUserSpeaking, setUserSpeaking }),
    [isUserSpeaking, setUserSpeaking]
  )

  return <SpeakingContext.Provider value={value}>{children}</SpeakingContext.Provider>
}

export function useSpeaking() {
  const ctx = useContext(SpeakingContext)
  if (!ctx) throw new Error('useSpeaking must be used within a SpeakingProvider')
  return ctx
}
