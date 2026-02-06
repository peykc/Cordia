import { Link, useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { ArrowLeft, User, Volume2, Info, Wifi } from 'lucide-react'
import { Button } from '../components/ui/button'
import { SignalingStatus } from '../components/SignalingStatus'
import { AccountSettings } from './settings/AccountSettings'
import { AudioSettingsPage } from './settings/AudioSettings'
import { InfoExportSettings } from './settings/InfoExportSettings'
import { ConnectionSettings } from './settings/ConnectionSettings'

type SettingsPage = 'account' | 'audio' | 'connections' | 'info'

function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [activePage, setActivePage] = useState<SettingsPage>('account')

  // Presence: Settings is "Neighborhood" (not active in a specific house)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('cordia:active-server-changed', { detail: { signing_pubkey: null } }))
  }, [])

  const pages: { id: SettingsPage; label: string; icon: typeof User }[] = [
    { id: 'account', label: 'Account', icon: User },
    { id: 'audio', label: 'Audio', icon: Volume2 },
    { id: 'connections', label: 'Connections', icon: Wifi },
    { id: 'info', label: 'Info & Export', icon: Info },
  ]

  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab === 'account' || tab === 'audio' || tab === 'connections' || tab === 'info') {
      setActivePage(tab)
    }
  }, [searchParams])

  const setTab = (tab: SettingsPage) => {
    setActivePage(tab)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', tab)
      return next
    }, { replace: true })
  }

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      <header className="border-b-2 border-border shrink-0">
        <div className="w-full flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <Link to="/home">
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div className="flex items-center gap-4">
              <div className="w-px h-6 bg-foreground/20"></div>
              <h1 className="text-sm font-light tracking-wider uppercase">Settings</h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <SignalingStatus />
          </div>
        </div>
      </header>

      {/* Scrollable content (keeps top bar fixed) */}
      <main className="flex-1 overflow-y-auto min-h-0">
        <div className="w-full flex gap-8 py-12">
          {/* Table of Contents */}
          <aside className="w-48 flex-shrink-0 pl-6">
            <nav className="sticky top-12 space-y-1">
              {pages.map((page) => {
                const Icon = page.icon
                const isActive = activePage === page.id
                return (
                  <button
                    key={page.id}
                    onClick={() => setTab(page.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-light transition-all duration-200 relative group ${
                      isActive 
                        ? 'text-foreground' 
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {/* Animated highlight bar */}
                    <div 
                      className={`absolute left-0 top-0 bottom-0 w-0.5 bg-foreground transition-all duration-300 ease-out ${
                        isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
                      }`}
                      style={{
                        transform: isActive ? 'scaleY(1)' : 'scaleY(0)',
                        transformOrigin: 'center',
                      }}
                    />
                    <Icon className={`h-4 w-4 transition-transform duration-200 ${
                      isActive ? 'scale-110' : ''
                    }`} />
                    <span>{page.label}</span>
                  </button>
                )
              })}
            </nav>
          </aside>

          {/* Content Area */}
          <div className="flex-1 min-w-0 pr-6">
            <div className="max-w-3xl">
              <div key={activePage} className="animate-fade-in">
                {activePage === 'account' && <AccountSettings />}
                {activePage === 'audio' && <AudioSettingsPage />}
                {activePage === 'connections' && <ConnectionSettings />}
                {activePage === 'info' && <InfoExportSettings />}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

export default SettingsPage

