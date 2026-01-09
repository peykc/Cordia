import { useSignaling } from '../contexts/SignalingContext'
import { Circle } from 'lucide-react'

export function SignalingStatus() {
  const { status, signalingUrl } = useSignaling()

  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return 'text-green-500'
      case 'disconnected':
        return 'text-red-500'
      case 'checking':
        return 'text-yellow-500'
    }
  }

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return 'Signaling server connected'
      case 'disconnected':
        return 'Signaling server offline - Room creation disabled'
      case 'checking':
        return 'Checking signaling server...'
    }
  }

  const getTooltipText = () => {
    switch (status) {
      case 'connected':
        return `Connected to ${signalingUrl}. Full features available including room creation.`
      case 'disconnected':
        return `Cannot connect to ${signalingUrl}. Limited to single default room per house.`
      case 'checking':
        return `Checking connection to ${signalingUrl}...`
    }
  }

  return (
    <div className="relative group">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-accent/50 transition-colors cursor-help">
        <Circle className={`h-2 w-2 fill-current ${getStatusColor()}`} />
        <span className="text-xs font-light text-muted-foreground">
          {status === 'connected' ? 'Connected' : status === 'checking' ? 'Checking' : 'Offline'}
        </span>
      </div>

      {/* Tooltip */}
      <div className="absolute top-full right-0 mt-2 w-64 p-3 bg-popover border-2 border-border rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
        <p className="text-xs font-light leading-relaxed">{getTooltipText()}</p>
      </div>
    </div>
  )
}
