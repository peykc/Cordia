export interface AudioDevice {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
}

/**
 * Request microphone permission once so the system/WebView2 prompt appears in a single place.
 * Call early after login so the user sees the prompt once; later getUserMedia calls (e.g. in
 * enumerateAudioDevices or voice capture) will already have permission.
 * In packaged apps (Tauri/WebView2) the prompt is from the webview, not the OS; Tauri 1 does not
 * expose a way to auto-grant media permissions, so the user must allow once.
 */
export async function requestMicrophonePermission(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
  } catch {
    // User denied or unavailable - ignore; later audio code will handle it
  }
}

export async function enumerateAudioDevices(): Promise<{
  inputDevices: AudioDevice[]
  outputDevices: AudioDevice[]
}> {
  try {
    // Use native Rust enumeration (no permissions needed!)
    const { enumerateAudioDevicesNative } = await import('./nativeAudio')
    const nativeDevices = await enumerateAudioDevicesNative()
    
    // Convert to AudioDevice format
    const inputDevices: AudioDevice[] = nativeDevices.inputDevices.map(d => ({
      deviceId: d.device_id,
      label: d.label,
      kind: d.kind as 'audioinput'
    }))
    
    const outputDevices: AudioDevice[] = nativeDevices.outputDevices.map(d => ({
      deviceId: d.device_id,
      label: d.label,
      kind: d.kind as 'audiooutput'
    }))
    
    console.log('Enumerated devices (native):', {
      input: inputDevices.length,
      output: outputDevices.length
    })
    
    return { inputDevices, outputDevices }
  } catch (error) {
    console.error('Failed to enumerate audio devices (native):', error)
    // Fallback: return empty arrays
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
  // Native audio capture (replaces Web Audio API)
  private nativeCapture: any = null // NativeAudioCapture instance
  private stream: MediaStream | null = null
  
  // Legacy Web Audio API fields (kept for compatibility, but not used with native capture)
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  private microphone: MediaStreamAudioSourceNode | null = null
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
  
  // Use native capture by default
  private useNativeCapture: boolean = true

  async start(
    deviceId: string | null,
    onLevelUpdate: (level: number) => void
  ) {
    this.stop()
    this.onLevelUpdate = onLevelUpdate

    try {
      // Use native capture (system-level, no mic prompt)
      if (this.useNativeCapture) {
        try {
          const { NativeAudioCapture } = await import('./nativeAudio')
          this.nativeCapture = new NativeAudioCapture()
          this.stream = await this.nativeCapture.start(deviceId, onLevelUpdate)
          
          // Apply saved settings to native DSP
          // These will be set via Tauri commands
          console.log('[Audio] Native capture started successfully')
          return
        } catch (nativeError) {
          console.error('[Audio] Native capture failed, falling back to getUserMedia:', nativeError)
          // Fall through to getUserMedia fallback
          this.useNativeCapture = false
        }
      }
      
      // Fallback to old getUserMedia method (for compatibility)
      // Prefer specified device but use ideal so we don't fail if device is unavailable
      const constraints: MediaStreamConstraints = {
        audio: deviceId
          ? { deviceId: { ideal: deviceId }, autoGainControl: false, echoCancellation: false, noiseSuppression: false }
          : { autoGainControl: false, echoCancellation: false, noiseSuppression: false },
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      } catch (err) {
        // OverconstrainedError: device unavailable or constraints too strict; fall back to default mic
        if (err instanceof Error && err.name === 'OverconstrainedError' && deviceId) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } else {
          throw err
        }
      }
      this.stream = stream

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
    } catch (error) {
      console.error('Failed to start input level meter:', error)
      onLevelUpdate(0)
    }
  }

  async setGain(value: number) {
    if (this.useNativeCapture && this.nativeCapture) {
      // Use native DSP via Tauri command
      const { invoke } = await import('@tauri-apps/api/tauri')
      await invoke('set_audio_gain', { gain: value })
      console.log(`[Audio] Native input gain updated → ${value.toFixed(2)}`)
    } else if (this.gainNode) {
      // Legacy Web Audio API
      this.gainNode.gain.value = value
      console.log(`[Audio] Input gain updated → ${value.toFixed(2)}`)
    }
  }

  async setThreshold(value: number) {
    this.threshold = value
    if (this.useNativeCapture && this.nativeCapture) {
      // Use native DSP via Tauri command
      const { invoke } = await import('@tauri-apps/api/tauri')
      await invoke('set_audio_threshold', { threshold: value })
      console.log(`[Audio] Native VAD threshold updated → ${value.toFixed(2)}`)
    } else {
      console.log(`[Audio] VAD threshold updated → ${value.toFixed(2)}`)
    }
  }

  async setInputMode(mode: 'voice_activity' | 'push_to_talk') {
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
    
    if (this.useNativeCapture && this.nativeCapture) {
      // Use native DSP via Tauri command
      const { invoke } = await import('@tauri-apps/api/tauri')
      await invoke('set_audio_input_mode', { mode })
    }
  }

  async setPttKeyPressed(pressed: boolean) {
    if (this.isPttKeyPressed !== pressed) {
      this.isPttKeyPressed = pressed
      console.log(`[Audio] PTT key ${pressed ? 'pressed' : 'released'}`)
    }
    
    if (this.useNativeCapture && this.nativeCapture) {
      // Use native DSP via Tauri command
      const { invoke } = await import('@tauri-apps/api/tauri')
      await invoke('set_ptt_key_pressed', { pressed })
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
   * With native capture, this stream already has VAD/PTT gating applied in Rust DSP.
   */
  getTransmissionStream(): MediaStream | null {
    if (this.useNativeCapture && this.stream) {
      // Native capture stream already has DSP gating applied
      return this.stream
    }
    // Legacy: Web Audio API destination stream
    return this.destination?.stream || null
  }

  /**
   * Set whether transmission is muted (independent of VAD/PTT).
   * When muted, no audio is sent through the transmission stream.
   *
   * Note: This overrides VAD/PTT - even if voice is detected or PTT is pressed,
   * muted audio will not transmit.
   */
  async setTransmissionMuted(muted: boolean) {
    // Store mute state to prevent VAD/PTT from overriding it
    this.isTransmissionMuted = muted

    if (this.useNativeCapture && this.nativeCapture) {
      // Use native DSP via Tauri command
      const { invoke } = await import('@tauri-apps/api/tauri')
      await invoke('set_transmission_muted', { muted })
    } else if (this.monitoringGain) {
      // Legacy: Web Audio API
      if (muted) {
        // Force gain to 0 (muted)
        this.monitoringGain.gain.value = 0
      }
      // If unmuted, VAD/PTT logic in updateLevel() will control the gain
    }
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

  async stop() {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
    }

    this.setMonitoring(false)

    // Stop native capture
    if (this.useNativeCapture && this.nativeCapture) {
      await this.nativeCapture.stop()
      this.nativeCapture = null
      this.stream = null
    } else if (this.stream) {
      // Legacy: Web Audio API
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

