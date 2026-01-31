import { useState, useEffect, useMemo } from 'react'
import { Save, RefreshCw } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { useSignaling } from '../../contexts/SignalingContext'
import { getSignalingServerUrl, setSignalingServerUrl } from '../../lib/tauri'
import { getNatOverride, setNatOverride, type NatOverride } from '../../lib/natOverride'
import { PEER_CONNECTION_CONFIG } from '../../lib/webrtc'

type NatIndicator = 'checking' | 'local_only' | 'nat' | 'relay' | 'unknown'

let natProbePromise: Promise<NatIndicator> | null = null

async function probeNatIndicator(): Promise<NatIndicator> {
  try {
    const pc = new RTCPeerConnection(PEER_CONNECTION_CONFIG)
    pc.createDataChannel('rmmt-nat-probe')

    const candidates: string[] = []
    pc.onicecandidate = (ev) => {
      if (ev.candidate?.candidate) candidates.push(ev.candidate.candidate)
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }

      const onState = () => {
        if (pc.iceGatheringState === 'complete') finish()
      }

      pc.addEventListener('icegatheringstatechange', onState)
      setTimeout(() => finish(), 2500)
    })

    pc.close()

    const types = new Set<string>()
    for (const c of candidates) {
      const m = c.match(/\btyp\s+(\w+)\b/i)
      if (m?.[1]) types.add(m[1].toLowerCase())
    }

    if (types.has('relay')) return 'relay'
    if (types.has('srflx')) return 'nat'
    if (types.has('host')) return 'local_only'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function ConnectionSettings() {
  const { status, checkHealth, reloadUrl } = useSignaling()
  const [url, setUrl] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [natOverride, setNatOverrideState] = useState<NatOverride>('auto')
  const [nat, setNat] = useState<NatIndicator>('checking')

  // Load current signaling server URL
  useEffect(() => {
    getSignalingServerUrl().then(setUrl).catch(console.error)
  }, [])

  useEffect(() => {
    setNatOverrideState(getNatOverride())
  }, [])

  useEffect(() => {
    if (!natProbePromise) natProbePromise = probeNatIndicator()
    natProbePromise.then(setNat).catch(() => setNat('unknown'))
  }, [])

  useEffect(() => {
    const onChanged = () => setNatOverrideState(getNatOverride())
    window.addEventListener('cordia:nat-override-changed', onChanged)
    return () => window.removeEventListener('cordia:nat-override-changed', onChanged)
  }, [])

  type NatExperience = 'checking' | 'open' | 'moderate' | 'strict'

  const natExperience: NatExperience = useMemo(() => {
    if (natOverride !== 'auto') return natOverride
    if (nat === 'checking') return 'checking'
    if (nat === 'nat') return 'open'
    if (nat === 'local_only') return 'strict'
    return 'moderate'
  }, [nat, natOverride])

  const getNatDisplayText = () => {
    switch (natExperience) {
      case 'open':
        return 'Open'
      case 'moderate':
        return 'Moderate'
      case 'strict':
        return 'Strict / CGNAT'
      case 'checking':
        return 'Checking...'
    }
  }

  const getNatDisplayColor = () => {
    switch (natExperience) {
      case 'open':
        return 'text-green-500'
      case 'moderate':
        return 'text-amber-500'
      case 'strict':
        return 'text-red-500'
      case 'checking':
        return 'text-amber-500'
    }
  }

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
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 space-y-8">
      <div className="space-y-1">
        <div className="inline-block">
          <h2 className="text-lg font-light tracking-tight">Connection Settings</h2>
          <div className="h-px bg-foreground/20 mt-1 w-full"></div>
        </div>
        <p className="text-xs text-muted-foreground font-light">
          Configure your beacon connection for P2P voice chat
        </p>
      </div>

      <div className="space-y-8">
        {/* Beacon URL */}
        <div className="space-y-3">
          <Label htmlFor="signaling-url" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Beacon URL
          </Label>
          <div className="flex gap-2">
            <Input
              id="signaling-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="wss://beacon.pkcollection.net"
              className="flex-1 font-mono text-sm h-11"
            />
            <Button
              onClick={handleSave}
              disabled={isSaving || !url}
              variant="outline"
              className="h-11 font-light gap-2"
            >
              <Save className="h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>
          {saveMessage && (
            <p className={`text-xs font-light ${saveMessage.includes('success') ? 'text-green-500' : 'text-red-500'}`}>
              {saveMessage}
            </p>
          )}
          <p className="text-xs text-muted-foreground font-light">
            WebSocket URL (ws:// or wss://).
          </p>
        </div>

        {/* Connection Status */}
        <div className="border border-border/50 bg-muted/20 rounded-md p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={`w-2 h-2 rounded-none ${
                  status === 'connected'
                    ? 'bg-green-500'
                    : status === 'checking'
                      ? 'bg-yellow-500 animate-pulse'
                      : status === 'disconnected'
                        ? 'bg-red-500'
                        : 'bg-muted-foreground'
                }`}
              />
              <div className="min-w-0">
                <p className="text-sm font-light">{getStatusText()}</p>
                <p className="text-xs text-muted-foreground font-light truncate">
                  {url || 'No beacon configured'}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheck}
              disabled={isChecking || !url}
              className="h-9 font-light gap-2"
            >
              <RefreshCw className={`h-3 w-3 ${isChecking ? 'animate-spin' : ''}`} />
              Check
            </Button>
          </div>
        </div>

        {/* NAT Type Display */}
        <div className="space-y-3">
          <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            NAT Type
          </Label>
          <div className="border border-border/50 bg-muted/20 rounded-md p-4">
            <div className="flex items-center gap-3">
              <div className="min-w-0">
                <p className={`text-sm font-light ${getNatDisplayColor()}`}>
                  {getNatDisplayText()}
                </p>
                {natOverride !== 'auto' && (
                  <p className="text-xs text-muted-foreground font-light mt-1">
                    Override enabled: {natOverride.toUpperCase()}
                  </p>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground font-light">
            Detected NAT type based on ICE candidate analysis.
          </p>
        </div>

        {/* NAT Type Override (Testing) */}
        <div className="space-y-3">
          <Label htmlFor="nat-override" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            NAT Type Override (testing)
          </Label>
          <Select
            id="nat-override"
            value={natOverride}
            onChange={(e) => {
              const v = e.target.value as NatOverride
              setNatOverrideState(v)
              setNatOverride(v)
            }}
          >
            <option value="auto">Auto-detect (default)</option>
            <option value="open">Force Open</option>
            <option value="moderate">Force Moderate</option>
            <option value="strict">Force Strict / CGNAT</option>
          </Select>
          <p className="text-xs text-muted-foreground font-light">
            This only changes the <span className="text-foreground font-normal">UI indicator</span> for testing.
          </p>
        </div>

        {/* Connection Info */}
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Setup</p>
          <div className="bg-muted/20 border border-border/50 rounded-md p-4 space-y-2 text-sm font-light">
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground ml-2">
              <li>Deploy the beacon on your VPS</li>
              <li>Use port 9001 (default)</li>
              <li>Enter `wss://YOUR_DOMAIN` (recommended)</li>
              <li>Save, then Check</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
