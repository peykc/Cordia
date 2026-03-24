import { useState } from 'react'
import { Download, Loader2, LogOut } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { useToast } from '../../contexts/ToastContext'
import { useAccount } from '../../contexts/AccountContext'
import { useProfile } from '../../contexts/ProfileContext'
import { useIdentity } from '../../contexts/IdentityContext'
import { exportFullIdentity, exportFullIdentityDebug } from '../../lib/tauri'

export function InfoExportSettings() {
  const { toast } = useToast()
  const { logout } = useAccount()
  const { profile } = useProfile()
  const { identity } = useIdentity()
  const [isExporting, setIsExporting] = useState(false)

  function handleLogout() {
    logout()
  }

  const sanitizeFilename = (name: string): string => {
    // Replace invalid filename chars with underscore
    return name.replace(/[/\\:*?"<>|]/g, '_')
  }

  async function handleExport() {
    setIsExporting(true)

    try {
      // Build profile JSON from context (exclude avatar - too large in base64)
      const profileJson = {
        display_name: profile.display_name,
        real_name: profile.real_name,
        show_real_name: profile.show_real_name,
      }

      const data = await exportFullIdentity(profileJson)
      
      // Generate filename: sanitized display_name or fallback to user_id
      let filename: string
      if (profile.display_name) {
        const sanitized = sanitizeFilename(profile.display_name)
        filename = sanitized || (identity?.user_id.slice(0, 16) ?? 'account')
      } else if (identity?.user_id) {
        filename = identity.user_id.slice(0, 16)
      } else {
        filename = 'account'
      }
      
      // DEBUG: Export as text file to inspect contents (includes houses)
      const debugJson = await exportFullIdentityDebug(profileJson)
      const debugBlob = new Blob([debugJson], { type: 'text/plain' })
      const debugUrl = URL.createObjectURL(debugBlob)
      const debugA = document.createElement('a')
      debugA.href = debugUrl
      debugA.download = `${filename}.txt`
      document.body.appendChild(debugA)
      debugA.click()
      document.body.removeChild(debugA)
      URL.revokeObjectURL(debugUrl)
      
      // Also export the binary .key file
      const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}.key`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to export account')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div className="space-y-8">
      <div className="bg-card/50 backdrop-blur-sm border border-border/50 space-y-6">
        <div className="space-y-1">
          <div className="inline-block">
          <h2 className="text-lg font-light tracking-tight">Backup & Export</h2>
            <div className="h-px bg-foreground/20 mt-1 w-full"></div>
          </div>
          <p className="text-xs text-muted-foreground font-light">Export your account for backup</p>
        </div>
        <div className="space-y-4">
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={isExporting}
            className="w-full h-11 font-light border-border/50 hover:bg-white/5"
          >
            {isExporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Export Account
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground font-light">
            Save this file in a secure location. You can import it on another device to restore your account.
          </p>
        </div>
      </div>

      <div className="bg-card/50 backdrop-blur-sm border border-border/50 space-y-6">
        <div className="space-y-1">
          <div className="inline-block">
          <h2 className="text-lg font-light tracking-tight">About</h2>
            <div className="h-px bg-foreground/20 mt-1 w-full"></div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground font-light">
          Cordia v1.0.0
        </p>
      </div>

      <div className="bg-card/50 backdrop-blur-sm border border-border/50 space-y-6">
        <Button
          variant="outline"
          className="w-full h-11 font-light border-destructive/50 text-destructive hover:bg-destructive/10"
          onClick={handleLogout}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Logout
        </Button>
        <p className="text-xs text-muted-foreground font-light">
          Clears your session and account from memory. You will need to select an account to log back in.
        </p>
      </div>
    </div>
  )
}




