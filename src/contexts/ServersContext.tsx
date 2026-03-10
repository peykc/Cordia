import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { listServers, type Server } from '../lib/tauri'
import { useAccount } from './AccountContext'

interface ServersContextType {
  servers: Server[]
  refreshServers: () => Promise<void>
  getServerById: (serverId: string) => Server | undefined
}

const ServersContext = createContext<ServersContextType | null>(null)

export function ServersProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<Server[]>([])
  const { currentAccountId } = useAccount()

  const refreshServers = useCallback(async () => {
    try {
      const loadedServers = await listServers()
      setServers(loadedServers)
    } catch (error) {
      console.error('Failed to load servers:', error)
    }
  }, [])

  // Load servers on mount
  useEffect(() => {
    refreshServers()

    // Listen for server updates from other parts of the app
    const onServersUpdated = () => {
      refreshServers()
    }
    window.addEventListener('cordia:servers-updated', onServersUpdated)

    return () => {
      window.removeEventListener('cordia:servers-updated', onServersUpdated)
    }
  }, [refreshServers])

  // Apply preloaded servers from account switch so list appears instantly; then refresh in background for live updates
  useEffect(() => {
    const onServersInitial = (ev: Event) => {
      const detail = (ev as CustomEvent<{ servers: Server[]; accountId: string }>).detail
      if (detail?.servers && Array.isArray(detail.servers)) {
        setServers(detail.servers)
      }
    }
    window.addEventListener('cordia:servers-initial', onServersInitial)
    return () => window.removeEventListener('cordia:servers-initial', onServersInitial)
  }, [])

  // Refresh when account changes (live updates; local data already applied via servers-initial)
  useEffect(() => {
    if (currentAccountId) {
      refreshServers()
    }
  }, [currentAccountId, refreshServers])

  const getServerById = useCallback((serverId: string) => {
    return servers.find(s => s.id === serverId)
  }, [servers])

  const value = {
    servers,
    refreshServers,
    getServerById,
  }

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>
}

export function useServers() {
  const ctx = useContext(ServersContext)
  if (!ctx) throw new Error('useServers must be used within a ServersProvider')
  return ctx
}
