import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { checkSignalingServer, getSignalingServerUrl } from '../lib/tauri'

export type SignalingStatus = 'connected' | 'disconnected' | 'checking'

interface SignalingContextType {
  status: SignalingStatus
  signalingUrl: string
  checkHealth: () => Promise<void>
}

const SignalingContext = createContext<SignalingContextType | null>(null)

export function SignalingProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SignalingStatus>('checking')
  const [signalingUrl, setSignalingUrl] = useState<string>('')

  const checkHealth = useCallback(async () => {
    setStatus('checking')
    try {
      const isHealthy = await checkSignalingServer(signalingUrl || undefined)
      setStatus(isHealthy ? 'connected' : 'disconnected')
    } catch (error) {
      console.error('Signaling health check failed:', error)
      setStatus('disconnected')
    }
  }, [signalingUrl])

  useEffect(() => {
    // Load saved signaling server URL
    getSignalingServerUrl().then(url => {
      setSignalingUrl(url)
    }).catch(error => {
      console.error('Failed to load signaling URL:', error)
    })
  }, [])

  useEffect(() => {
    if (!signalingUrl) return

    // Initial health check
    checkHealth()

    // Periodic health check every 30 seconds
    const interval = setInterval(checkHealth, 30000)

    return () => clearInterval(interval)
  }, [signalingUrl, checkHealth])

  return (
    <SignalingContext.Provider value={{ status, signalingUrl, checkHealth }}>
      {children}
    </SignalingContext.Provider>
  )
}

export function useSignaling() {
  const context = useContext(SignalingContext)
  if (!context) {
    throw new Error('useSignaling must be used within a SignalingProvider')
  }
  return context
}
