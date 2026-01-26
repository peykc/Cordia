import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

const DEFAULT_WIDTH = 13 // 13em
const MIN_WIDTH = 10 // 10em (3em thinner)
const MAX_WIDTH = 16 // 16em (3em thicker)
const STORAGE_KEY = 'roommate:sidebar-width'

type SidebarWidthContextType = {
  width: number // in em
  setWidth: (width: number) => void
  resetWidth: () => void
}

const SidebarWidthContext = createContext<SidebarWidthContextType | null>(null)

export function SidebarWidthProvider({ children }: { children: ReactNode }) {
  const [width, setWidthState] = useState<number>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = parseFloat(stored)
      if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
        return parsed
      }
    }
    return DEFAULT_WIDTH
  })

  const setWidth = useCallback((newWidth: number) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth))
    setWidthState(clamped)
    localStorage.setItem(STORAGE_KEY, clamped.toString())
  }, [])

  const resetWidth = useCallback(() => {
    setWidthState(DEFAULT_WIDTH)
    localStorage.setItem(STORAGE_KEY, DEFAULT_WIDTH.toString())
  }, [])

  return (
    <SidebarWidthContext.Provider value={{ width, setWidth, resetWidth }}>
      {children}
    </SidebarWidthContext.Provider>
  )
}

export function useSidebarWidth() {
  const ctx = useContext(SidebarWidthContext)
  if (!ctx) throw new Error('useSidebarWidth must be used within SidebarWidthProvider')
  return ctx
}
