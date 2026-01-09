import { Key } from 'lucide-react'
import { useIdentity } from '../../contexts/IdentityContext'

export function AccountSettings() {
  const { identity } = useIdentity()

  return (
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 p-8 space-y-6">
      <div className="space-y-1">
        <div className="w-12 h-px bg-foreground/20"></div>
        <h2 className="text-lg font-light tracking-tight">Account</h2>
        <p className="text-xs text-muted-foreground font-light">Your identity information</p>
      </div>
      <div className="space-y-6 pt-4">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Display Name</p>
          <p className="text-sm font-light">{identity?.display_name || 'Unknown'}</p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">User ID</p>
          <p className="text-xs font-mono text-muted-foreground break-all font-light">
            {identity?.user_id || 'Unknown'}
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Key className="h-3 w-3" />
            Public Key
          </p>
          <p className="text-xs font-mono text-muted-foreground break-all font-light">
            {identity?.public_key || 'Unknown'}
          </p>
        </div>
      </div>
    </div>
  )
}




