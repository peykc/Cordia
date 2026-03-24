import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type SettingsTab = 'account' | 'audio' | 'connections' | 'messages' | 'downloads' | 'info' | 'customize'

type SettingsModalContextType = {
  isOpen: boolean
  initialTab: SettingsTab
  openNonce: number
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
}

const SettingsModalContext = createContext<SettingsModalContextType | null>(null)

export function SettingsModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [initialTab, setInitialTab] = useState<SettingsTab>('account')
  const [openNonce, setOpenNonce] = useState(0)

  const openSettings = useCallback((tab: SettingsTab = 'account') => {
    setInitialTab(tab)
    setOpenNonce((n) => n + 1)
    setIsOpen(true)
  }, [])

  const closeSettings = useCallback(() => {
    setIsOpen(false)
  }, [])

  const value = useMemo(
    () => ({ isOpen, initialTab, openNonce, openSettings, closeSettings }),
    [isOpen, initialTab, openNonce, openSettings, closeSettings]
  )

  return <SettingsModalContext.Provider value={value}>{children}</SettingsModalContext.Provider>
}

export function useSettingsModal() {
  const ctx = useContext(SettingsModalContext)
  if (!ctx) throw new Error('useSettingsModal must be used within SettingsModalProvider')
  return ctx
}
