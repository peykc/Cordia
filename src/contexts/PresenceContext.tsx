import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export type PresenceLevel = 'active' | 'online' | 'offline' | 'in_call'

export interface PresenceUserStatus {
  user_id: string
  active_signing_pubkey?: string | null
}

type PresenceByHouse = Record<string, Record<string, { active_signing_pubkey?: string | null }>>

interface PresenceContextType {
  applySnapshot: (signingPubkey: string, users: PresenceUserStatus[]) => void
  applyUpdate: (
    signingPubkey: string,
    userId: string,
    online: boolean,
    activeSigningPubkey?: string | null
  ) => void
  getLevel: (signingPubkey: string, userId: string, isInCall?: boolean) => PresenceLevel
}

const PresenceContext = createContext<PresenceContextType | null>(null)

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [byHouse, setByHouse] = useState<PresenceByHouse>({})

  const applySnapshot: PresenceContextType['applySnapshot'] = (signingPubkey, users) => {
    setByHouse((prev) => {
      const nextForHouse: Record<string, { active_signing_pubkey?: string | null }> = {}
      for (const u of users) {
        nextForHouse[u.user_id] = { active_signing_pubkey: u.active_signing_pubkey ?? null }
      }
      return { ...prev, [signingPubkey]: nextForHouse }
    })
  }

  const applyUpdate: PresenceContextType['applyUpdate'] = (signingPubkey, userId, online, activeSigningPubkey) => {
    setByHouse((prev) => {
      const house = prev[signingPubkey] || {}
      if (!online) {
        if (!house[userId]) return prev
        const { [userId]: _, ...rest } = house
        return { ...prev, [signingPubkey]: rest }
      }
      return {
        ...prev,
        [signingPubkey]: {
          ...house,
          [userId]: { active_signing_pubkey: activeSigningPubkey ?? null },
        },
      }
    })
  }

  const getLevel: PresenceContextType['getLevel'] = (signingPubkey, userId, isInCall = false) => {
    const u = byHouse[signingPubkey]?.[userId]
    if (!u) return 'offline'
    // If user is in a call, show in_call status (blue)
    if (isInCall && u.active_signing_pubkey === signingPubkey) {
      return 'in_call'
    }
    return u.active_signing_pubkey === signingPubkey ? 'active' : 'online'
  }

  const value = useMemo(
    () => ({ applySnapshot, applyUpdate, getLevel }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byHouse]
  )

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>
}

export function usePresence() {
  const ctx = useContext(PresenceContext)
  if (!ctx) throw new Error('usePresence must be used within a PresenceProvider')
  return ctx
}

