import { memo } from 'react'
import { ArrowLeft } from 'lucide-react'
import { BeaconStatus } from '../BeaconStatus'
import { TransferCenterButton } from '../TransferCenterButton'
import { NotificationCenterButton } from '../NotificationCenterButton'
import { UserCard } from '../UserCard'

interface ServerHeaderProps {
  onBack: () => void
  onUserAvatarClick: (rect: DOMRect) => void
}

function ServerHeaderImpl({ onBack, onUserAvatarClick }: ServerHeaderProps) {
  return (
    <header className="h-14 border-b-2 border-border bg-background flex items-center justify-between px-4 shrink-0 transition-all duration-300 ease-in-out">
      <div className="flex items-center min-w-0 flex-1">
        <button
          type="button"
          title="Back to home"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <BeaconStatus />
        <TransferCenterButton />
        <NotificationCenterButton />
        <UserCard
          variant="header"
          onAvatarClick={onUserAvatarClick}
        />
      </div>
    </header>
  )
}

export const ServerHeader = memo(ServerHeaderImpl)
