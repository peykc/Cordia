import { useState, useEffect, useRef } from 'react'
import { Play, Square } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { Slider } from '../../components/ui/slider'
import { VoiceLevelMeter } from '../../components/VoiceLevelMeter'
import { loadAudioSettings, saveAudioSettings, AudioSettings } from '../../lib/tauri'
import { enumerateAudioDevices, AudioDevice, setupDeviceChangeListener } from '../../lib/audio'
import { useWebRTC } from '../../contexts/WebRTCContext'

export function AudioSettingsPage() {
  // Get WebRTC context - we'll use ITS meter, not create our own
  const { inputLevelMeter, ensureAudioInitialized, reinitializeAudio, isInVoice } = useWebRTC()

  // Audio state
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([])
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([])
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({
    input_device_id: null,
    output_device_id: null,
    input_volume: 1.0,
    input_sensitivity: 0.2,
    output_volume: 1.0,
    input_mode: 'voice_activity',
    push_to_talk_key: null,
  })
  const [inputLevel, setInputLevel] = useState(0)
  const [isMonitoring, setIsMonitoring] = useState(false)
  const isMonitoringRef = useRef(false) // Track monitoring state without causing re-renders
  const [isDragging, setIsDragging] = useState(false)
  const [isCapturingKey, setIsCapturingKey] = useState(false)
  const [isPttKeyPressed, setIsPttKeyPressed] = useState(false)

  // Load audio devices and settings on mount
  useEffect(() => {
    async function loadAudioData() {
      try {
        // Enumerate devices FIRST (before loading settings that might trigger InputLevelMeter)
        const { inputDevices, outputDevices } = await enumerateAudioDevices()
        setInputDevices(inputDevices)
        setOutputDevices(outputDevices)

        // Then load saved settings (this will trigger InputLevelMeter if device is selected)
        const settings = await loadAudioSettings()
        setAudioSettings(settings)
      } catch (error) {
        console.error('Failed to load audio data:', error)
      }
    }

    loadAudioData()

    // Set up live device enumeration
    const cleanup = setupDeviceChangeListener(({ inputDevices, outputDevices }) => {
      setInputDevices(inputDevices)
      setOutputDevices(outputDevices)
    })

    return cleanup
  }, [])

  // Initialize audio on mount (only creates if doesn't exist)
  useEffect(() => {
    const initAudio = async () => {
      await ensureAudioInitialized(setInputLevel)
      console.log('[AudioSettings] Audio meter ready')
    }
    initAudio()
  }, [ensureAudioInitialized])

  // Handle device changes
  useEffect(() => {
    const wasMonitoring = isMonitoringRef.current

    const handleDeviceChange = async () => {
      if (isInVoice) {
        // During active call - cannot change device
        console.warn('[AudioSettings] Cannot change input device during active call')
        // TODO: Show user notification that device change requires leaving voice
        return
      }

      // Not in call - safe to reinitialize
      await reinitializeAudio(audioSettings.input_device_id || null, setInputLevel)
      console.log('[AudioSettings] Audio reinitialized with device:', audioSettings.input_device_id || 'default')

      // Restore monitoring if it was active
      if (wasMonitoring && inputLevelMeter) {
        const currentOutputDevice = audioSettings.output_device_id
        await inputLevelMeter.setMonitoring(true, currentOutputDevice)
      }
    }

    handleDeviceChange()
  }, [audioSettings.input_device_id, reinitializeAudio, isInVoice, inputLevelMeter])

  // Handle monitoring on/off ONLY when button is clicked, not when other settings change
  // This is controlled by isMonitoring state which only changes via handleToggleMonitoring

  // Update gain when input volume changes
  useEffect(() => {
    if (inputLevelMeter) {
      inputLevelMeter.setGain(audioSettings.input_volume)
    }
  }, [inputLevelMeter, audioSettings.input_volume])

  // Update threshold when input sensitivity changes
  useEffect(() => {
    if (inputLevelMeter) {
      inputLevelMeter.setThreshold(audioSettings.input_sensitivity)
    }
  }, [inputLevelMeter, audioSettings.input_sensitivity])

  // Update input mode when it changes
  useEffect(() => {
    if (inputLevelMeter) {
      inputLevelMeter.setInputMode(audioSettings.input_mode)
    }
  }, [inputLevelMeter, audioSettings.input_mode])

  // Update monitoring output device when it changes (only if already monitoring)
  useEffect(() => {
    if (inputLevelMeter && isMonitoring) {
      // Restart monitoring with new output device
      inputLevelMeter.setMonitoring(false)
      inputLevelMeter.setMonitoring(true, audioSettings.output_device_id)
    }
  }, [inputLevelMeter, audioSettings.output_device_id, isMonitoring])

  // Helper to check if a keyboard event matches the PTT key binding
  function matchesPttKey(e: KeyboardEvent, pttKey: string | null): boolean {
    if (!pttKey) return false

    const parts = pttKey.split('+')
    const hasCtrl = parts.includes('Ctrl')
    const hasShift = parts.includes('Shift')
    const hasAlt = parts.includes('Alt')
    const hasMeta = parts.includes('Meta')
    const mainKey = parts[parts.length - 1]

    return (
      e.ctrlKey === hasCtrl &&
      e.shiftKey === hasShift &&
      e.altKey === hasAlt &&
      e.metaKey === hasMeta &&
      (e.key.toUpperCase() === mainKey || e.key === mainKey)
    )
  }

  async function handleToggleMonitoring() {
    if (!inputLevelMeter) return

    const newMonitoringState = !isMonitoring
    setIsMonitoring(newMonitoringState)
    isMonitoringRef.current = newMonitoringState // Keep ref in sync

    await inputLevelMeter.setMonitoring(
      newMonitoringState,
      audioSettings.output_device_id
    )
  }

  async function handleAudioSettingsChange(updates: Partial<AudioSettings>) {
    // Use functional update to ensure we're working with latest state
    setAudioSettings(currentSettings => {
      const newSettings = { ...currentSettings, ...updates }

      // Save asynchronously (don't block UI)
      saveAudioSettings(newSettings).catch(error => {
        console.error('Failed to save audio settings:', error)
      })

      return newSettings
    })
  }

  // Track dragging state for visual feedback
  useEffect(() => {
    const handleMouseUp = () => setIsDragging(false)
    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 1) setIsDragging(true)
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('mousemove', handleMouseMove)

    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('mousemove', handleMouseMove)
    }
  }, [])

  // Key capture for push-to-talk
  useEffect(() => {
    if (!isCapturingKey) return

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()

      // Build key string (e.g., "Ctrl+Shift+T")
      const parts: string[] = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.shiftKey) parts.push('Shift')
      if (e.altKey) parts.push('Alt')
      if (e.metaKey) parts.push('Meta')

      // Add the main key (ignore modifier keys by themselves)
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
      }

      if (parts.length > 0) {
        const keyString = parts.join('+')
        handleAudioSettingsChange({ push_to_talk_key: keyString })
        setIsCapturingKey(false)
      }
    }

    const handleBlur = () => {
      setIsCapturingKey(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', handleBlur)
    }
  }, [isCapturingKey])

  // PTT key press/release listener (only active when monitoring and in PTT mode)
  useEffect(() => {
    if (!isMonitoring || audioSettings.input_mode !== 'push_to_talk' || !audioSettings.push_to_talk_key) {
      return
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesPttKey(e, audioSettings.push_to_talk_key) && !isPttKeyPressed) {
        e.preventDefault()
        setIsPttKeyPressed(true)
        if (inputLevelMeter) {
          inputLevelMeter.setPttKeyPressed(true)
        }
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (matchesPttKey(e, audioSettings.push_to_talk_key)) {
        e.preventDefault()
        setIsPttKeyPressed(false)
        if (inputLevelMeter) {
          inputLevelMeter.setPttKeyPressed(false)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [isMonitoring, audioSettings.input_mode, audioSettings.push_to_talk_key, isPttKeyPressed])

  // Convert input_sensitivity (0-1) to dB (-100 to 0) for display
  const currentDb = Math.round(-100 + (audioSettings.input_sensitivity * 100))

  return (
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <div className="inline-block">
          <h2 className="text-lg font-light tracking-tight">Audio Settings</h2>
          <div className="h-px bg-foreground/20 mt-1 w-full"></div>
        </div>
        <p className="text-xs text-muted-foreground font-light">Configure your audio devices and preferences</p>
      </div>

      <div className="space-y-8">
        {/* Input & Output Section - Side by Side like Discord */}
        <div className="grid grid-cols-2 gap-6">
          {/* Input Device Column */}
          <div className="space-y-4">
            <label htmlFor="input-device" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Input Device
            </label>
            <Select
              id="input-device"
              value={audioSettings.input_device_id || ''}
              onChange={(e) => handleAudioSettingsChange({ input_device_id: e.target.value || null })}
            >
              <option value="">Default</option>
              {inputDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </Select>

            {/* Input Volume */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <label htmlFor="input-volume" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Input Volume
                </label>
                <span className="text-xs text-muted-foreground font-light">
                  {Math.round(audioSettings.input_volume * 100)}%
                </span>
              </div>
              <Slider
                id="input-volume"
                min={0}
                max={2}
                step={0.01}
                value={audioSettings.input_volume}
                onValueChange={(value) => handleAudioSettingsChange({ input_volume: value })}
              />
            </div>
          </div>

          {/* Output Device Column */}
          <div className="space-y-4">
            <label htmlFor="output-device" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Output Device
            </label>
            <Select
              id="output-device"
              value={audioSettings.output_device_id || ''}
              onChange={(e) => handleAudioSettingsChange({ output_device_id: e.target.value || null })}
            >
              <option value="">Default</option>
              {outputDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </Select>

            {/* Output Volume */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <label htmlFor="output-volume" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Output Volume
                </label>
                <span className="text-xs text-muted-foreground font-light">
                  {Math.round(audioSettings.output_volume * 100)}%
                </span>
              </div>
              <Slider
                id="output-volume"
                min={0}
                max={1}
                step={0.01}
                value={audioSettings.output_volume}
                onValueChange={(value) => handleAudioSettingsChange({ output_volume: value })}
              />
            </div>
          </div>
        </div>

        {/* Mic Test Section */}
        <div className="space-y-3">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Mic Test
          </label>
          <Button
            variant="outline"
            onClick={handleToggleMonitoring}
            className="w-full h-10 font-light border-border/50 hover:bg-accent text-sm"
          >
            {isMonitoring ? (
              <>
                <Square className="mr-2 h-4 w-4" />
                Stop Testing
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Let's Check
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground font-light">
            {isMonitoring ? "Playing back your beautiful voice." : "Having mic issues? Start a test and say something fun — we'll play your voice back to you."}
          </p>
        </div>

        {/* Input Mode Selector */}
        <div className="space-y-3">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Input Mode
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => handleAudioSettingsChange({ input_mode: 'voice_activity' })}
              className={`flex-1 px-4 py-2 text-sm font-light rounded-md transition-colors ${
                audioSettings.input_mode === 'voice_activity'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80 text-muted-foreground'
              }`}
            >
              Voice Activity
            </button>
            <button
              onClick={() => handleAudioSettingsChange({ input_mode: 'push_to_talk' })}
              className={`flex-1 px-4 py-2 text-sm font-light rounded-md transition-colors ${
                audioSettings.input_mode === 'push_to_talk'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80 text-muted-foreground'
              }`}
            >
              Push to Talk
            </button>
          </div>
        </div>

        {/* Voice Activity Mode - Threshold Slider */}
        {audioSettings.input_mode === 'voice_activity' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Input Sensitivity
              </label>
              <span className="text-xs text-muted-foreground font-light">
                {currentDb}dB
              </span>
            </div>

            {/* Voice Level Meter - Canvas-based */}
            <VoiceLevelMeter
              level={inputLevel}
              threshold={audioSettings.input_sensitivity}
              isDragging={isDragging}
              onThresholdChange={(threshold) => handleAudioSettingsChange({ input_sensitivity: threshold })}
            />

            <p className="text-xs text-muted-foreground font-light">
              Drag the dot to set your threshold. Red = not transmitted, Green = transmitted. Try speaking at different volumes!
            </p>
          </div>
        )}

        {/* Push to Talk Mode - Key Binding */}
        {audioSettings.input_mode === 'push_to_talk' && (
          <div className="space-y-3">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Push to Talk Key
            </label>
            <button
              className={`w-full px-4 py-3 text-sm font-light rounded-md transition-colors ${
                isCapturingKey
                  ? 'bg-primary text-primary-foreground border-2 border-primary animate-pulse'
                  : 'bg-muted hover:bg-muted/80 text-foreground border-2 border-muted'
              }`}
              onClick={() => setIsCapturingKey(true)}
            >
              {isCapturingKey ? 'Press any key...' : (audioSettings.push_to_talk_key || 'Click to set key binding')}
            </button>
            <p className="text-xs text-muted-foreground font-light">
              {isCapturingKey
                ? 'Listening for key press...'
                : 'Click and press any key to set your Push to Talk binding.'}
            </p>

            {/* PTT Active Indicator */}
            {isMonitoring && audioSettings.push_to_talk_key && (
              <div className={`px-4 py-2 rounded-md text-center text-sm font-light transition-colors ${
                isPttKeyPressed
                  ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                  : 'bg-muted text-muted-foreground'
              }`}>
                {isPttKeyPressed ? '🎤 Transmitting...' : `Hold "${audioSettings.push_to_talk_key}" to talk`}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}




