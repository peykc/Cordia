import { useEffect } from 'react'
import { X } from 'lucide-react'
import { Button } from './ui/button'
import { useWindowSize } from '../lib/useWindowSize'
import { useSettingsModal } from '../contexts/SettingsModalContext'
import { SettingsPanel } from './SettingsPanel'

export function SettingsModal() {
  const { isOpen, initialTab, openNonce, closeSettings } = useSettingsModal()
  const { width } = useWindowSize()
  const isFullscreen = width < 540

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, closeSettings])

  if (!isOpen) return null

  return (
    <div className="absolute top-8 left-0 right-0 bottom-0 z-[60]">
      <div className="absolute inset-0 bg-background/75 backdrop-blur-sm" onMouseDown={closeSettings} />

      <div
        className={`absolute border-2 border-border bg-card/95 backdrop-blur-md shadow-2xl flex flex-col overflow-hidden ${
          isFullscreen
            ? 'inset-0 rounded-none'
            : 'left-1/2 top-1/2 w-[min(880px,calc(100vw-3rem))] h-[min(640px,calc(100vh-8rem))] max-h-[calc(100%-1rem)] -translate-x-1/2 -translate-y-1/2 rounded-none'
        }`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="h-14 shrink-0 border-b-2 border-border px-4 flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 mr-2"
            title="Close settings"
            onClick={closeSettings}
          >
            <X className="h-4 w-4" />
          </Button>
          <div className="w-px h-6 bg-foreground/20 mr-3" />
          <h1 className="text-sm font-light tracking-wider uppercase">Settings</h1>
        </header>

        <div className="flex-1 min-h-0">
          <SettingsPanel key={`${openNonce}-${initialTab}`} initialTab={initialTab} />
        </div>
      </div>
    </div>
  )
}
