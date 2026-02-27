import { Minus, Square, X } from 'lucide-react'
import { useEffect } from 'react'
import { getCurrent } from '@tauri-apps/api/window'
import { Tooltip } from './Tooltip'
import { useVideoFullscreen } from '../contexts/VideoFullscreenContext'

function TitleBar() {
  const { isNativeVideoFullscreen } = useVideoFullscreen()

  useEffect(() => {
    const appWindow = getCurrent()
    
    const minimizeBtn = document.getElementById('titlebar-minimize')
    const maximizeBtn = document.getElementById('titlebar-maximize')
    const closeBtn = document.getElementById('titlebar-close')

    const handleMinimize = async () => {
      await appWindow.minimize()
    }

    const handleMaximize = async () => {
      await appWindow.toggleMaximize()
    }

    const handleClose = async () => {
      await appWindow.close()
    }

    minimizeBtn?.addEventListener('click', handleMinimize)
    maximizeBtn?.addEventListener('click', handleMaximize)
    closeBtn?.addEventListener('click', handleClose)

    return () => {
      minimizeBtn?.removeEventListener('click', handleMinimize)
      maximizeBtn?.removeEventListener('click', handleMaximize)
      closeBtn?.removeEventListener('click', handleClose)
    }
  }, [])

  if (isNativeVideoFullscreen) return null

  return (
    <div className="h-8 bg-background flex items-center select-none flex-shrink-0 relative z-[210]">
      {/* Draggable area - entire left side */}
      <div
        data-tauri-drag-region
        className="flex-1 h-full"
      />

      {/* Window controls - fixed to right */}
      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <Tooltip content="Minimize" side="bottom">
          <button
            id="titlebar-minimize"
            className="h-8 w-10 flex items-center justify-center hover:bg-accent/50 transition-colors group"
          >
            <Minus className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
          </button>
        </Tooltip>
        <Tooltip content="Maximize" side="bottom">
          <button
            id="titlebar-maximize"
            className="h-8 w-10 flex items-center justify-center hover:bg-accent/50 transition-colors group"
          >
            <Square className="h-3 w-3 text-muted-foreground group-hover:text-foreground" />
          </button>
        </Tooltip>
        <Tooltip content="Close" side="bottom">
          <button
            id="titlebar-close"
            className="h-8 w-10 flex items-center justify-center hover:bg-destructive/20 transition-colors group"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground group-hover:text-destructive" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

export default TitleBar

