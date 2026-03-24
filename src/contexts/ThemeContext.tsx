import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { THEME_PRESETS, type Theme, type ThemeId } from '../theme/presets'

type ThemeContextValue = {
  themeId: ThemeId
  theme: Theme
  setThemeId: (id: ThemeId) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const THEME_STORAGE_KEY = 'cordia.themeId'

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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => getInitialThemeId())

  const theme = useMemo<Theme>(() => THEME_PRESETS[themeId] ?? THEME_PRESETS.default, [themeId])

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeId)
    } catch {
      // ignore persistence errors
    }
  }, [themeId])

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

  const setThemeId = (id: ThemeId) => {
    if (id === themeId) return
    setThemeIdState(id)
  }

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId,
      theme,
      setThemeId,
    }),
    [themeId, theme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

