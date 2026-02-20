/**
 * Analyzes remote audio streams to detect when users are speaking.
 * Uses Web Audio API to monitor audio levels and determine speaking state.
 */
export class RemoteAudioAnalyzer {
  private audioContext: AudioContext
  private ownedContext: boolean // If we created the context, we close it on stop(); otherwise we don't
  private analyser: AnalyserNode
  private dataArray: Uint8Array
  private intervalId: number | null = null
  private onSpeakingChange: (isSpeaking: boolean) => void
  private noiseFloor: number = 0.02 // Very low threshold just to filter silence
  private isCurrentlySpeaking: boolean = false
  private updateInterval: number = 100 // 10 FPS instead of 60 FPS for performance

  constructor(
    stream: MediaStream,
    onSpeakingChange: (isSpeaking: boolean) => void,
    sharedContext?: AudioContext
  ) {
    this.ownedContext = !sharedContext
    this.audioContext = sharedContext ?? new AudioContext()
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.3 // Fast response
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount)
    this.onSpeakingChange = onSpeakingChange

    // Connect the received stream to the analyser
    const source = this.audioContext.createMediaStreamSource(stream)
    source.connect(this.analyser)

    this.startMonitoring()
  }

  private startMonitoring() {
    const update = () => {
      // @ts-ignore - getByteFrequencyData accepts Uint8Array, TypeScript is being overly strict
      this.analyser.getByteFrequencyData(this.dataArray)

      // Calculate RMS (root mean square) for overall volume
      let sum = 0
      for (let i = 0; i < this.dataArray.length; i++) {
        sum += this.dataArray[i] * this.dataArray[i]
      }
      const rms = Math.sqrt(sum / this.dataArray.length) / 255

      // If we're receiving audio above noise floor, they're speaking
      // (Their VAD/PTT already filtered it, so any audio = speaking)
      const isSpeaking = rms > this.noiseFloor

      // Only update if state changed (avoid unnecessary re-renders)
      if (isSpeaking !== this.isCurrentlySpeaking) {
        this.isCurrentlySpeaking = isSpeaking
        this.onSpeakingChange(isSpeaking)
      }

      this.intervalId = window.setTimeout(update, this.updateInterval)
    }
    update()
  }

  stop() {
    if (this.intervalId !== null) {
      clearTimeout(this.intervalId)
      this.intervalId = null
    }
    // Only close the context if we created it (not when using shared RX context)
    if (this.ownedContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch((error) => {
        console.warn('[RemoteAudioAnalyzer] Failed to close audio context:', error)
      })
    }
  }
}
