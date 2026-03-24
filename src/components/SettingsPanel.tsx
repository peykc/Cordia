import { useEffect, useState } from 'react'
import { User, Volume2, Info, Wifi, Database, FolderDown, Palette } from 'lucide-react'
import { AccountSettings } from '../pages/settings/AccountSettings'
import { AudioSettingsPage } from '../pages/settings/AudioSettings'
import { InfoExportSettings } from '../pages/settings/InfoExportSettings'
import { ConnectionSettings } from '../pages/settings/ConnectionSettings'
import { MessagesSettings } from '../pages/settings/MessagesSettings'
import { DownloadsSettings } from '../pages/settings/DownloadsSettings'
import { CustomizeSettings } from '../pages/settings/CustomizeSettings'
import type { SettingsTab } from '../contexts/SettingsModalContext'

type Props = {
  initialTab?: SettingsTab
}

export function SettingsPanel({ initialTab = 'account' }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  const pages: { id: SettingsTab; label: string; icon: typeof User }[] = [
    { id: 'account', label: 'Account', icon: User },
    { id: 'audio', label: 'Audio', icon: Volume2 },
    { id: 'connections', label: 'Connections', icon: Wifi },
    { id: 'messages', label: 'Messages', icon: Database },
    { id: 'downloads', label: 'Downloads', icon: FolderDown },
    { id: 'customize', label: 'Customize', icon: Palette },
    { id: 'info', label: 'Info & Export', icon: Info },
  ]

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="w-full flex gap-8 py-8">
        <aside className="w-48 flex-shrink-0 pl-6">
          <nav className="sticky top-6 space-y-1">
            {pages.map((page) => {
              const Icon = page.icon
              const isActive = activeTab === page.id
              return (
                <button
                  key={page.id}
                  onClick={() => setActiveTab(page.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-light transition-all duration-200 relative group ${
                    isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <div
                    className={`absolute left-0 top-0 bottom-0 w-0.5 bg-foreground transition-all duration-300 ease-out ${
                      isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
                    }`}
                    style={{
                      transform: isActive ? 'scaleY(1)' : 'scaleY(0)',
                      transformOrigin: 'center',
                    }}
                  />
                  <Icon className={`h-4 w-4 transition-transform duration-200 ${isActive ? 'scale-110' : ''}`} />
                  <span>{page.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        <div className="flex-1 min-w-0 pr-6">
          <div className="max-w-3xl">
            <div key={activeTab} className="animate-fade-in">
              {activeTab === 'account' && <AccountSettings />}
              {activeTab === 'audio' && <AudioSettingsPage />}
              {activeTab === 'connections' && <ConnectionSettings />}
              {activeTab === 'messages' && <MessagesSettings />}
              {activeTab === 'downloads' && <DownloadsSettings />}
              {activeTab === 'customize' && <CustomizeSettings />}
              {activeTab === 'info' && <InfoExportSettings />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
