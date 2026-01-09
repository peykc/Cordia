import { Link } from 'react-router-dom'
import { useState } from 'react'
import { ArrowLeft, User, Volume2, Info } from 'lucide-react'
import { Button } from '../components/ui/button'
import { AccountSettings } from './settings/AccountSettings'
import { AudioSettingsPage } from './settings/AudioSettings'
import { InfoExportSettings } from './settings/InfoExportSettings'

type SettingsPage = 'account' | 'audio' | 'info'

function SettingsPage() {
  const [activePage, setActivePage] = useState<SettingsPage>('account')

  const pages: { id: SettingsPage; label: string; icon: typeof User }[] = [
    { id: 'account', label: 'Account', icon: User },
    { id: 'audio', label: 'Audio', icon: Volume2 },
    { id: 'info', label: 'Info & Export', icon: Info },
  ]

  return (
    <div className="h-full bg-background grid-pattern flex flex-col">
      <header className="border-b-2 border-border">
        <div className="container flex h-16 items-center gap-4 px-6">
          <Link to="/houses">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-4">
            <div className="w-px h-6 bg-foreground/20"></div>
            <h1 className="text-sm font-light tracking-wider uppercase">Settings</h1>
          </div>
        </div>
      </header>

      <main className="container flex-1 flex gap-8 p-8 py-12">
        {/* Table of Contents */}
        <aside className="w-48 flex-shrink-0">
          <nav className="sticky top-12 space-y-1">
            {pages.map((page) => {
              const Icon = page.icon
              const isActive = activePage === page.id
              return (
                <button
                  key={page.id}
                  onClick={() => setActivePage(page.id)}
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
        <div className="flex-1 min-w-0">
          <div className="max-w-3xl">
            <div key={activePage} className="animate-fade-in">
              {activePage === 'account' && <AccountSettings />}
              {activePage === 'audio' && <AudioSettingsPage />}
              {activePage === 'info' && <InfoExportSettings />}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

export default SettingsPage

