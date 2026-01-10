import { useState, useEffect } from 'react'
import { Save, RefreshCw, Circle } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useSignaling } from '../../contexts/SignalingContext'
import { getSignalingServerUrl, setSignalingServerUrl } from '../../lib/tauri'

export function ConnectionSettings() {
  const { status, checkHealth, reloadUrl } = useSignaling()
  const [url, setUrl] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')

  // Load current signaling server URL
  useEffect(() => {
    getSignalingServerUrl().then(setUrl).catch(console.error)
  }, [])

  const handleSave = async () => {
    setIsSaving(true)
    setSaveMessage('')
    try {
      // Ensure URL has ws:// prefix
      let formattedUrl = url.trim()
      if (!formattedUrl.startsWith('ws://') && !formattedUrl.startsWith('wss://')) {
        formattedUrl = `ws://${formattedUrl}`
      }

      await setSignalingServerUrl(formattedUrl)
      setUrl(formattedUrl) // Update the input to show formatted URL

      // Reload URL in context to trigger health check with new URL
      await reloadUrl()

      setSaveMessage('Saved successfully!')
      setTimeout(() => setSaveMessage(''), 3000)
    } catch (error) {
      console.error('Failed to save signaling URL:', error)
      setSaveMessage('Failed to save')
    } finally {
      setIsSaving(false)
    }
  }

  const handleCheck = async () => {
    setIsChecking(true)
    setSaveMessage('')
    try {
      await checkHealth()
      // Show result after check completes
      setTimeout(() => {
        if (status === 'connected') {
          setSaveMessage('Connection successful!')
        } else {
          setSaveMessage('Connection failed - check URL and server')
        }
        setTimeout(() => setSaveMessage(''), 3000)
      }, 500)
    } catch (error) {
      console.error('Check failed:', error)
      setSaveMessage('Connection failed')
      setTimeout(() => setSaveMessage(''), 3000)
    } finally {
      setIsChecking(false)
    }
  }

  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return 'text-green-500'
      case 'disconnected':
        return 'text-red-500'
      case 'checking':
        return 'text-yellow-500'
      default:
        return 'text-muted-foreground'
    }
  }

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return 'Connected'
      case 'disconnected':
        return 'Disconnected'
      case 'checking':
        return 'Checking...'
      default:
        return 'Unknown'
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-light tracking-wide mb-2">Connection Settings</h2>
        <p className="text-sm text-muted-foreground font-light">
          Configure your signaling server connection for P2P voice chat
        </p>
      </div>

      <div className="space-y-6">
        {/* Signaling Server URL */}
        <div className="space-y-3">
          <Label htmlFor="signaling-url" className="text-sm font-light">
            Signaling Server URL
          </Label>
          <div className="flex gap-2">
            <Input
              id="signaling-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://192.168.0.100:9001"
              className="flex-1 font-mono text-sm"
            />
            <Button
              onClick={handleSave}
              disabled={isSaving || !url}
              className="gap-2"
            >
              <Save className="h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>
          {saveMessage && (
            <p className={`text-sm ${saveMessage.includes('success') ? 'text-green-500' : 'text-red-500'}`}>
              {saveMessage}
            </p>
          )}
          <p className="text-xs text-muted-foreground font-light">
            Enter the WebSocket URL of your signaling server (e.g., ws://192.168.0.100:9001)
          </p>
        </div>

        {/* Connection Status */}
        <div className="border-2 border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Circle
                className={`h-3 w-3 ${getStatusColor()} ${status === 'connected' ? 'fill-current' : ''} ${status === 'checking' ? 'animate-pulse' : ''}`}
              />
              <div>
                <p className="text-sm font-medium">{getStatusText()}</p>
                <p className="text-xs text-muted-foreground font-light">
                  {url || 'No server configured'}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheck}
              disabled={isChecking || !url}
              className="gap-2"
            >
              <RefreshCw className={`h-3 w-3 ${isChecking ? 'animate-spin' : ''}`} />
              Check
            </Button>
          </div>
        </div>

        {/* Connection Info */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Setup Instructions</h3>
          <div className="bg-muted/50 border-2 border-border rounded-lg p-4 space-y-2 text-sm font-light">
            <p className="font-medium">To set up your signaling server:</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground ml-2">
              <li>Deploy the signaling server on your NAS or VPS</li>
              <li>Note the IP address and port (default: 9001)</li>
              <li>Enter the WebSocket URL above (ws://YOUR_IP:9001)</li>
              <li>Click Save and verify the connection shows as "Connected"</li>
            </ol>
            <p className="text-xs text-muted-foreground mt-3">
              For deployment instructions, see the{' '}
              <a
                href="https://github.com/Pey-K/Roommate"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground transition-colors"
              >
                README on GitHub
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
