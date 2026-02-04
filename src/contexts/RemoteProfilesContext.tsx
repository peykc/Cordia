import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount } from './AccountContext'

export type RemoteProfile = {
  user_id: string
  display_name: string
  secondary_name: string | null
  show_secondary: boolean
  rev: number
  account_created_at: string | null
  /** From ProfilePush (signaling as messenger only; server does not store) */
  avatar_data_url: string | null
  avatar_rev: number
}

type RemoteProfilesContextType = {
  profiles: Map<string, RemoteProfile>
  applyUpdate: (u: {
    user_id: string
    display_name: string
    secondary_name: string | null
    show_secondary: boolean
    rev: number
    account_created_at?: string | null
    avatar_data_url?: string | null
    avatar_rev?: number
  }) => void
  getProfile: (userId: string) => RemoteProfile | undefined
}

const RemoteProfilesContext = createContext<RemoteProfilesContextType | null>(null)

export function RemoteProfilesProvider({ children }: { children: ReactNode }) {
  const { currentAccountId } = useAccount()
  const [profiles, setProfiles] = useState<Map<string, RemoteProfile>>(new Map())

  // Reset on account switch/logout (keeps data scoped to the current session)
  useEffect(() => {
    setProfiles(new Map())
  }, [currentAccountId])

  const applyUpdate: RemoteProfilesContextType['applyUpdate'] = (u) => {
    setProfiles((prev) => {
      const next = new Map(prev)
      const existing = next.get(u.user_id)
      const revNewer = !existing || u.rev >= existing.rev
      const avatarRevNewer =
        u.avatar_rev !== undefined &&
        (existing?.avatar_rev == null || u.avatar_rev >= existing.avatar_rev)
      const merged = {
        user_id: u.user_id,
        display_name: revNewer ? u.display_name : (existing?.display_name ?? u.display_name),
        secondary_name: revNewer ? (u.secondary_name ?? null) : (existing?.secondary_name ?? null),
        show_secondary: revNewer ? Boolean(u.show_secondary) : (existing?.show_secondary ?? false),
        rev: revNewer ? u.rev : (existing?.rev ?? 0),
        account_created_at: u.account_created_at !== undefined ? (u.account_created_at ?? null) : (existing?.account_created_at ?? null),
        avatar_data_url: avatarRevNewer && u.avatar_data_url !== undefined ? (u.avatar_data_url ?? null) : (existing?.avatar_data_url ?? null),
        avatar_rev: avatarRevNewer && u.avatar_rev !== undefined ? u.avatar_rev : (existing?.avatar_rev ?? 0),
      }
      next.set(u.user_id, merged)
      return next
    })
  }

  const value = useMemo<RemoteProfilesContextType>(() => {
    return {
      profiles,
      applyUpdate,
      getProfile: (userId) => profiles.get(userId),
    }
  }, [profiles])

  return <RemoteProfilesContext.Provider value={value}>{children}</RemoteProfilesContext.Provider>
}

export function useRemoteProfiles() {
  const ctx = useContext(RemoteProfilesContext)
  if (!ctx) throw new Error('useRemoteProfiles must be used within a RemoteProfilesProvider')
  return ctx
}

