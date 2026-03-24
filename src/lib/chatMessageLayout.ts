/**
 * Shared layout constants and helpers for chat message attachments.
 * Single place for max dimensions and aspect math so media/shimmer sizing
 * stays consistent (mixed single, single-attachment block, etc.).
 */

export const CHAT_MEDIA_MAX_W = 520
export const CHAT_MEDIA_MAX_H = 240
export const CHAT_MEDIA_MIN_W = 120
export const CHAT_MEDIA_MIN_H = 90

/** Max dimensions for single attachments to match the 3-col grid (32rem) */
export const CHAT_MEDIA_GRID_MAX_W = 512
export const CHAT_MEDIA_GRID_MAX_H = 288

export type Aspect = { w: number; h: number }

/**
 * Compute width/height for a single attachment container so it fits within
 * maxW×maxH while preserving aspect ratio. Same logic for mixed single and
 * single-attachment block.
 */
export function getSingleAttachmentSize(
  aspect: Aspect,
  maxW: number = CHAT_MEDIA_MAX_W,
  maxH: number = CHAT_MEDIA_MAX_H
): { w: number; h: number } {
  const w = Math.min(maxW, (maxH * aspect.w) / aspect.h)
  const h = Math.min(maxH, (maxW * aspect.h) / aspect.w)
  return { w, h }
}

export function getSingleAttachmentAspectRatio(aspect: Aspect): string {
  return `${aspect.w}/${aspect.h}`
}
