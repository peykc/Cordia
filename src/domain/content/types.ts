/** Precomputed in native attachment prep (FFmpeg); travels with the message so clients skip decoding audio for the canvas. */
export type WaveformPeaksPayload = {
  top: number[]
  bottom: number[]
}

export type ContentAvailability = 'local' | 'cached' | 'missing' | 'unknown'

export type ContentRecord = {
  id: string
  sizeBytes: number
  mediaKind: 'image' | 'video' | 'audio' | 'file'
  extension: string
  localPath?: string
  cachedPath?: string
  thumbnailPaths?: {
    small?: string
    medium?: string
    large?: string
  }
  waveformPeaks?: WaveformPeaksPayload
  audioDurationSecs?: number
  musicCoverPath?: string
}
