import type { ContentAvailability } from './types'

export type ContentPathResolution = {
  openablePath?: string
  previewPath?: string
  thumbnailPath?: string
  folderPath?: string
  isAccessible: boolean
  availability: ContentAvailability
}

export function selectContentAvailability({
  localPath,
  cachedPath,
  knownMissing = false,
}: {
  localPath?: string | null
  cachedPath?: string | null
  knownMissing?: boolean
}): ContentAvailability {
  if (localPath?.trim()) return 'local'
  if (cachedPath?.trim()) return 'cached'
  if (knownMissing) return 'missing'
  return 'unknown'
}

export function resolveContentPaths({
  localPath,
  cachedPath,
  previewPath,
  thumbnailPath,
  knownMissing = false,
}: {
  localPath?: string | null
  cachedPath?: string | null
  previewPath?: string | null
  thumbnailPath?: string | null
  knownMissing?: boolean
}): ContentPathResolution {
  const openablePath = localPath?.trim() || cachedPath?.trim() || undefined
  const resolvedPreviewPath = previewPath?.trim() || openablePath
  const resolvedThumbnailPath = thumbnailPath?.trim() || undefined
  return {
    openablePath,
    previewPath: resolvedPreviewPath,
    thumbnailPath: resolvedThumbnailPath,
    folderPath: openablePath,
    isAccessible: !!openablePath && !knownMissing,
    availability: selectContentAvailability({ localPath, cachedPath, knownMissing }),
  }
}
