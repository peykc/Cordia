export interface AudioDevice {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
}

// Helper function to clean device labels
function cleanDeviceLabel(label: string): string {
  // Remove Windows-specific prefixes like "Default -", "Communications -", "Multimedia -"
  let clean = label.replace(/^(Default|Communications|Multimedia)\s*-\s*/i, '').trim()
  
  // Remove vendor IDs in parentheses (format: (XXXX:XXXX) hex patterns)
  // But keep descriptive info like "(3- Razer Kraken V3 Pro)"
  clean = clean.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*/gi, '')
  clean = clean.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '')
  
  return clean.trim()
}

export async function enumerateAudioDevices(): Promise<{
  inputDevices: AudioDevice[]
  outputDevices: AudioDevice[]
}> {
  try {
    // Request permission to access audio devices (required for device labels)
    // Only request if we don't already have an active stream
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Stop immediately, we just needed permission
      stream.getTracks().forEach(track => track.stop())
    } catch (permError) {
      console.warn('Permission denied for audio devices:', permError)
      // Continue anyway - we might still get device IDs without labels
    }

    // Enumerate devices
    const devices = await navigator.mediaDevices.enumerateDevices()
    console.log('Enumerated devices:', devices.length, 'total')
    
    // Process input devices - filter out prefixed ones and clean labels
    const rawInputDevices = devices
      .filter(device => device.kind === 'audioinput')
      .filter(device => {
        // Filter out "Default -" and "Communications -" prefixed devices
        const label = device.label || ''
        // If label is empty, still include it (permission issue, but device exists)
        if (!label) return true
        return !/^(Default|Communications|Multimedia)\s*-\s*/i.test(label)
      })
      .map(device => ({
        deviceId: device.deviceId,
        label: device.label 
          ? cleanDeviceLabel(device.label)
          : `Microphone ${device.deviceId.slice(0, 8)}`,
        kind: 'audioinput' as const,
      }))

    // Process output devices - filter out prefixed ones, clean labels, and deduplicate
    const rawOutputDevices = devices
      .filter(device => device.kind === 'audiooutput')
      .filter(device => {
        // Filter out "Default -" and "Communications -" prefixed devices
        const label = device.label || ''
        // If label is empty, still include it (permission issue, but device exists)
        if (!label) return true
        return !/^(Default|Communications|Multimedia)\s*-\s*/i.test(label)
      })
      .map(device => ({
        deviceId: device.deviceId,
        originalLabel: device.label || `Speaker ${device.deviceId.slice(0, 8)}`,
        label: device.label
          ? cleanDeviceLabel(device.label)
          : `Speaker ${device.deviceId.slice(0, 8)}`,
        kind: 'audiooutput' as const,
      }))

    // Deduplicate output devices by cleaned label (keep first occurrence)
    const outputDeviceMap = new Map<string, AudioDevice>()
    for (const device of rawOutputDevices) {
      if (!outputDeviceMap.has(device.label)) {
        outputDeviceMap.set(device.label, device)
      }
    }

    const result = { 
      inputDevices: rawInputDevices, 
      outputDevices: Array.from(outputDeviceMap.values())
    }
    
    console.log('Processed devices:', {
      input: result.inputDevices.length,
      output: result.outputDevices.length
    })

    return result
  } catch (error) {
    console.error('Failed to enumerate audio devices:', error)
    return { inputDevices: [], outputDevices: [] }
  }
}

// Set up live device enumeration listener
export function setupDeviceChangeListener(
  onDevicesChanged: (devices: { inputDevices: AudioDevice[]; outputDevices: AudioDevice[] }) => void
): () => void {
  const handleDeviceChange = async () => {
    const devices = await enumerateAudioDevices()
    onDevicesChanged(devices)
  }

  navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)

  // Return cleanup function
  return () => {
    navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
  }
}

export class InputLevelMeter {
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  private microphone: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private dataArray: Float32Array | null = null
  private animationFrame: number | null = null
  private onLevelUpdate: ((level: number) => void) | null = null
  private displayedLevel: number = 0 // Envelope for attack/decay
  
  // Optional monitoring
  private destination: MediaStreamAudioDestinationNode | null = null
  private monitoringAudio: HTMLAudioElement | null = null
  private monitoringGain: GainNode | null = null
  private threshold: number = 0.2 // Voice activation threshold (0-1)
  private currentGain: number = 0 // Current smoothed gain for threshold gating
  private useVoiceActivity: boolean = true // false for push-to-talk (raw audio always on)
  private isPttKeyPressed: boolean = false // PTT key state
  private isTransmissionMuted: boolean = false // Manual mute (overrides VAD/PTT)

  async start(
    deviceId: string | null,
    onLevelUpdate: (level: number) => void
  ) {
    this.stop()
    this.onLevelUpdate = onLevelUpdate

    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          autoGainControl: false, // We control gain manually
          echoCancellation: false, // Disabled
          noiseSuppression: false, // Disabled
          sampleRate: { ideal: 48000 }, // Use ideal instead of exact for compatibility
          channelCount: 1,
        } as MediaTrackConstraints, // Type assertion for browser compatibility
      }

      this.stream = await navigator.mediaDevices.getUserMedia(constraints)

      this.audioContext = new AudioContext()

      // Ensure AudioContext is running (may be suspended due to autoplay policy)
      if (this.audioContext.state === 'suspended') {
        console.log('[Audio] AudioContext suspended, attempting to resume...')
        await this.audioContext.resume()
        console.log('[Audio] AudioContext state after resume:', this.audioContext.state)
      }

      // Create audio graph: MediaStreamSource → GainNode → AnalyserNode
      this.microphone = this.audioContext.createMediaStreamSource(this.stream)
      
      this.gainNode = this.audioContext.createGain()
      this.gainNode.gain.value = 1.0 // Default gain
      
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 256 // Small FFT for low latency
      this.analyser.smoothingTimeConstant = 0.3 // Moderate smoothing for responsive meter
      
      // Connect: source → gain → analyser
      this.microphone.connect(this.gainNode)
      this.gainNode.connect(this.analyser)
      
      // Optional monitoring destination with threshold gating
      this.destination = this.audioContext.createMediaStreamDestination()
      this.monitoringGain = this.audioContext.createGain()
      this.monitoringGain.gain.value = 0 // Start muted (threshold not met)
      this.gainNode.connect(this.monitoringGain)
      this.monitoringGain.connect(this.destination)

      // Debug: Check the destination stream
      const destTracks = this.destination.stream.getAudioTracks()
      console.log('[Audio] Destination stream has', destTracks.length, 'tracks')
      if (destTracks.length > 0) {
        console.log('[Audio] Destination track readyState:', destTracks[0].readyState)
      }

      // Use fftSize for time-domain data (Float32Array for higher resolution)
      this.dataArray = new Float32Array(this.analyser.fftSize)
      this.displayedLevel = 0
      this.updateLevel()

      console.log('[Audio] Input level meter started successfully', {
        deviceId: deviceId || 'default',
        audioContextState: this.audioContext.state,
        trackLabel: this.stream.getAudioTracks()[0]?.label || 'unknown',
        trackState: this.stream.getAudioTracks()[0]?.readyState || 'unknown'
      })
    } catch (error) {
      console.error('[Audio] Failed to start input level meter:', error)
      console.error('[Audio] Error details:', {
        name: (error as Error).name,
        message: (error as Error).message,
        deviceId: deviceId || 'default'
      })
      onLevelUpdate(0)
      // Re-throw the error so callers know initialization failed
      throw error
    }
  }

  setGain(value: number) {
    if (this.gainNode) {
      this.gainNode.gain.value = value
      console.log(`[Audio] Input gain updated → ${value.toFixed(2)}`)
    }
  }

  setThreshold(value: number) {
    this.threshold = value
    console.log(`[Audio] VAD threshold updated → ${value.toFixed(2)}`)
  }

  setInputMode(mode: 'voice_activity' | 'push_to_talk') {
    const wasVAD = this.useVoiceActivity
    this.useVoiceActivity = mode === 'voice_activity'
    // Reset gain when switching modes
    if (!this.useVoiceActivity) {
      this.currentGain = 0 // PTT starts muted until key pressed
      this.isPttKeyPressed = false
    } else {
      this.currentGain = 0 // Voice activity starts gated
    }
    if (wasVAD !== this.useVoiceActivity) {
      console.log(`[Audio] Input mode switched → ${mode}`)
    }
  }

  setPttKeyPressed(pressed: boolean) {
    if (this.isPttKeyPressed !== pressed) {
      this.isPttKeyPressed = pressed
      console.log(`[Audio] PTT key ${pressed ? 'pressed' : 'released'}`)
    }
  }

  setOnLevelUpdate(callback: (level: number) => void) {
    this.onLevelUpdate = callback
    console.log('[Audio] Level update callback rebound')
  }

  async setMonitoring(enabled: boolean, outputDeviceId: string | null = null) {
    if (enabled && this.destination && !this.monitoringAudio) {
      // Create audio element for monitoring
      this.monitoringAudio = new Audio()
      this.monitoringAudio.srcObject = this.destination.stream
      this.monitoringAudio.volume = 1.0
      
      // Set output device if specified and supported
      if (outputDeviceId && 'setSinkId' in this.monitoringAudio) {
        try {
          await (this.monitoringAudio as any).setSinkId(outputDeviceId)
        } catch (error) {
          console.warn('Failed to set monitoring output device:', error)
        }
      }
      
      this.monitoringAudio.play().catch(error => {
        console.error('Failed to start monitoring:', error)
      })
    } else if (!enabled && this.monitoringAudio) {
      this.monitoringAudio.pause()
      this.monitoringAudio.srcObject = null
      this.monitoringAudio = null
    }
  }

  /**
   * Get the audio stream for WebRTC transmission.
   * This stream has VAD/PTT gating applied via monitoringGain.
   */
  getTransmissionStream(): MediaStream | null {
    return this.destination?.stream || null
  }

  /**
   * Set whether transmission is muted (independent of VAD/PTT).
   * When muted, no audio is sent through the transmission stream.
   *
   * Note: This overrides VAD/PTT - even if voice is detected or PTT is pressed,
   * muted audio will not transmit.
   */
  setTransmissionMuted(muted: boolean) {
    if (!this.monitoringGain) return

    // Store mute state to prevent VAD/PTT from overriding it
    this.isTransmissionMuted = muted

    if (muted) {
      // Force gain to 0 (muted)
      this.monitoringGain.gain.value = 0
    }
    // If unmuted, VAD/PTT logic in updateLevel() will control the gain
  }

  private updateLevel() {
    if (!this.analyser || !this.dataArray || !this.onLevelUpdate) return

    // 1. Get high-resolution time-domain data (Float32Array preserves small fluctuations)
    this.analyser.getFloatTimeDomainData(this.dataArray as any)

    // 2. Peak detection (absolute peak across all samples)
    let peak = 0
    for (let i = 0; i < this.dataArray.length; i++) {
      const v = Math.abs(this.dataArray[i])
      if (v > peak) peak = v
    }

    // 3. Envelope — fast attack (instant rise), slow decay (~0.88 per frame)
    const decayFactor = 0.88
    this.displayedLevel = Math.max(peak, this.displayedLevel * decayFactor)

    // 4. Mute-floor fix — clamp true silence to 0
    const noiseFloor = 0.0002
    if (this.displayedLevel < noiseFloor) {
      this.displayedLevel = 0
      this.onLevelUpdate(0)
      this.animationFrame = requestAnimationFrame(() => this.updateLevel())
      return
    }

    // 5. Dynamic range compression for human-level audio
    // Map practical voice range (quiet → normal speech) to 0-1 for display
    const minLevel = noiseFloor
    const maxLevel = 0.07
    let normalized = (this.displayedLevel - minLevel) / (maxLevel - minLevel)
    
    // Do NOT clip loud signals — above maxLevel maps to full bar
    if (normalized > 1.0) {
      normalized = 1.0
    }
    normalized = Math.max(0, normalized) // Ensure non-negative
    
    // Perceptual boost for quiet sounds (sqrt for gentle curve)
    const level = Math.sqrt(normalized)

    // 6. Apply threshold gating for monitoring (only in voice activity mode)
    if (this.monitoringGain) {
      // Manual mute overrides all gating logic
      if (this.isTransmissionMuted) {
        this.monitoringGain.gain.setValueAtTime(0, this.audioContext!.currentTime)
        this.currentGain = 0 // Reset envelope when muted
      } else if (this.useVoiceActivity) {
        // Voice Activity mode: gate based on threshold
        const targetGain = level >= this.threshold ? 1.0 : 0.0

        // Smooth envelope with exponential attack/release
        const attackCoeff = 0.3   // Fast attack (30% blend per frame)
        const releaseCoeff = 0.05  // Slow release (5% blend per frame)

        if (targetGain > this.currentGain) {
          // Attack (opening gate) - faster exponential smoothing
          this.currentGain = this.currentGain * (1 - attackCoeff) + targetGain * attackCoeff
        } else {
          // Release (closing gate) - slower exponential smoothing
          this.currentGain = this.currentGain * (1 - releaseCoeff) + targetGain * releaseCoeff
        }

        // Apply smoothed gain (use setValueAtTime for immediate, click-free changes)
        this.monitoringGain.gain.setValueAtTime(
          Math.max(0.001, this.currentGain), // Clamp to avoid 0 (exponential ramp issue)
          this.audioContext!.currentTime
        )
      } else {
        // Push-to-Talk mode: transmit only when key is pressed
        const targetGain = this.isPttKeyPressed ? 1.0 : 0.0
        this.monitoringGain.gain.setValueAtTime(targetGain, this.audioContext!.currentTime)
      }
    }

    // 7. Output
    this.onLevelUpdate(level)

    // 8. Loop
    this.animationFrame = requestAnimationFrame(() => this.updateLevel())
  }

  stop() {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
    }

    this.setMonitoring(false)

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }

    if (this.audioContext) {
      this.audioContext.close().catch(console.error)
      this.audioContext = null
    }

    this.microphone = null
    this.gainNode = null
    this.analyser = null
    this.destination = null
    this.monitoringGain = null
    this.dataArray = null
    this.displayedLevel = 0
    this.currentGain = 0
    this.onLevelUpdate = null
  }
}

