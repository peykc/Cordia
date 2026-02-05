import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAccount } from './AccountContext'
import { loadKnownProfiles, saveKnownProfiles, type KnownProfile } from '../lib/tauri'

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
  /** True after first loadKnownProfiles() has completed for current account; use to avoid showing "Unknown" before cache is ready */
  hydrated: boolean
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

const PERSIST_DEBOUNCE_MS = 2000

function knownToRemote(userId: string, k: KnownProfile): RemoteProfile {
  return {
    user_id: userId,
    display_name: k.display_name ?? '',
    secondary_name: k.secondary_name ?? null,
    show_secondary: Boolean(k.show_secondary),
    rev: Number(k.rev) || 0,
    account_created_at: k.account_created_at ?? null,
    avatar_data_url: null,
    avatar_rev: 0,
  }
}

function remoteToKnown(p: RemoteProfile): KnownProfile {
  return {
    display_name: p.display_name,
    secondary_name: p.secondary_name,
    show_secondary: p.show_secondary,
    rev: p.rev,
    account_created_at: p.account_created_at,
  }
}

export function RemoteProfilesProvider({ children }: { children: ReactNode }) {
  const { currentAccountId } = useAccount()
  const [profiles, setProfiles] = useState<Map<string, RemoteProfile>>(new Map())
  const [hydrated, setHydrated] = useState(false)
  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hydrate from persisted known_profiles on load / account switch so we never show "Unknown"
  useEffect(() => {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'RemoteProfilesContext.tsx:hydrate-effect',message:'hydrate effect run',data:{currentAccountId:currentAccountId ?? null},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
    if (!currentAccountId) {
      setProfiles(new Map())
      setHydrated(false)
      return
    }
    setHydrated(false)
    setProfiles(new Map()) // clear first so we don't show previous account's names
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'RemoteProfilesContext.tsx:after-clear',message:'cleared profiles before load',data:{currentAccountId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2'})}).catch(()=>{});
    fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'RemoteProfilesContext.tsx:before-load',message:'calling loadKnownProfiles',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    let cancelled = false
    loadKnownProfiles()
      .then((map) => {
        if (cancelled) return
        const next = new Map<string, RemoteProfile>()
        for (const [userId, k] of Object.entries(map)) {
          if (userId && k?.display_name != null) {
            next.set(userId, knownToRemote(userId, k))
          }
        }
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/b16fc0de-d4e0-4279-949b-a8e0e5fd58a5',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'RemoteProfilesContext.tsx:load-resolved',message:'loadKnownProfiles resolved',data:{count:Object.keys(map).length,nextSize:next.size},timestamp:Date.now(),sessionId:'debug-session',runId:'post-fix',hypothesisId:'H1'})}).catch(()=>{});
        // #endregion
        setProfiles(next)
        setHydrated(true)
      })
      .catch(() => {
        if (!cancelled) setHydrated(true)
      })
    return () => {
      cancelled = true
    }
  }, [currentAccountId])

  // Persist known_profiles (no avatar) when profiles change, debounced
  useEffect(() => {
    if (!currentAccountId || profiles.size === 0) return
    if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current)
    persistTimeoutRef.current = setTimeout(() => {
      persistTimeoutRef.current = null
      const toSave: Record<string, KnownProfile> = {}
      profiles.forEach((p, userId) => {
        if (p.display_name) toSave[userId] = remoteToKnown(p)
      })
      if (Object.keys(toSave).length > 0) {
        saveKnownProfiles(toSave).catch(() => {})
      }
    }, PERSIST_DEBOUNCE_MS)
    return () => {
      if (persistTimeoutRef.current) {
        clearTimeout(persistTimeoutRef.current)
        persistTimeoutRef.current = null
      }
    }
  }, [currentAccountId, profiles])

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
      hydrated,
      applyUpdate,
      getProfile: (userId) => profiles.get(userId),
    }
  }, [profiles, hydrated])

  return <RemoteProfilesContext.Provider value={value}>{children}</RemoteProfilesContext.Provider>
}

export function useRemoteProfiles() {
  const ctx = useContext(RemoteProfilesContext)
  if (!ctx) throw new Error('useRemoteProfiles must be used within a RemoteProfilesProvider')
  return ctx
}

