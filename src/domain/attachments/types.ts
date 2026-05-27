import type { WaveformPeaksPayload } from '../content/types'

export interface EphemeralAttachmentMeta {
  attachment_id: string
  file_name: string
  extension: string
  size_bytes: number
  sha256: string
  spoiler?: boolean
  /** Optional aspect ratio from sender so shimmer/container can match on first paint. */
  aspect_ratio_w?: number
  aspect_ratio_h?: number
  /** Local path for preview while bundling (before SHA/registration completes). Sender-only. */
  preview_path?: string
  /** When set (audio attachments from Cordia prep), waveform UI uses this instead of Web Audio decode. */
  waveform_peaks?: WaveformPeaksPayload
  /** ffprobe duration from prep; chat can show clocks without loading `<audio>` metadata. */
  audio_duration_secs?: number
  /** Embedded album art from prep (data URL); sent with the message so receivers can show it without local FFmpeg. */
  music_cover_data_url?: string
}

export type AttachmentRef = {
  id: string
  messageId: string
  contentId?: string
  fileName: string
  extension: string
  sizeBytes: number
  spoiler?: boolean
  order: number
  aspectW?: number
  aspectH?: number
  audioDurationSecs?: number
}
