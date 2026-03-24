import { Minus, Square, X } from 'lucide-react'
import React, { useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { getCurrent } from '@tauri-apps/api/window'
import { useVideoFullscreen } from '../contexts/VideoFullscreenContext'
import { useServers } from '../contexts/ServersContext'

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

/** TitleBar renders outside `<Routes>`, so `useParams()` is empty — parse `/home/:id` from the pathname. */
function homeServerIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/home/')) return null
  const rest = pathname.slice('/home/'.length)
  const seg = rest.split('/').filter(Boolean)[0]
  return seg ? decodeURIComponent(seg) : null
}

function useTitleBarPageTitle(): string {
  const location = useLocation()
  const { getServerById } = useServers()

  return useMemo(() => {
    const p = location.pathname
    if (p === '/' || p === '') return 'Cordia'
    if (p === '/home') return 'HOME'
    const serverId = homeServerIdFromPath(p)
    if (serverId) {
      const s = getServerById(serverId)
      return s?.name?.trim() || 'Server'
    }
    if (p === '/settings') return 'Settings'
    if (p === '/transfers') return 'Transfers'
    if (p === '/account/select') return 'Accounts'
    if (p === '/account/setup') return 'Setup'
    if (p === '/account/restore') return 'Restore'
    return 'Cordia'
  }, [location.pathname, getServerById])
}

/**
 * No in-bar back/forward: browser history + SPA routers don’t expose a trustworthy forward stack,
 * and mirroring keys drifts (replaces, redirects, WebView quirks). Center title + window controls only.
 */
function TitleBar() {
  const { isNativeVideoFullscreen } = useVideoFullscreen()
  const pageTitle = useTitleBarPageTitle()

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
    <div className="relative z-[9998] flex h-8 shrink-0 select-none items-stretch bg-background">
      <div
        className="flex min-w-0 flex-1 items-center justify-center px-3"
        data-tauri-drag-region
      >
        <span
          className="truncate text-center text-xs font-medium tracking-widest text-muted-foreground"
          title={pageTitle}
        >
          {pageTitle}
        </span>
      </div>

      <div className="pointer-events-auto flex shrink-0 items-stretch" style={noDrag}>
        <button
          type="button"
          title="Minimize"
          className="group flex h-8 w-10 items-center justify-center transition-colors hover:bg-white/10"
          onClick={handleMinimize}
        >
          <Minus className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
        </button>
        <button
          type="button"
          title="Maximize"
          className="group flex h-8 w-10 items-center justify-center transition-colors hover:bg-white/10"
          onClick={handleMaximize}
        >
          <Square className="h-3 w-3 text-muted-foreground group-hover:text-foreground" />
        </button>
        <button
          type="button"
          title="Close"
          className="group flex h-8 w-10 items-center justify-center transition-colors hover:bg-destructive/20"
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground group-hover:text-destructive" />
        </button>
      </div>
    </div>
  )
}

export default TitleBar
