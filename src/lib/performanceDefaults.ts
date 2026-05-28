/** Default Cordia performance constants — one production path, no user-facing modes. */

export const TRANSFER_UI_UPDATE_MS = 250
export const TRANSFER_DEBUG_UI_UPDATE_MS = 1000

/** Keep existing parallel download cap until evidence suggests lowering. */
export const MAX_PARALLEL_DOWNLOADS = 2
/** Upload sessions already serialized in context; cap reserved for future queue tuning. */
export const MAX_PARALLEL_UPLOADS = 2

/** Chat timeline inline video — do not prefetch bytes until user interacts. */
export const CHAT_INLINE_VIDEO_PRELOAD = 'none' as const

/** Dev-only diagnostics (not product settings). */
export const DEV_DISABLE_INLINE_VIDEO = false
export const DEV_TRANSFER_THROTTLE_MS = TRANSFER_UI_UPDATE_MS
export const DEV_FORCE_SMALL_THUMBNAILS = false
