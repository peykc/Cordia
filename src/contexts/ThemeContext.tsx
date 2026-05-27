import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { THEME_PRESETS, type Theme, type ThemeId } from '../theme/presets'

export type PerformanceProfile = 'quality' | 'balanced' | 'low-end'

type ThemeContextValue = {
  themeId: ThemeId
  theme: Theme
  setThemeId: (id: ThemeId) => void
  performanceProfile: PerformanceProfile
  setPerformanceProfile: (profile: PerformanceProfile) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const THEME_STORAGE_KEY = 'cordia.themeId'
const PERFORMANCE_PROFILE_STORAGE_KEY = 'cordia.performanceProfile'
const PERFORMANCE_PROFILES: PerformanceProfile[] = ['quality', 'balanced', 'low-end']

function getInitialThemeId(): ThemeId {
  if (typeof window === 'undefined') return 'default'
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null
    if (stored && stored in THEME_PRESETS) return stored
  } catch {
    // ignore
  }
  return 'default'
}

function getInitialPerformanceProfile(): PerformanceProfile {
  if (typeof window === 'undefined') return 'quality'
  try {
    const stored = window.localStorage.getItem(PERFORMANCE_PROFILE_STORAGE_KEY) as PerformanceProfile | null
    if (stored && PERFORMANCE_PROFILES.includes(stored)) return stored
  } catch {
    // ignore
  }
  return 'quality'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => getInitialThemeId())
  const [performanceProfile, setPerformanceProfileState] = useState<PerformanceProfile>(() => getInitialPerformanceProfile())

  const theme = useMemo<Theme>(() => THEME_PRESETS[themeId] ?? THEME_PRESETS.default, [themeId])

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeId)
    } catch {
      // ignore persistence errors
    }
  }, [themeId])

  useEffect(() => {
    try {
      window.localStorage.setItem(PERFORMANCE_PROFILE_STORAGE_KEY, performanceProfile)
    } catch {
      // ignore persistence errors
    }
  }, [performanceProfile])

  // Bridge to CSS variables used by Tailwind (via cordia-specific vars).
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const set = (name: string, value: string | undefined) => {
      if (!value) return
      root.style.setProperty(name, value)
    }
    set('--cordia-bg', theme.background)
    set('--cordia-card', theme.card)
    set('--cordia-sidebar', theme.sidebar)
    set('--cordia-friends-bg', theme.friendsList)
    set('--cordia-draft-bg', theme.messageDraft)
    set('--cordia-border', theme.border)
    set('--cordia-accent', theme.accent)
  }, [theme])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.performanceProfile = performanceProfile
  }, [performanceProfile])

  const setThemeId = (id: ThemeId) => {
    if (id === themeId) return
    setThemeIdState(id)
  }

  const setPerformanceProfile = (profile: PerformanceProfile) => {
    if (profile === performanceProfile) return
    setPerformanceProfileState(profile)
  }

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId,
      theme,
      setThemeId,
      performanceProfile,
      setPerformanceProfile,
    }),
    [themeId, theme, performanceProfile]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

