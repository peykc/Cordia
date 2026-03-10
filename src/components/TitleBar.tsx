import { Minus, Square, X } from 'lucide-react'
import { useCallback } from 'react'
import { getCurrent } from '@tauri-apps/api/window'
import { useVideoFullscreen } from '../contexts/VideoFullscreenContext'

function TitleBar() {
  const { isNativeVideoFullscreen } = useVideoFullscreen()

  const handleMinimize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    getCurrent().minimize()
  }, [])

  const handleMaximize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    getCurrent().toggleMaximize()
  }, [])

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    getCurrent().close()
  }, [])

  if (isNativeVideoFullscreen) return null

  return (
    <div className="h-8 bg-background flex items-center select-none flex-shrink-0 relative z-[9998]">
      {/* Draggable area - entire left side */}
      <div
        data-tauri-drag-region
        className="flex-1 h-full"
      />

      {/* Window controls - fixed to right, ensure above overlays */}
      <div
        className="flex items-center pointer-events-auto"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          title="Minimize"
          className="h-8 w-10 flex items-center justify-center hover:bg-accent/50 transition-colors group"
          onClick={handleMinimize}
        >
          <Minus className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
        </button>
        <button
          type="button"
          title="Maximize"
          className="h-8 w-10 flex items-center justify-center hover:bg-accent/50 transition-colors group"
          onClick={handleMaximize}
        >
          <Square className="h-3 w-3 text-muted-foreground group-hover:text-foreground" />
        </button>
        <button
          type="button"
          title="Close"
          className="h-8 w-10 flex items-center justify-center hover:bg-destructive/20 transition-colors group"
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground group-hover:text-destructive" />
        </button>
      </div>
    </div>
  )
}

export default TitleBar

