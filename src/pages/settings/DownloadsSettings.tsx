import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/api/dialog'
import { Button } from '../../components/ui/button'
import { useAccount } from '../../contexts/AccountContext'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  getDownloadSettings,
  setDownloadSettings,
  type DownloadSettings,
} from '../../lib/downloadSettings'

export function DownloadsSettings() {
  const { currentAccountId } = useAccount()
  const [settings, setSettings] = useState<DownloadSettings>(DEFAULT_DOWNLOAD_SETTINGS)

  useEffect(() => {
    setSettings(getDownloadSettings(currentAccountId))
  }, [currentAccountId])

  const apply = (next: DownloadSettings) => {
    setSettings(next)
    setDownloadSettings(currentAccountId, next)
  }

  const chooseFolder = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: 'Choose downloads folder',
    })
    if (!picked || Array.isArray(picked)) return
    apply({ ...settings, preferred_dir: picked })
  }

  return (
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-light tracking-tight">Downloads</h2>
        <p className="text-xs text-muted-foreground">
          Pick where received attachments are saved for this account on this device.
        </p>
      </div>

      <div className="border border-border/50 rounded-md p-3 space-y-3">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Save location</p>
          <p className="text-xs text-muted-foreground break-all">
            {settings.preferred_dir
              ? settings.preferred_dir
              : 'System Downloads folder (default)'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={chooseFolder}>
            Choose folder
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => apply({ ...settings, preferred_dir: null })}
          >
            Use system default
          </Button>
        </div>
        <div className="space-y-2 pt-1 border-t border-border/40">
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Group downloads by server</span>
            <input
              type="checkbox"
              checked={settings.group_by_server}
              onChange={(e) => apply({ ...settings, group_by_server: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Flat mode (legacy single folder)</span>
            <input
              type="checkbox"
              checked={settings.flat_mode}
              onChange={(e) => apply({ ...settings, flat_mode: e.target.checked })}
            />
          </label>
          <p className="text-[11px] text-muted-foreground">
            Grouped mode uses <code>Cordia/&lt;server&gt;/YYYY_MM</code> under your base folder.
          </p>
        </div>
      </div>
    </div>
  )
}

